export interface RetryOptions {
	maxRetries?: number;
	maxRetryDelayMs?: number;
	baseDelayMs?: number;
	signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const MAX_DELAY_MS = 8000;

function statusOf(error: unknown): number | undefined {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === "number" ? status : undefined;
}

function headersOf(error: unknown): Headers | undefined {
	const headers = (error as { headers?: unknown } | null)?.headers;
	return headers instanceof Headers ? headers : undefined;
}

function retryable(error: unknown): boolean {
	const status = statusOf(error);
	if (status !== undefined) return RETRYABLE_STATUS.has(status);
	return error instanceof TypeError;
}

function abortError(): Error {
	const error = new Error("Request was aborted");
	error.name = "AbortError";
	return error;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(abortError());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, Math.max(0, ms));
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function requestedDelay(error: unknown, maxRetryDelayMs: number): number | undefined {
	const headers = headersOf(error);
	const millisHeader = headers?.get("retry-after-ms");
	if (millisHeader) {
		const millis = Number.parseFloat(millisHeader);
		if (Number.isFinite(millis)) return checkCap(millis, maxRetryDelayMs);
	}
	const header = headers?.get("retry-after");
	if (header) {
		const seconds = Number.parseFloat(header);
		const millis = Number.isNaN(seconds) ? Date.parse(header) - Date.now() : seconds * 1000;
		if (Number.isFinite(millis)) return checkCap(millis, maxRetryDelayMs);
	}
	return undefined;
}

function checkCap(delayMs: number, maxRetryDelayMs: number): number {
	if (maxRetryDelayMs > 0 && delayMs > maxRetryDelayMs) {
		throw new Error(`Server asked to wait ${Math.ceil(delayMs / 1000)}s, more than the ${Math.ceil(maxRetryDelayMs / 1000)}s cap.`);
	}
	return delayMs;
}

/** Bounded retries for provider requests: transient statuses and network failures only, never an abort. */
export async function retryRequest<T>(request: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
	const maxRetries = options.maxRetries ?? 0;
	const maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
	const baseDelayMs = options.baseDelayMs ?? 500;

	for (let attempt = 0; ; attempt += 1) {
		try {
			return await request();
		} catch (error) {
			if (options.signal?.aborted) throw abortError();
			if (attempt >= maxRetries || !retryable(error)) throw error;
			const requested = requestedDelay(error, maxRetryDelayMs);
			const backoff = Math.min(baseDelayMs * 2 ** attempt, MAX_DELAY_MS) * (1 - Math.random() * 0.25);
			await sleep(requested ?? backoff, options.signal);
		}
	}
}

/** A message that carries the reason fetch hid inside `cause`. */
export function errorText(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = error.cause instanceof Error ? error.cause.message : "";
	if (!cause || error.message.includes(cause)) return error.message;
	return `${error.message}: ${cause}`;
}

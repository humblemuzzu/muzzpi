import { FALLBACK_PROJECT, LOAD_CODE_ASSIST_URL, QUOTA_URL, USER_AGENT } from "./wire";

export interface QuotaBucket {
	bucketId: string;
	displayName: string;
	window: string;
	resetTime: string;
	remainingFraction: number;
}

export interface QuotaGroup {
	displayName: string;
	description?: string;
	buckets: QuotaBucket[];
}

export interface QuotaSummary {
	groups: QuotaGroup[];
	description?: string;
}

async function post(access: string, url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
	const response = await fetch(url, {
		method: "POST",
		headers: { authorization: `Bearer ${access}`, "content-type": "application/json", "user-agent": USER_AGENT },
		body: JSON.stringify(body),
		signal,
	});
	const text = await response.text();
	if (!response.ok) {
		const method = url.slice(url.lastIndexOf(":") + 1);
		throw new Error(`Antigravity ${method} failed (${response.status}): ${text.slice(0, 300)}`);
	}
	if (!text) return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`Antigravity ${url} returned invalid JSON`);
	}
}

let cachedProject: string | undefined;

export async function projectFor(access: string, signal?: AbortSignal): Promise<string> {
	if (cachedProject) return cachedProject;
	try {
		const response = (await post(access, LOAD_CODE_ASSIST_URL, {}, signal)) as { cloudaicompanionProject?: unknown };
		const project =
			typeof response.cloudaicompanionProject === "string" && response.cloudaicompanionProject
				? response.cloudaicompanionProject
				: FALLBACK_PROJECT;
		cachedProject = project;
		return project;
	} catch (error) {
		if (signal?.aborted) throw error;
		return FALLBACK_PROJECT;
	}
}

export function resetProject(): void {
	cachedProject = undefined;
}

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function string(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function parseQuotaSummary(value: unknown): QuotaSummary {
	const source = (value ?? {}) as { groups?: unknown; description?: unknown };
	const groups = Array.isArray(source.groups) ? source.groups : [];
	return {
		groups: groups.map((raw) => {
			const group = (raw ?? {}) as { displayName?: unknown; description?: unknown; buckets?: unknown };
			const buckets = Array.isArray(group.buckets) ? group.buckets : [];
			return {
				displayName: string(group.displayName),
				...(typeof group.description === "string" ? { description: group.description } : {}),
				buckets: buckets.map((rawBucket) => {
					const bucket = (rawBucket ?? {}) as Record<string, unknown>;
					return {
						bucketId: string(bucket.bucketId),
						displayName: string(bucket.displayName),
						window: string(bucket.window),
						resetTime: string(bucket.resetTime),
						remainingFraction: number(bucket.remainingFraction),
					};
				}),
			};
		}),
		...(typeof source.description === "string" ? { description: source.description } : {}),
	};
}

export async function fetchQuota(access: string, signal?: AbortSignal): Promise<QuotaSummary> {
	const project = await projectFor(access, signal);
	return parseQuotaSummary(await post(access, QUOTA_URL, { project }, signal));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatResetTime(iso: string): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return "unknown";
	const day = String(at.getUTCDate()).padStart(2, "0");
	const hours = String(at.getUTCHours()).padStart(2, "0");
	const minutes = String(at.getUTCMinutes()).padStart(2, "0");
	return `${MONTHS[at.getUTCMonth()]} ${day} ${hours}:${minutes}Z`;
}

function percent(fraction: number): string {
	const clamped = Math.min(1, Math.max(0, fraction));
	return `${Math.round(clamped * 100)}%`;
}

export function formatQuota(summary: QuotaSummary): string {
	if (summary.groups.length === 0) return "Antigravity reported no quota groups.";
	return summary.groups
		.map((group) => {
			const buckets = group.buckets.map(
				(bucket) => `${bucket.window || bucket.bucketId} ${percent(bucket.remainingFraction)} (resets ${formatResetTime(bucket.resetTime)})`,
			);
			return buckets.length > 0 ? `${group.displayName}: ${buckets.join(" · ")}` : group.displayName;
		})
		.join("\n");
}

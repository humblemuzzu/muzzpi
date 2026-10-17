import { appendFileSync } from "node:fs";

/** Sends every tool non-strict, whatever pi or an extension declared, and logs what went out. */
export default function noStrict(pi: any) {
	pi.on("before_provider_request", (event: any) => {
		const payload = event.payload;
		if (!payload || !Array.isArray(payload.tools)) return undefined;
		const tools = payload.tools.map((tool: any) => {
			const { strict: _strict, ...rest } = tool ?? {};
			if (rest.function) {
				const { strict: _inner, ...fn } = rest.function;
				rest.function = fn;
			}
			return rest;
		});
		const log = process.env.STRICT_AB_LOG;
		if (log) {
			try {
				appendFileSync(log, `${JSON.stringify(tools.map((t: any) => [t.name ?? t.function?.name, false]))}\n`);
			} catch {}
		}
		return { ...payload, tools };
	});
}

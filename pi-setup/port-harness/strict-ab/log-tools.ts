import { appendFileSync } from "node:fs";

/** Appends, per request, each tool's name and whether it went out strict. Changes nothing. */
export default function logTools(pi: any) {
	pi.on("before_provider_request", (event: any) => {
		const log = process.env.STRICT_AB_LOG;
		const tools = event.payload?.tools;
		if (log && Array.isArray(tools)) {
			try {
				appendFileSync(log, `${JSON.stringify(tools.map((t: any) => [t.name ?? t.function?.name, t.strict === true || t.function?.strict === true]))}\n`);
			} catch {}
		}
		return undefined;
	});
}

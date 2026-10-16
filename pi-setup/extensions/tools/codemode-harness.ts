import { join } from "node:path";

const { executeCodemode } = await import(
	join(import.meta.dir, "node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/execute.js")
);

const WORKER_LIMIT = "Codemode worker limit reached";
const ADMISSION_WAIT_MS = 5000;

// pi admits at most two live codemode workers per process and counts a worker until it has
// actually exited, which on Bun can trail its result; back-to-back scripts must wait for a slot.
export async function runCodemode(ctx: unknown, code: string): Promise<{ text: string; isError: boolean }> {
	const deadline = Date.now() + ADMISSION_WAIT_MS;
	for (;;) {
		const r = await executeCodemode("cm", { code }, undefined, undefined, ctx);
		const text = r.content.map((c: any) => c.text).join("");
		if (!text.includes(WORKER_LIMIT) || Date.now() > deadline) return { text, isError: r.isError === true };
		await Bun.sleep(25);
	}
}

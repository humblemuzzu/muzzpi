import * as fs from "node:fs";
import { createEditTool } from "../edit-write";
import { withProcessLock } from "./file-lock";

const [mode, file, name, count] = process.argv.slice(2);
const times = Number(count);

if (mode === "counter") {
	for (let i = 0; i < times; i++) {
		await withProcessLock(file!, async () => {
			const n = Number(fs.readFileSync(file!, "utf8"));
			await new Promise((resolve) => setTimeout(resolve, 1));
			fs.writeFileSync(file!, String(n + 1));
		});
	}
} else {
	const edit = createEditTool() as any;
	const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => `lock-worker-${name}` } };
	for (let i = 0; i < times; i++) {
		const input = edit.prepareArguments({ path: file, edits: [{ oldText: "// END", newText: `${name}-${i}\n// END` }] });
		await edit.execute(`${name}-${i}`, input, undefined, undefined, ctx);
	}
}

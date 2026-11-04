import * as fs from "node:fs";
import { createEditTool } from "../edit-write";
import { withProcessLock } from "./file-lock";
import { markSeen } from "./seen-files";

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
	const session = `lock-worker-${name}`;
	const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => session } };
	for (let i = 0; i < times; i++) {
		const input = edit.prepareArguments({ path: file, edits: [{ oldText: "// END", newText: `${name}-${i}\n// END` }] });
		for (;;) {
			try {
				await edit.execute(`${name}-${i}`, input, undefined, undefined, ctx);
				break;
			} catch (error) {
				if (!String((error as Error).message).includes("Read it again")) throw error;
				markSeen(session, file!);
			}
		}
	}
}

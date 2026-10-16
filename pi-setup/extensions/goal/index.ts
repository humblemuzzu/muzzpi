/** /goal, vendored from pi-codex-goal 0.6.1 (MIT, see LICENSE). */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerGoalRuntimeController } from "./src/goal-runtime-controller.ts";

const CREATE_GOAL_PROMPT = join(dirname(fileURLToPath(import.meta.url)), "create-goal.md");

export default function (pi: ExtensionAPI): void {
	registerGoalRuntimeController(pi);
	pi.on("resources_discover", () => ({ promptPaths: [CREATE_GOAL_PROMPT] }));
}

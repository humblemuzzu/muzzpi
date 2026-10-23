/** /goal, vendored from pi-codex-goal 0.6.1 (MIT, see LICENSE). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { fillGoalTemplate } from "./src/commands.ts";
import { registerGoalRuntimeController } from "./src/goal-runtime-controller.ts";

const STRICT_GOAL_TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "create-goal.md");

export default function (pi: ExtensionAPI): void {
	registerGoalRuntimeController(pi, (task) => fillGoalTemplate(readFileSync(STRICT_GOAL_TEMPLATE, "utf8"), task));
}

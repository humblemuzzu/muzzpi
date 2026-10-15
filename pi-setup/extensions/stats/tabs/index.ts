import { agentsTab } from "./agents";
import { cacheTab } from "./cache";
import type { Tab } from "./common";
import { modelsTab } from "./models";
import { overview } from "./overview";
import { projectsTab } from "./projects";
import { rhythmTab } from "./rhythm";
import { toolsTab } from "./tools";
import { wrappedTab } from "./wrapped";

export type { Tab };
export const TABS: Tab[] = [overview, modelsTab, cacheTab, toolsTab, agentsTab, projectsTab, rhythmTab, wrappedTab];

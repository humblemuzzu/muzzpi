/**
 * agent mention sources — @oracle, @finder, @codereview, @task.
 *
 * standalone mentions (no /value) that inject a directive telling the
 * model to call a specific subagent tool. resolves immediately — the
 * agent always "exists", no lookup needed.
 *
 * registered at module load time, same pattern as commit source in sources.ts.
 */

import {
  registerMentionSource,
  type MentionSource,
} from "./sources.js";
import type {
  AgentMentionKind,
  MentionToken,
  ResolvedAgentMentionResult,
} from "./types.js";

interface AgentDef {
  tool: string;
  description: string;
}

const agents: Record<AgentMentionKind, AgentDef> = {
  oracle: {
    tool: "oracle",
    description: "expert advisor — architecture, planning, hard bugs",
  },
  finder: {
    tool: "finder",
    description: "codebase search by concept or behavior",
  },
  codereview: {
    tool: "review_code",
    description: "code review with diff analysis",
  },
  task: {
    tool: "delegate",
    description: "full subagent for independent parallel work (resumable)",
  },
  chad: {
    tool: "chad",
    description: "read-only deep research subagent — built to swarm",
  },
};

function createAgentSource(kind: AgentMentionKind): MentionSource {
  const def = agents[kind];
  return {
    kind,
    description: def.description,
    standalone: true,
    getSuggestions() {
      return [];
    },
    resolve(token: MentionToken): ResolvedAgentMentionResult {
      return {
        token,
        status: "resolved",
        kind,
        agent: { tool: def.tool, description: def.description },
      };
    },
  };
}

for (const kind of Object.keys(agents) as AgentMentionKind[]) {
  registerMentionSource(createAgentSource(kind));
}

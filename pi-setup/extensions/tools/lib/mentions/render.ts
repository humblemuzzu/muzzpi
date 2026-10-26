import type {
  ResolvedAgentMentionResult,
  ResolvedMention,
} from "./types.js";

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function quote(value: string): string {
  return JSON.stringify(singleLine(value));
}

function renderAgentDirective(mention: ResolvedAgentMentionResult): string {
  return (
    `AGENT DIRECTIVE: Call the \`${mention.agent.tool}\` tool for this request.` +
    ` The user explicitly tagged @${mention.kind}. Do not substitute another tool.`
  );
}

function summarizeDataMention(
  mention: Extract<ResolvedMention, { status: "resolved" }>,
): string {
  if (mention.kind === "commit") {
    return [
      mention.token.raw,
      "commit",
      mention.commit.sha,
      mention.commit.committedAt,
      quote(mention.commit.subject),
    ].join("\t");
  }

  return "";
}

export function renderResolvedMentionsText(
  mentions: ResolvedMention[],
): string {
  const resolved = mentions.filter(
    (m): m is Extract<ResolvedMention, { status: "resolved" }> =>
      m.status === "resolved",
  );
  if (resolved.length === 0) return "";

  const agents = resolved.filter(
    (m): m is ResolvedAgentMentionResult => "agent" in m,
  );
  const data = resolved.filter((m) => !("agent" in m));

  const parts: string[] = [];

  if (agents.length > 0) {
    parts.push(agents.map(renderAgentDirective).join("\n"));
  }

  if (data.length > 0) {
    parts.push(
      `resolved mention context:\n${data.map(summarizeDataMention).join("\n")}`,
    );
  }

  return parts.join("\n\n");
}

export function renderResolvedMentionsBlock(
  mentions: ResolvedMention[],
): string {
  const text = renderResolvedMentionsText(mentions);
  if (!text) return "";
  return `<!-- pi-mentions\n${text}\n-->`;
}

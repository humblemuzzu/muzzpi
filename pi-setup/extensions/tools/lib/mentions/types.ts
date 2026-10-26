export type AgentMentionKind = "oracle" | "finder" | "codereview" | "task" | "chad";

export type MentionKind =
  | "commit"
  | AgentMentionKind;

export interface MentionToken {
  kind: MentionKind;
  raw: string;
  value: string;
  start: number;
  end: number;
}

export interface MentionPrefix {
  raw: string;
  start: number;
  end: number;
  familyQuery: string;
  kind: MentionKind | null;
  valueQuery: string;
  hasSlash: boolean;
}

export interface ResolvedCommitMention {
  sha: string;
  shortSha: string;
  subject: string;
  committedAt: string;
}

export interface ResolvedAgentMention {
  tool: string;
  description: string;
}

export interface ResolvedCommitMentionResult {
  token: MentionToken;
  status: "resolved";
  kind: "commit";
  commit: ResolvedCommitMention;
}

export interface ResolvedAgentMentionResult {
  token: MentionToken;
  status: "resolved";
  kind: AgentMentionKind;
  agent: ResolvedAgentMention;
}

export interface UnresolvedMentionResult {
  token: MentionToken;
  status: "unresolved";
  reason: string;
}

export type ResolvedMention =
  | ResolvedCommitMentionResult
  | ResolvedAgentMentionResult
  | UnresolvedMentionResult;

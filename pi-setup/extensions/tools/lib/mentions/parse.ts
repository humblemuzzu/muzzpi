import {
  isMentionKind,
  isStandaloneKind,
  listMentionKinds,
} from "./sources.js";
import type { MentionPrefix, MentionToken } from "./types.js";

const PREFIX_RE = /(?:^|[\s([{"'])@([A-Za-z-]*)?(?:\/([A-Za-z0-9._-]*))?$/;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** @kind/value pattern for data mentions (@commit/sha) */
function getDataTokenRegex(): RegExp | null {
  const kinds = listMentionKinds().filter((k) => !isStandaloneKind(k));
  if (kinds.length === 0) return null;
  const pattern = kinds.map(escapeRegex).join("|");
  return new RegExp(
    String.raw`(?<![\w/])@(${pattern})/([A-Za-z0-9][A-Za-z0-9._-]*)`,
    "g",
  );
}

/** @kind pattern for standalone mentions (oracle, finder, etc.) */
function getStandaloneTokenRegex(): RegExp | null {
  const kinds = listMentionKinds().filter((k) => isStandaloneKind(k));
  if (kinds.length === 0) return null;
  const pattern = kinds.map(escapeRegex).join("|");
  return new RegExp(
    String.raw`(?<![\w/])@(${pattern})(?=[\s.,;:!?)\]}]|$)`,
    "g",
  );
}

export function parseMentions(text: string): MentionToken[] {
  const mentions: MentionToken[] = [];

  const dataRe = getDataTokenRegex();
  if (dataRe) {
    for (const match of text.matchAll(dataRe)) {
      const kind = match[1];
      const value = match[2];
      const start = match.index ?? -1;
      if (!kind || !isMentionKind(kind) || value === undefined || start < 0)
        continue;
      mentions.push({
        kind,
        raw: match[0],
        value,
        start,
        end: start + match[0].length,
      });
    }
  }

  const standaloneRe = getStandaloneTokenRegex();
  if (standaloneRe) {
    for (const match of text.matchAll(standaloneRe)) {
      const kind = match[1];
      const start = match.index ?? -1;
      if (!kind || !isMentionKind(kind) || start < 0) continue;
      mentions.push({
        kind,
        raw: match[0],
        value: "",
        start,
        end: start + match[0].length,
      });
    }
  }

  mentions.sort((a, b) => a.start - b.start);
  return mentions;
}

export function detectMentionPrefix(
  text: string,
  cursor: number = text.length,
): MentionPrefix | null {
  const head = text.slice(0, cursor);
  const match = head.match(PREFIX_RE);
  if (!match) return null;

  const raw = match[0].trimStart();
  const atIndex = head.lastIndexOf("@");
  if (atIndex < 0) return null;

  const familyQuery = match[1] ?? "";
  const valueQuery = match[2] ?? "";
  const kind = isMentionKind(familyQuery) ? familyQuery : null;

  return {
    raw,
    start: atIndex,
    end: cursor,
    familyQuery,
    kind,
    valueQuery,
    hasSlash: raw.includes("/"),
  };
}

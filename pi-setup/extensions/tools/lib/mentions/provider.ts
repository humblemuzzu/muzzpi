import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@mariozechner/pi-tui";
import { resolveGitRoot } from "./commit-index.js";
import { detectMentionPrefix } from "./parse.js";
import {
  getMentionKindDescription,
  getMentionSource,
  isStandaloneKind,
  listEnabledMentionKinds,
  type MentionSourceContext,
} from "./sources.js";
import type { MentionKind } from "./types.js";

export interface MentionAwareProviderOptions {
  baseProvider: AutocompleteProvider;
  cwd: string;
  maxItems?: number;
}

export class MentionAwareProvider implements AutocompleteProvider {
  private readonly baseProvider: AutocompleteProvider;
  private readonly cwd: string;
  private readonly maxItems: number;
  private readonly specialItems = new WeakSet<AutocompleteItem>();
  private readonly gitEnabled: boolean;

  constructor(options: MentionAwareProviderOptions) {
    this.baseProvider = options.baseProvider;
    this.cwd = options.cwd;
    this.maxItems = options.maxItems ?? 25;
    this.gitEnabled = resolveGitRoot(this.cwd) !== null;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const line = lines[cursorLine] ?? "";
    const prefix = detectMentionPrefix(line, cursorCol);
    const base = await this.baseProvider.getSuggestions(
      lines,
      cursorLine,
      cursorCol,
      options,
    );

    if (!prefix) return base;

    if (prefix.kind) {
      // standalone kinds (@oracle, @finder) have no sub-values
      if (isStandaloneKind(prefix.kind)) return base;
      return {
        items: this.getValueSuggestions(prefix.kind, prefix.valueQuery),
        prefix: prefix.raw,
      };
    }

    if (prefix.hasSlash) return base;

    const special = this.getKindSuggestions(prefix.familyQuery);
    if (special.length === 0) return base;
    if (!base || base.prefix !== prefix.raw) {
      return { items: special, prefix: prefix.raw };
    }

    // when user types just "@" (no query): files first, kinds after — files
    // are the primary expectation. when filtering ("@or"): kinds first since
    // they're explicit matches the user is targeting.
    const merged =
      prefix.familyQuery.length === 0
        ? [...base.items, ...special]
        : [...special, ...base.items];

    return {
      items: dedupeAutocompleteItems(merged).slice(0, this.maxItems),
      prefix: prefix.raw,
    };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
  } {
    if (!this.specialItems.has(item)) {
      return this.baseProvider.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        item,
        prefix,
      );
    }

    const line = lines[cursorLine] ?? "";
    const start = Math.max(0, cursorCol - prefix.length);
    const nextLine = line.slice(0, start) + item.value + line.slice(cursorCol);
    const nextLines = [...lines];
    nextLines[cursorLine] = nextLine;

    return {
      lines: nextLines,
      cursorLine,
      cursorCol: start + item.value.length,
    };
  }

  private getKindSuggestions(query: string): AutocompleteItem[] {
    return this.getEnabledKinds()
      .filter((kind) => kind.startsWith(query.toLowerCase()))
      .map((kind) => {
        const sa = isStandaloneKind(kind);
        return this.trackItem({
          value: sa ? `@${kind} ` : `@${kind}/`,
          label: sa ? `@${kind}` : `@${kind}/`,
          description: getMentionKindDescription(kind),
        });
      })
      .slice(0, this.maxItems);
  }

  private getValueSuggestions(
    kind: MentionKind,
    query: string,
  ): AutocompleteItem[] {
    const source = getMentionSource(kind);
    if (!source) return [];
    if (!(source.isEnabled?.(this.getSourceContext()) ?? true)) return [];

    return source
      .getSuggestions(query, this.getSourceContext())
      .slice(0, this.maxItems)
      .map((item) => this.trackItem(item));
  }

  private getEnabledKinds(): MentionKind[] {
    return listEnabledMentionKinds(this.getSourceContext());
  }

  private getSourceContext(): MentionSourceContext {
    return {
      cwd: this.cwd,
      gitEnabled: this.gitEnabled,
    };
  }

  private trackItem(item: AutocompleteItem): AutocompleteItem {
    this.specialItems.add(item);
    return item;
  }
}

function dedupeAutocompleteItems(
  items: AutocompleteItem[],
): AutocompleteItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.value}\u0000${item.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeWhitespaceLower(text) {
    return text.toLowerCase().replace(/\s+/g, " ").trim();
}
function getSessionSearchText(session) {
    return `${session.id} ${session.name ?? ""} ${session.allMessagesText} ${session.cwd}`;
}
// --- LOCAL PATCH: fast /resume search (see pi-setup/pi-core-patches) ---
// A session's search text does not change while the list is open: it is built
// and lowercased once, not for every session on every keystroke.
const searchTexts = new WeakMap();
function getSearchTexts(session) {
    let texts = searchTexts.get(session);
    if (!texts) {
        const text = getSessionSearchText(session);
        texts = { text, lower: text.toLowerCase(), normalized: null };
        searchTexts.set(session, texts);
    }
    return texts;
}
/** pi-tui's fuzzyMatch, given text that is already lowercase. */
function fuzzyMatchLower(query, textLower) {
    const queryLower = query.toLowerCase();
    const matchQuery = (normalizedQuery) => {
        if (normalizedQuery.length === 0) {
            return { matches: true, score: 0 };
        }
        if (normalizedQuery.length > textLower.length) {
            return { matches: false, score: 0 };
        }
        let queryIndex = 0;
        let score = 0;
        let lastMatchIndex = -1;
        let consecutiveMatches = 0;
        while (queryIndex < normalizedQuery.length) {
            const i = textLower.indexOf(normalizedQuery[queryIndex], lastMatchIndex + 1);
            if (i === -1)
                break;
            const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1]);
            if (lastMatchIndex === i - 1) {
                consecutiveMatches++;
                score -= consecutiveMatches * 5;
            }
            else {
                consecutiveMatches = 0;
                if (lastMatchIndex >= 0) {
                    score += (i - lastMatchIndex - 1) * 2;
                }
            }
            if (isWordBoundary) {
                score -= 10;
            }
            score += i * 0.1;
            lastMatchIndex = i;
            queryIndex++;
        }
        if (queryIndex < normalizedQuery.length) {
            return { matches: false, score: 0 };
        }
        if (normalizedQuery === textLower) {
            score -= 100;
        }
        return { matches: true, score };
    };
    const primaryMatch = matchQuery(queryLower);
    if (primaryMatch.matches) {
        return primaryMatch;
    }
    const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
    const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
    const swappedQuery = alphaNumericMatch
        ? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
        : numericAlphaMatch
            ? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
            : "";
    if (!swappedQuery) {
        return primaryMatch;
    }
    const swappedMatch = matchQuery(swappedQuery);
    if (!swappedMatch.matches) {
        return primaryMatch;
    }
    return { matches: true, score: swappedMatch.score + 5 };
}
// --- END LOCAL PATCH ---
export function hasSessionName(session) {
    return Boolean(session.name?.trim());
}
function matchesNameFilter(session, filter) {
    if (filter === "all")
        return true;
    return hasSessionName(session);
}
export function parseSearchQuery(query) {
    const trimmed = query.trim();
    if (!trimmed) {
        return { mode: "tokens", tokens: [], regex: null };
    }
    // Regex mode: re:<pattern>
    if (trimmed.startsWith("re:")) {
        const pattern = trimmed.slice(3).trim();
        if (!pattern) {
            return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
        }
        try {
            return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { mode: "regex", tokens: [], regex: null, error: msg };
        }
    }
    // Token mode with quote support.
    // Example: foo "node cve" bar
    const tokens = [];
    let buf = "";
    let inQuote = false;
    let hadUnclosedQuote = false;
    const flush = (kind) => {
        const v = buf.trim();
        buf = "";
        if (!v)
            return;
        tokens.push({ kind, value: v });
    };
    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (ch === '"') {
            if (inQuote) {
                flush("phrase");
                inQuote = false;
            }
            else {
                flush("fuzzy");
                inQuote = true;
            }
            continue;
        }
        if (!inQuote && /\s/.test(ch)) {
            flush("fuzzy");
            continue;
        }
        buf += ch;
    }
    if (inQuote) {
        hadUnclosedQuote = true;
    }
    // If quotes were unbalanced, fall back to plain whitespace tokenization.
    if (hadUnclosedQuote) {
        return {
            mode: "tokens",
            tokens: trimmed
                .split(/\s+/)
                .map((t) => t.trim())
                .filter((t) => t.length > 0)
                .map((t) => ({ kind: "fuzzy", value: t })),
            regex: null,
        };
    }
    flush(inQuote ? "phrase" : "fuzzy");
    return { mode: "tokens", tokens, regex: null };
}
export function matchSession(session, parsed) {
    const texts = getSearchTexts(session);
    const text = texts.text;
    if (parsed.mode === "regex") {
        if (!parsed.regex) {
            return { matches: false, score: 0 };
        }
        const idx = text.search(parsed.regex);
        if (idx < 0)
            return { matches: false, score: 0 };
        return { matches: true, score: idx * 0.1 };
    }
    if (parsed.tokens.length === 0) {
        return { matches: true, score: 0 };
    }
    let totalScore = 0;
    let normalizedText = null;
    for (const token of parsed.tokens) {
        if (token.kind === "phrase") {
            if (normalizedText === null) {
                normalizedText = texts.normalized ??= texts.lower.replace(/\s+/g, " ").trim();
            }
            const phrase = normalizeWhitespaceLower(token.value);
            if (!phrase)
                continue;
            const idx = normalizedText.indexOf(phrase);
            if (idx < 0)
                return { matches: false, score: 0 };
            totalScore += idx * 0.1;
            continue;
        }
        const m = fuzzyMatchLower(token.value, texts.lower);
        if (!m.matches)
            return { matches: false, score: 0 };
        totalScore += m.score;
    }
    return { matches: true, score: totalScore };
}
export function filterAndSortSessions(sessions, query, sortMode, nameFilter = "all") {
    const nameFiltered = nameFilter === "all" ? sessions : sessions.filter((session) => matchesNameFilter(session, nameFilter));
    const trimmed = query.trim();
    if (!trimmed)
        return nameFiltered;
    const parsed = parseSearchQuery(query);
    if (parsed.error)
        return [];
    // Recent mode: filter only, keep incoming order.
    if (sortMode === "recent") {
        const filtered = [];
        for (const s of nameFiltered) {
            const res = matchSession(s, parsed);
            if (res.matches)
                filtered.push(s);
        }
        return filtered;
    }
    // Relevance mode: sort by score, tie-break by modified desc.
    const scored = [];
    for (const s of nameFiltered) {
        const res = matchSession(s, parsed);
        if (!res.matches)
            continue;
        scored.push({ session: s, score: res.score });
    }
    scored.sort((a, b) => {
        if (a.score !== b.score)
            return a.score - b.score;
        return b.session.modified.getTime() - a.session.modified.getTime();
    });
    return scored.map((r) => r.session);
}
//# sourceMappingURL=session-selector-search.js.map
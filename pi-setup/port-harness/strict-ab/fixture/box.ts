/**
 * anthropic-sub — keeps Claude-plan (OAuth) requests off extra usage and
 * explains a refusal. Touches system text only, never tools or history.
 */
export function clamp(line: string, width: number) {
	return [truncateToWidth(line, width, "…")];
}

export const LOCKED = "Vault is locked — unlock keychain or set PSST_PASSWORD";

/**
 * The providers that run a model on this Mac. Their models get a bare system
 * prompt instead of ours, no psst note, and sub-agents never follow them. AGENTS.md:
 * do not widen this gate.
 */
export function isLocalProvider(provider: string | undefined): boolean {
	return provider === "llama-local" || provider === "llama.cpp";
}

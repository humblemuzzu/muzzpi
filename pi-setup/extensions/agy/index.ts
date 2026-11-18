import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProvider } from "@earendil-works/pi-ai";
import { agyAuth } from "./auth";
import { BASE_URL, MODELS, PROVIDER_ID } from "./catalog";
import { fetchQuota, formatQuota, resetProject } from "./quota";
import { stream, streamSimple } from "./stream";
import { resetConversation } from "./wire";

export default function (pi: ExtensionAPI) {
	pi.registerProvider(
		createProvider({
			id: PROVIDER_ID,
			name: "Antigravity",
			baseUrl: BASE_URL,
			auth: agyAuth,
			models: [...MODELS],
			api: { stream, streamSimple },
		}),
	);

	pi.on("session_start", () => {
		resetConversation();
		resetProject();
	});

	pi.registerCommand("agy-quota", {
		description: "Antigravity plan quota: weekly and 5-hour buckets",
		handler: async (_args, ctx) => {
			const access = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
			if (!access) {
				ctx.ui.notify("No Antigravity login, or it could not be refreshed. Run /login agy.", "warning");
				return;
			}
			try {
				ctx.ui.notify(formatQuota(await fetchQuota(access)), "info");
			} catch (error) {
				ctx.ui.notify(`Antigravity quota unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}

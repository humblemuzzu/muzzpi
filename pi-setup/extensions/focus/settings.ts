import { prefsFile, readPrefs, writePrefs } from "../tools/lib/prefs";

export type PinMode = "working" | "always" | "off";

export interface FocusSettings {
	startInFocus: boolean;
	/** when the one-line reminder of your last prompt shows above the editor */
	pin: PinMode;
	/** list goal and /ysk prompts as turns of their own instead of inside yours */
	showInjected: boolean;
}

export const DEFAULT_SETTINGS: FocusSettings = { startInFocus: false, pin: "off", showInjected: false };

const PIN_MODES: readonly PinMode[] = ["working", "always", "off"];

export function settingsFile(): string {
	return prefsFile("focus");
}

/** each field falls back to its default on its own, so one bad value never resets the rest */
export function readSettings(file: string = settingsFile()): FocusSettings {
	const raw = readPrefs(file);
	return {
		startInFocus: typeof raw.startInFocus === "boolean" ? raw.startInFocus : DEFAULT_SETTINGS.startInFocus,
		pin: PIN_MODES.includes(raw.pin as PinMode) ? (raw.pin as PinMode) : DEFAULT_SETTINGS.pin,
		showInjected: typeof raw.showInjected === "boolean" ? raw.showInjected : DEFAULT_SETTINGS.showInjected,
	};
}

export function writeSettings(settings: FocusSettings, file: string = settingsFile()): void {
	writePrefs(file, { ...settings });
}

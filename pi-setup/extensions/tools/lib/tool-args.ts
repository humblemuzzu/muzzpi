/**
 * Arguments as models actually send them, mapped onto the schema before pi
 * validates it. pi's own validation message for a wrong enum value is "must be
 * equal to constant" and names none of the allowed values; this runs first,
 * accepts the usual other names for each parameter and value, and turns
 * whatever is still wrong into an error that lists the valid options and an
 * example call, so a model fixes its call in one step.
 */

import { stringList } from "./params";

export interface ParamSpec {
	aliases?: string[];
	/** the schema value → other spellings models use for it. Compared ignoring case, spaces, - and _. */
	values?: Record<string, string[]>;
	/** what the values mean, shown when a value is not recognised. */
	valuesHelp?: string;
	/** an array of strings: a bare string or a JSON-stringified array is accepted too. */
	list?: boolean;
	/** a number: "10" is accepted too, which pi's own validation refuses. */
	number?: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");

export function argumentPreparer(
	tool: string,
	specs: Record<string, ParamSpec>,
	example: string,
	finish?: (args: Record<string, unknown>) => Record<string, unknown>,
): (raw: unknown) => unknown {
	const nameOf = new Map<string, string>();
	for (const name of Object.keys(specs)) nameOf.set(norm(name), name);
	for (const [name, spec] of Object.entries(specs)) {
		for (const alias of spec.aliases ?? []) if (!nameOf.has(norm(alias))) nameOf.set(norm(alias), name);
	}
	const valueOf = new Map<string, Map<string, string>>();
	for (const [name, spec] of Object.entries(specs)) {
		if (!spec.values) continue;
		const map = new Map<string, string>();
		for (const [value, spellings] of Object.entries(spec.values)) {
			map.set(norm(value), value);
			for (const s of spellings) map.set(norm(s), value);
		}
		valueOf.set(name, map);
	}
	const parameterList = Object.keys(specs).join(", ");

	return (raw: unknown) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
		const entries = Object.entries(raw as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null);
		const out: Record<string, unknown> = {};
		const unknown: string[] = [];
		const canonicalFirst = [...entries].sort(([a], [b]) => Number(!(a in specs)) - Number(!(b in specs)));
		for (const [key, value] of canonicalFirst) {
			const name = nameOf.get(norm(key));
			if (!name) unknown.push(key);
			else if (!(name in out)) out[name] = value;
		}
		if (unknown.length) {
			throw new Error(
				`${tool}: unknown parameter${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")}. ` +
					`Its parameters are: ${parameterList}.\n${example}`,
			);
		}
		for (const [name, spec] of Object.entries(specs)) {
			if (!(name in out)) continue;
			if (spec.list) {
				out[name] = stringList(out[name]);
				continue;
			}
			if (spec.number) {
				const n = typeof out[name] === "string" ? Number((out[name] as string).trim()) : out[name];
				if (typeof n !== "number" || !Number.isFinite(n)) {
					throw new Error(`${tool}: ${name} must be a number, not ${JSON.stringify(out[name])}.\n${example}`);
				}
				out[name] = n;
				continue;
			}
			const values = valueOf.get(name);
			if (!values || typeof out[name] !== "string") continue;
			const value = values.get(norm(out[name] as string));
			if (!value) {
				throw new Error(
					`${tool}: ${name} "${out[name]}" is not one of its values: ${spec.valuesHelp ?? Object.keys(spec.values!).join(", ")}.\n${example}`,
				);
			}
			out[name] = value;
		}
		return finish ? finish(out) : out;
	};
}

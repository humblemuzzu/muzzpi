import { describe, expect, test } from "bun:test";
import { completeIdea, TAG_HINTS } from "./index";
import { parseInput } from "./store";

describe("tag suggestions", () => {
	test("while the leading tags are typed, keeping the ones before", () => {
		expect(completeIdea("p")).toEqual([{ value: "pi: ", label: "pi:", description: "file it under muzzpi itself, not this project" }]);
		expect(completeIdea("pi: b")?.map((i) => i.value)).toEqual(["pi: bug: "]);
		expect(completeIdea("PI: d")?.map((i) => i.value)).toEqual(["PI: dislike: "]);
	});

	test("never inside the idea, and never a tag already given", () => {
		expect(completeIdea("the dock b")).toBeNull();
		expect(completeIdea("pi: the")).toBeNull();
		expect(completeIdea("bug: b")).toBeNull();
		expect(completeIdea("")).toBeNull();
	});

	test("every suggested tag is one the parser really reads", () => {
		for (const { tag } of TAG_HINTS) {
			const parsed = parseInput(`${tag} something`);
			expect(parsed.text).toBe("something");
		}
	});
});

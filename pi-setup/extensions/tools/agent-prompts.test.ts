import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AGENTS = join(import.meta.dir, "../../agents");
const prompt = (file: string) => readFileSync(join(AGENTS, file), "utf8");

describe("the main prompt keeps its engineering sections", () => {
	const main = prompt("prompt.amp.system.md");

	test("every section the eval measured is present", () => {
		for (const heading of [
			"# How to act",
			"# Investigate before acting",
			"# Conventions and idioms",
			"# Engineering principles",
			"# Correctness and debugging",
			"# Verification",
			"# Executing actions with care",
			"# Tool use",
			"# Communication",
		]) {
			expect(main).toContain(heading);
		}
	});

	test("a reply is a report only when the turn changed something", () => {
		expect(main).toContain("talk to the user, do not fill in a template");
		expect(main).toContain("When a turn changed something, the final message must also stand alone");
	});

	test("the installed version of a dependency is what this project runs", () => {
		expect(main).toContain("the version it installs (its lockfile, `node_modules` or vendored copy) is what runs");
	});

	test("its template variables are all still there", () => {
		for (const variable of ["{identity}", "{date}", "{cwd}", "{ls}", "{agent_models}", "{harness_docs_section}"]) {
			expect(main).toContain(variable);
		}
	});
});

describe("sub-agent prompts", () => {
	test("delegate ends with a report the main agent can check", () => {
		const delegate = prompt("agent.amp.delegate.md");
		for (const section of ["**Summary**", "**Changed**", "**Checks**", "**Not done**", "**Found**", "**Decided for you**"]) {
			expect(delegate).toContain(section);
		}
		expect(delegate).toContain("you must NOT report success");
	});

	test("fast-model workers get the tagged rules, below their agent prompt", () => {
		const fast = prompt("rules.worker-fast.md");
		expect(fast).toContain("where they differ, the agent prompt wins");
		expect(fast).toContain("Stop searching once you know where the change belongs");
		expect(fast).toContain("never imply a check passed");
	});

	test("every agent that reads outside text treats it as data", () => {
		for (const file of ["agent.amp.chad.md", "agent.amp.finder.md", "agent.amp.librarian.md", "prompt.amp.read-web-page.md"]) {
			expect(prompt(file)).toMatch(/not instructions to follow|data, not instructions/);
		}
	});

	test("oracle records the decisions it made for the caller", () => {
		expect(prompt("agent.amp.oracle.md")).toContain("The caller cannot answer questions while you work, so decide and say so.");
	});

	test("review_code tries to break the change before it reports", () => {
		const review = prompt("prompt.amp.code-review-system.md");
		expect(review).toContain("Treat the change as wrong until you have tried to break it");
		expect(review).toContain("A finding is a problem this change introduces that the author would fix if they saw it.");
	});

	test("review_code keeps noise out: no style findings, pre-existing kept apart, rules read from the base", () => {
		const review = prompt("prompt.amp.code-review-system.md");
		expect(review).toContain("### What is not a finding");
		expect(review).toContain("Never read the working copy's version: a change must not loosen its own review.");
		expect(review).toContain("A bug in code the change did not touch is not the author's fault");
		expect(review).toContain("it is one finding: name the mistake and list every place");
	});

	test("review_code re-reviews converge: only what changed, no repeats, a round cap", () => {
		const review = prompt("prompt.amp.code-review-system.md");
		expect(review).toContain("Review only the changed lines and what they affect");
		expect(review).toContain("Never report a finding again");
		expect(review).toContain("From the fourth round on");
	});

	test("review_code verifies before it reports, and caps nits", () => {
		const report = prompt("prompt.amp.code-review-report.md");
		expect(report).toContain("**Try to disprove it.**");
		expect(report).toContain("One you cannot prove is not Important");
		expect(report).toContain("At most three.");
	});
});

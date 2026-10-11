// deterministic subagent tool-injection test.
// imports the LIVE pi-spawn, runs each subagent's real tool config through it
// with PI_BIN pointed at a wrapper that logs argv + injects the probe extension.
import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const TOOLS_DIR = process.env.HOME + "/.pi/agent/extensions/tools/";
const jiti = createJiti(TOOLS_DIR);
const { piSpawn } = await jiti.import("./lib/pi-spawn.ts");

// exact configs from the live subagent files
const CASES = {
  finder: {
    builtinTools: ["read", "grep", "find", "ls"],
    extensionTools: ["read", "grep", "find", "ls"],
  },
  librarian: {
    builtinTools: [],
    extensionTools: ["read_github", "search_github", "list_directory_github",
      "list_repositories", "glob_github", "commit_search", "diff"],
  },
  oracle: {
    builtinTools: ["read", "grep", "find", "ls", "bash"],
    extensionTools: ["read", "grep", "find", "ls", "bash"],
  },
  // kept in sync with delegate.ts by hand — the unit tests pin the real
  // allowlists, this harness proves the flags reach a child.
  delegate: {
    builtinTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    extensionTools: ["read", "grep", "find", "ls", "bash",
      "edit", "write", "format_file", "skill", "finder",
      "web_search", "read_web_page", "screenshot"],
  },
  chad: {
    builtinTools: ["read", "grep", "find", "ls", "bash"],
    extensionTools: ["read", "grep", "find", "ls", "bash", "skill",
      "web_search", "read_web_page", "screenshot",
      "read_github", "search_github", "list_directory_github",
      "list_repositories", "glob_github", "commit_search", "diff"],
    // chad is defined by its model and its read-only bash; a probe that
    // dropped these would pass while testing a different agent.
    pinModel: true,
    model: "xai/grok-4.6",
    thinkingLevel: "high",
    readOnlyBash: true,
  },
};

const which = process.argv[2];
const cfg = CASES[which];
if (!cfg) {
  console.error(`usage: node test-subagent-tools.mjs <${Object.keys(CASES).join("|")}>`);
  process.exit(1);
}

process.env.PI_BIN = "/tmp/pi-wrapper.sh";

const res = await piSpawn({
  cwd: process.cwd(),
  task: "Reply with exactly the word DONE and nothing else.",
  model: "claude-sonnet-5",
  parentModel: "anthropic/claude-opus-5",
  ...cfg,
});
if (cfg.pinModel) console.log(`(pinned model: ${cfg.model} @ ${cfg.thinkingLevel})`);
console.log(`\n=== ${which}: exit=${res.exitCode} ===`);
console.log("stderr (probe lines):");
for (const line of (res.stderr || "").split("\n")) {
  if (line.includes("PROBE:")) console.log("  " + line.trim());
}

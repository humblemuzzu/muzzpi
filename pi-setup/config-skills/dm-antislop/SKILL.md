---
name: dm-antislop
description: "install dmmulroy's anti-slop Oxlint plugin into a TypeScript/JavaScript repo — 15 rules rejecting chained type assertions, `unknown` in contracts, `Record<string, unknown>`, runtime `typeof` narrowing, module mocking and undocumented casts. use to add anti-slop lint rules, harden TS types against AI slop, or migrate an existing setup. WRITES to the repo, so it needs an agent that can edit."
---

# Install anti-slop

Install the bundled Oxlint plugin into the current repository and integrate it with the repository's existing lint setup. Preserve unrelated work and adapt to the project's package manager and configuration style.

## Procedure

1. Inspect the repository before changing it:
   - Read its agent instructions.
   - Check `git status` and preserve unrelated changes.
   - Identify the package manager from `packageManager` and lockfiles.
   - Find Oxlint configuration (`oxlint.config.*`, `.oxlintrc*`, or a Vite+ config).
   - Check whether anti-slop files or rules already exist. Do not overwrite them without reviewing the diff.

2. Copy the bundled plugin from this skill. Run from the target repository:

   ```bash
   node <skill-directory>/scripts/install.mjs
   ```

   `<skill-directory>` is the directory holding this SKILL.md — the skill listing gives you its absolute path. Use that path; do not guess it and do not `cd` into it, the script must run with the target repository as the working directory.

   This creates `tools/oxlint/anti-slop/`. Pass another relative destination as the first argument when the repository has an established tooling layout. The script refuses to replace an existing destination; only use `--force` after backing up and reviewing existing files.

3. Install current compatible dependencies rather than trusting versions remembered by the agent:
   - Query `npm view oxlint version` and `npm view @oxlint/plugins version`.
   - Install the same current version of both packages with the repository's package manager.
   - `oxlint` is a development dependency. The copied source imports `@oxlint/plugins`, so install it as a development dependency for a local-only plugin.
   - Do not replace the package manager or rewrite unrelated dependency ranges.

4. Register the plugin and enable all rules. For `oxlint.config.ts` or `.oxlintrc.json`, add:

   ```ts
   jsPlugins: [
     { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
   ],
   ```

   For Vite+, add that same entry to `lint.jsPlugins`. Merge it with existing entries instead of replacing them.

   Enable these rules at `"error"`:

   ```json
   {
     "anti-slop/no-chained-type-assertions": "error",
     "anti-slop/no-conditional-empty-object-spread": "error",
     "anti-slop/no-known-value-widening": "error",
     "anti-slop/no-module-mocking": "error",
     "anti-slop/no-object-parameters": "error",
     "anti-slop/no-reflect-apply": "error",
     "anti-slop/no-reflect-get": "error",
     "anti-slop/no-runtime-typeof": "error",
     "anti-slop/no-shape-in-symbol-names": "error",
     "anti-slop/no-unknown-parameters": "error",
     "anti-slop/no-unknown-returns": "error",
     "anti-slop/no-unknown-type-aliases": "error",
     "anti-slop/no-unsafe-dictionary-type": "error",
     "anti-slop/no-widen-then-assert": "error",
     "anti-slop/require-safety-comment-for-type-assertion": "error"
   }
   ```

5. Run the repository's lint command and typecheck. If findings appear, report them and fix them only when the user asked for migration/cleanup. Do not suppress rules, weaken rule severity, add unsafe casts, or mechanically launder types to make lint pass.

6. Review the final diff and clearly report:
   - copied path,
   - dependency versions installed,
   - configuration changed,
   - checks run and any remaining findings.

## Migration guidance

When replacing an older local copy, compare its rules and diagnostics before overwriting. Keep project-specific rules in their own plugin; anti-slop is intentionally generic. Prefer inference, `as const`, `satisfies`, named owner contracts, and boundary parsing when resolving findings.

## In this harness

Three local rules that override the generic instructions above where they conflict:

- **Edit the lint config with `edit`, never with bash.** No `sed -i`, no `>`/`>>` redirection, no heredoc. Step 4 says "merge, don't replace" — an `edit` with an exact `oldText`/`newText` is how you merge without clobbering; a shell rewrite is how you lose the existing `jsPlugins` entries. Shell writes also bypass undo tracking.
- **Stage explicitly.** `git add -A` and `git add .` are rejected by permission rules — name the files.
- **`npm view` fails inside a bun repo.** Step 3 queries current versions with `npm view`, which exits `EBADDEVENGINES` in any repository whose `package.json` sets `devEngines.packageManager` to bun — it refuses before it ever reaches the registry. Use `bun info oxlint version` there, or run `npm view` from a neutral directory. Both return the same number; do not fall back to a version you remember, which is the failure step 3 exists to prevent.
- **This skill needs write access.** Step 2 copies files, step 3 installs packages, step 4 edits config. Read-only sub-agents (`chad`) can *load* this skill but cannot execute it; they will hit refusals at every step. Run it as the main agent, or hand it to a `delegate`. A chad is the right tool for the *question* "would these rules flag anything in this repo?" — not for the installation.

Step 5's "do not launder types to make lint pass" is the point of the whole plugin, and it survives contact with this harness unchanged: a rule you silence taught you nothing.

## Provenance

Vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at commit `9b80d9a`, MIT (see `LICENSE` in this directory). Renamed `install-anti-slop` → `dm-antislop` under this setup's author-prefix convention for adapted external skills (`s-` shadcn, `c-` cursor, `mat-` matt pocock, `dm-` dmmulroy).

Only the frontmatter, the `<skill-directory>` note in step 2, and the "In this harness" section differ from upstream. `assets/` and `scripts/install.mjs` are byte-identical, so re-vendoring is a copy plus those three edits. Upstream treats `src/` as canonical and syncs it into the skill's `assets/`; check for drift before re-vendoring.

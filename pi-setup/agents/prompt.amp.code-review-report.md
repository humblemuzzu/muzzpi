# Phase 2: Verify, then report

## Verify

Before you write anything, put every candidate finding from your exploration through these checks, in order:

1. **Try to disprove it.** Read the code that would prevent it: guards, callers, types, tests, defaults, the library's own behaviour. Run it if it can run. If it does not happen, drop it.
2. **Is it this change's?** If it sits in code the change did not touch and the change does not make it worse, it is pre-existing.
3. **Is it a finding at all?** Drop everything on the "What is not a finding" list and everything REVIEW.md says not to report.
4. **Merge** candidates that are the same mistake in several places into one finding that lists every place.
5. **Tag** each one that survives:
   - **critical**: data loss, a security hole, or a crash in normal use.
   - **high**: wrong behaviour that users or callers hit in normal use.
   - **medium**: wrong behaviour under an edge case you can name, or a broken rule from AGENTS.md or REVIEW.md.
   - **nit**: a real mistake with no effect on behaviour that the author would still want to know about, such as a wrong user-visible string or a stale reference. At most three.
   - **pre-existing**: a proven, serious bug the change did not introduce. At most three.

   critical, high and medium are the **Important** findings: the author must fix them before the change lands. REVIEW.md can move a class of finding up or down.
6. **Prove each Important finding**: `ran <command> → <what it showed>`, or `traced <file:line> → <file:line> → …`. One you cannot prove is not Important: drop it, or, when it would be serious if real, name it in one sentence under Unverified in the Summary.

## Output

Use exactly this structure:

```markdown
# Code review

## Summary

**1 important · 0 nits · 0 pre-existing**

Two or three sentences: what the change does and whether it is safe to land.

## Important

### high · Cache key ignores the locale

- **Filename:** path/to/file.ts
- **Start line:** 42
- **End line:** 45
- **Text:** What is wrong, in one sentence.
- **Why:** The input or situation that triggers it, and what goes wrong.
- **Checked:** ran `bun test cache.test.ts` → "expected 2, got 1"
- **Fix:** The exact change to make.
```

Then `## Nits` and `## Pre-existing`, each holding its findings in the same shape. Leave out a section that has none.

## Rules

1. The Summary opens with the counts line. When nothing needs fixing, it reads `**Nothing to fix.**` and the report has no other section. Never add praise or a finding to fill the report.
2. Unverified items go in the Summary, after the counts line, one line each, `Unverified: <what and where>`, at most two.
3. Paths are relative to the repo root.
4. Line numbers: for a modified file, use the NEW version (the `+` side of `@@ -old,count +new,count @@`); for an added file, the new file; for a deleted file, use 0 for both and say in **Text** that the file was deleted.
5. Each heading is `### <tag> · <title>`, the tag one of critical, high, medium, nit or pre-existing, then the problem in a few words. Under it, write each field as its own `- **Label:** value` bullet, one per line, with the value on the same line as its label.
6. Every finding has **Checked**. A nit's may say which line you read.
7. Important findings and nits have a **Fix** with a concrete change; pre-existing ones have one when the fix is clear. When the fix needs code, describe it on the **Fix** line and put the code in a fenced block, with its language, directly below.
8. A finding that covers several places adds `- **Instances:** path:line, path:line, …` naming every one.
9. On a re-review, the Summary opens with `Round <n>.`, then the counts line, then one line per earlier Important finding: `Fixed: <title>` or `Still open: <title>`. Only new findings get sections.
10. If there was nothing to review, the Summary names the commands you ran and says they came back empty, and the report has no other section.
11. Write nothing before `# Code review` and nothing after the last finding — no closing offer or next steps.

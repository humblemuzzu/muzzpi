# Report Format Instructions

Now write your review as Markdown, in the structure below. Include every finding from your analysis.

## Severity Guide

Severity is how bad the problem is if it is real. Whether it is real goes in **Checked**.

- **critical**: Will cause data loss, security breach, or crash in production.
- **high**: Bug that will manifest under normal usage, or a security weakness.
- **medium**: Edge case bug, missing validation, or design issue that increases maintenance cost.
- **low**: Style nit, naming suggestion, minor readability improvement.

## Comment Types

- **bug**: Incorrect behavior — something is wrong and needs fixing.
- **suggested_edit**: Not broken, but could be better — refactor, rename, simplify.
- **compliment**: Good code worth acknowledging, named specifically.
- **non_actionable**: Observation or context. No change needed, but reviewer wants author to be aware.

## Output

Use exactly this structure. Order the comments by severity, critical first.

```markdown
# Code review

## Summary

Two to four sentences: what the change does and your overall assessment.

## Comments

### high · Cache key ignores the locale

- **Filename:** path/to/file.ts
- **Start line:** 42
- **End line:** 45
- **Comment type:** bug
- **Text:** What the issue is — one sentence.
- **Why:** Why this matters — impact on users, maintainability, or correctness.
- **Checked:** ran `bun test cache.test.ts` → "expected 2, got 1"
- **Fix:** The exact change to make.
```

Repeat the `###` section, heading included, for each finding.

## Rules

1. Paths are relative to the repo root.
2. Line numbers: for a modified file, use the NEW version (the `+` side of `@@ -old,count +new,count @@`); for an added file, the new file; for a deleted file, use 0 for both and say in **Text** that the file was deleted.
3. Each heading is `### <severity> · <title>`: the severity first, then the issue in a few words, so the list reads at a glance. Under it, write each field as its own `- **Label:** value` bullet, one per line, with the value on the same line as its label. The severity and **Comment type** hold one value from the lists above, nothing else.
4. Every `bug` has a **Checked** line, in one of three forms: `ran <command> → <what it showed>`, `traced <file:line> → <file:line> → …`, or `not verified`. A `not verified` bug is at most `medium`. Other comment types include **Checked** only when you verified something.
5. Every `bug` or `suggested_edit` MUST have a **Fix** with a concrete change. When the fix needs code, describe it on the **Fix** line and put the code in a fenced block, with its language, directly below. Leave out the **Fix** line for `compliment` and `non_actionable`.
6. At most one `compliment`, and only for something specific. Never pad the review with praise.
7. Do not repeat findings — one comment per issue, even if it spans multiple hunks.
8. If the diff is clean and you found nothing material, say so in the Summary and write a single `compliment` comment. Don't invent issues.
9. If there was nothing to review, the Summary names the commands you ran and says they came back empty, and `## Comments` holds only the line `No changes to review.`
10. Write nothing before `# Code review` and nothing after the last comment — no closing offer or next steps.

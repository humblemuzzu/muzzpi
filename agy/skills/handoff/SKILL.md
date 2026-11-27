---
name: handoff
description: Writes the plan agreed in this conversation to PLAN.md at the repository root and copies it to the clipboard, so another session can carry it out without this conversation. Use when the user types /handoff or asks to hand off, export, or save the plan.
---

# Hand off the plan

Turn the plan agreed in this conversation into one self-contained file that an
engineer who never saw this conversation can execute. Do not change any code,
do not commit, and do not start implementing.

## Steps

1. Take the latest plan the user agreed to: the implementation plan artifact if
   there is one, otherwise the plan from the conversation. If the user said
   something after the plan that changes it, apply that.

2. Read the files the plan touches, so every path, function name, and current
   behaviour in the file is checked, not remembered.

3. Write the plan with these sections, in this order:

   - **Goal**: what should be true when the work is done, in two or three lines.
   - **Context**: the files involved (full paths from the repo root), how they
     work today, and anything surprising found while planning.
   - **Decisions**: each choice already made, with its reason in one line, so
     the next session does not reopen it.
   - **Steps**: the changes, grouped by file, in the order to make them. Name
     functions, types, and commands exactly.
   - **Verify**: the exact commands to run and what a pass looks like, plus the
     real-world check (run the app, open the page, call the endpoint).
   - **Out of scope**: what not to touch.
   - **Open questions**: anything still undecided, with the recommended answer.

   Plain English, short lines, no filler. No sections beyond these.

4. Find the repository root with `git rev-parse --show-toplevel` (use the
   current directory if it is not a git repository). Write the file there as
   `PLAN.md`. If a `PLAN.md` already exists that this conversation did not
   write, keep it and write `PLAN-<short-topic>.md` instead.

5. Copy it to the clipboard: `pbcopy < <path to the file>`.

6. Reply with the file path, one line on what the plan does, and the number of
   steps. Nothing else.

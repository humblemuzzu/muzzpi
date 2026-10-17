# Notes

- `pi-setup/2026-05-17-migration-log.md` — v0.74.0 migration, architecture
- Blocks every way to delete — `rm`, `rmdir`, `unlink`, `shred` (use `trash` instead)
- **Needs:** macOS (built and tested there), node ≥ 22.19, and pi itself
- The 7 GitHub tools are separate (`read_github` … `diff`); there is no tool named `github`.
- `extensions/tools/package.json` → `npm outdated` there; run `bun test` before deploying.
- Keep it short: state and rules in §1–§8, and in §9 only the last 4 deploy logs.

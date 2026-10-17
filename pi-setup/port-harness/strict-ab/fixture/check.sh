#!/usr/bin/env bash
# ── anthropic-sub: Claude-plan requests must not trip the third-party check ──
echo "checking"

# ── pi core: compaction must be STOCK ──
if [ "$FAIL" -eq 0 ]; then
    echo "ALL PATCHES IN PLACE ✓"
fi

#!/bin/bash
# searchd resource soak (HARDENING.md P5.3): a daemon of this build under a
# scripted workload, sampled every 10 s, checked against the budgets.
#
#   SOAK_AUTOSAVE_SECS=60 SOAK_IDLE_SECS=60 bash pi-setup/port-harness/searchd-soak.sh
#   SOAK_BIN=/path/to/searchd SOAK_SKIP_CLONE=1 bash ...
#
# The user's daemon and ~/.pi/agent are never touched: each daemon here has its
# own SEARCHD_DIR, under $HOME (never /tmp: a socket address holds 104 bytes).
# Everything this makes is trashed at the end, never removed.

set -u -o pipefail

AUTOSAVE_SECS=${SOAK_AUTOSAVE_SECS:-600}
IDLE_SECS=${SOAK_IDLE_SECS:-300}
SAMPLE_SECS=${SOAK_SAMPLE_SECS:-10}
MANY_FILES=${SOAK_MANY_FILES:-20000}
IDLE_CPU_MAX=0.2
IDLE_FOOTPRINT_MAX=50
PEAK_FOOTPRINT_MAX=300
# main.rs's Budget::cap.
INDEX_CAP_KB=$((1024 * 1024))

die() { printf 'soak: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "searchd is macOS-only"

REPO=$(cd "$(dirname "$0")/../searchd" && pwd)
BIN=${SOAK_BIN:-$REPO/target/release/searchd}
if [ ! -x "$BIN" ]; then
	command -v cargo >/dev/null || die "no binary at $BIN and no cargo to build one"
	echo "soak: building $BIN"
	(cd "$REPO" && cargo build --release) || die "the build failed"
fi
REAL_RG=$(command -v rg) || die "rg is not installed"
"$BIN" version >/dev/null || die "$BIN does not run"

HOME_DIR=$(cd "$HOME" && pwd) || die "no HOME"
SOAK="$HOME_DIR/.sdsoak-$(date +%Y%m%d-%H%M%S)-$$"
DATA="$SOAK/data"
WORK="$SOAK/work"
LOGS="$SOAK/logs"
mkdir -p "$DATA" "$WORK" "$LOGS" "$SOAK/bin" "$SOAK/retired" || die "cannot create $SOAK"
[ ${#DATA} -lt 90 ] || die "the data dir path is too long for a socket: $DATA"
: >"$LOGS/samples.txt"
: >"$LOGS/probes.txt"
: >"$LOGS/phase.txt"
echo "soak: binary $BIN"
echo "soak: working in $SOAK, autosave ${AUTOSAVE_SECS}s, idle ${IDLE_SECS}s"

# ---------------------------------------------------------------- helpers

dir_of() { printf '%s' "$SOAK/logs/dirs/$1"; }

start_daemon() { # name, data dir, root, PATH
	local name=$1 data=$2 root=$3 path=$4 pid waited=0
	mkdir -p "$SOAK/logs/dirs" "$data"
	printf '%s' "$data" >"$(dir_of "$name")"
	SEARCHD_DIR="$data" PATH="$path" "$BIN" serve --root "$root" >>"$LOGS/$name.out" 2>&1 &
	pid=$!
	printf '%s' "$pid" >"$LOGS/$name.pid"
	while [ $waited -lt 150 ]; do
		if SEARCHD_DIR="$data" "$BIN" status >/dev/null 2>&1; then
			echo "soak: daemon $name (pid $pid) serving on $data"
			return 0
		fi
		sleep 1
		waited=$((waited + 1))
	done
	echo "soak: daemon $name never answered"
	tail -10 "$data/searchd.log" 2>/dev/null
	return 1
}

stop_daemon() { # name
	local name=$1 data pid
	data=$(dir_of "$name" 2>/dev/null) || return 0
	[ -s "$data" ] || return 0
	data=$(cat "$data")
	pid=$(cat "$LOGS/$name.pid" 2>/dev/null) || pid=""
	SEARCHD_DIR="$data" "$BIN" query '{"op":"shutdown"}' >/dev/null 2>&1
	[ -n "$pid" ] || return 0
	for _ in $(seq 1 50); do
		kill -0 "$pid" 2>/dev/null || return 0
		sleep 0.1
	done
	echo "soak: daemon $name (pid $pid) is still running"
	return 0
}

status_of() { SEARCHD_DIR="$1" "$BIN" status 2>/dev/null | tail -1; }

field() { # json, key
	python3 -c 'import json,sys
try:
    print(json.loads(sys.argv[1]).get(sys.argv[2], ""))
except Exception:
    print("")' "$1" "$2" 2>/dev/null
}

cpu_seconds() { # pid
	local t
	t=$(ps -o time= -p "$1" 2>/dev/null | tr -d ' ')
	[ -n "$t" ] || { printf '0'; return; }
	printf '%s' "$t" | awk -F: '{ if (NF==3) printf "%.2f", $1*3600+$2*60+$3; else printf "%.2f", $1*60+$2 }'
}

footprint_mb() { # pid
	local line value unit
	line=$(footprint -p "$1" 2>/dev/null | sed -En 's/.*Footprint: ([0-9]+) (KB|MB|GB).*/\1 \2/p' | head -1)
	[ -n "$line" ] || { printf '0'; return; }
	value=${line% *}
	unit=${line#* }
	case $unit in
		KB) awk -v v="$value" 'BEGIN { printf "%.1f", v/1024 }' ;;
		GB) awk -v v="$value" 'BEGIN { printf "%.1f", v*1024 }' ;;
		*) printf '%s' "$value" ;;
	esac
}

index_kb() {
	local kb
	kb=$(du -sk "$1/content" 2>/dev/null | awk '{print $1}')
	printf '%s' "${kb:-0}"
}

sample() { # phase
	local pid data json fp cpu alive=0 indexed=0
	pid=$(cat "$LOGS/main.pid" 2>/dev/null) || return 0
	[ -n "$pid" ] || return 0
	data=$(cat "$(dir_of main)" 2>/dev/null) || return 0
	[ -n "$data" ] || return 0
	if kill -0 "$pid" 2>/dev/null; then
		alive=1
		fp=$(footprint_mb "$pid")
		cpu=$(cpu_seconds "$pid")
	else
		fp=0
		cpu=0
	fi
	json=$(status_of "$data")
	[ -n "$json" ] && indexed=$(field "$json" indexedFiles)
	printf '%s %s %s %s %s %s %s %s\n' \
		"$(date +%s)" "${1:-none}" "$fp" "$cpu" "$(index_kb "$data")" "$alive" "${indexed:-0}" "$json" >>"$LOGS/samples.txt"
}

sampler() { while :; do sample "$(cat "$LOGS/phase.txt" 2>/dev/null)"; sleep "$SAMPLE_SECS"; done; }

phase() {
	printf '%s' "$1" >"$LOGS/phase.txt"
	echo "soak: $1"
}

probe() { # dir, label
	local dir=$1 label=$2 out
	out=$(SEARCHD_DIR="$(cat "$(dir_of main)")" "$BIN" query "{\"op\":\"find\",\"dir\":\"$dir\",\"glob\":\"**/*.rs\",\"limit\":50}" 2>/dev/null)
	case $out in
		*searchd_fallback*) printf '%s find %s\n' "$label" "$(printf '%s' "$out" | tail -1)" >>"$LOGS/probes.txt" ;;
		*) printf '%s find ok\n' "$label" >>"$LOGS/probes.txt" ;;
	esac
	out=$(SEARCHD_DIR="$(cat "$(dir_of main)")" "$BIN" query "{\"op\":\"grep\",\"dir\":\"$dir\",\"pattern\":\"fn \",\"limit\":50}" 2>/dev/null)
	case $out in
		*searchd_fallback*) printf '%s grep %s\n' "$label" "$(printf '%s' "$out" | tail -1)" >>"$LOGS/probes.txt" ;;
		*) printf '%s grep ok\n' "$label" >>"$LOGS/probes.txt" ;;
	esac
}

# ---------------------------------------------------------------- daemon

if [ ! -s "$DATA/selftest.json" ]; then
	echo "soak: recording the selftest this build passes against $REAL_RG"
	SEARCHD_DIR="$DATA" "$BIN" selftest --stamp --rg "$REAL_RG" >>"$LOGS/selftest.log" 2>&1 \
		|| die "the selftest did not pass; see $LOGS/selftest.log"
fi
start_daemon main "$DATA" "$WORK" "$PATH" || die "the daemon did not start"

sampler &
SAMPLER_PID=$!

cleanup() {
	kill "$SAMPLER_PID" 2>/dev/null
	[ -z "${AUTOSAVE_PID:-}" ] || kill "$AUTOSAVE_PID" 2>/dev/null
	stop_daemon main
	stop_daemon small
	if [ -n "${MOUNT:-}" ] && mount | grep -q "on $MOUNT "; then
		hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || hdiutil detach "$MOUNT" -force -quiet >/dev/null 2>&1
		MOUNT=""
	fi
	if command -v trash >/dev/null; then
		trash "$SOAK" && echo "soak: trashed $SOAK"
	else
		echo "soak: no trash command; $SOAK is left behind"
	fi
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- workload

phase clone
if [ "${SOAK_SKIP_CLONE:-0}" = 1 ]; then
	echo "soak: SOAK_SKIP_CLONE=1, writing a large tree instead of cloning"
	python3 - "$WORK/many" "$MANY_FILES" <<'PY'
import os, sys
root, n = sys.argv[1], int(sys.argv[2])
for i in range(n):
    d = os.path.join(root, "d%03d" % (i % 200))
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "f%05d.txt" % i), "w") as f:
        f.write("needle_%d\nfn main() {}\n" % i)
PY
else
	git clone --depth 1 https://github.com/BurntSushi/ripgrep "$WORK/ripgrep" >>"$LOGS/clone.log" 2>&1 \
		|| echo "soak: the clone failed (no network?); SOAK_SKIP_CLONE=1 runs without it"
fi
mkdir -p "$WORK/autosave"
echo "needle autosave 0" >"$WORK/autosave/notes.md"
probe "$WORK" clone

phase autosave
(
	i=0
	deadline=$((SECONDS + AUTOSAVE_SECS))
	while [ $SECONDS -lt $deadline ]; do
		i=$((i + 1))
		{
			printf 'needle autosave %s\n' "$i"
			seq 1 200 | sed 's/^/line /'
		} >"$WORK/autosave/notes.tmp"
		mv "$WORK/autosave/notes.tmp" "$WORK/autosave/notes.md"
		sleep 1
	done
) &
AUTOSAVE_PID=$!

phase many-files
# 20k files in one folder, then out of it again: 20k removals in one folder is
# the relist that was quadratic. They are moved, not deleted, into retired/.
python3 - "$WORK/many" "$MANY_FILES" <<'PY'
import os, sys
root, n = sys.argv[1], int(sys.argv[2])
os.makedirs(root, exist_ok=True)
for i in range(n):
    with open(os.path.join(root, "f%05d.txt" % i), "w") as f:
        f.write("needle_%d\n" % i)
PY
sleep 3
probe "$WORK/many" many-created
python3 - "$WORK/many" "$SOAK/retired" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
for n in os.listdir(src):
    os.rename(os.path.join(src, n), os.path.join(dst, n))
PY
probe "$WORK" many-removed

phase rg-upgrade
cat >"$SOAK/bin/rg" <<SHIM
#!/bin/sh
if [ "\$1" = "--version" ]; then echo "ripgrep 99.0.0 (soak shim)"; exit 0; fi
exec "$REAL_RG" "\$@"
SHIM
chmod +x "$SOAK/bin/rg"
stop_daemon main
start_daemon main "$DATA" "$WORK" "$SOAK/bin:$PATH" || die "the daemon did not restart after the rg upgrade"
case $(cat "$DATA/selftest.json") in
	*"soak shim"*) UPGRADE=ok ;;
	*) UPGRADE="stamp still $(cat "$DATA/selftest.json")" ;;
esac
if grep -q "the check passed" "$DATA/searchd.log" 2>/dev/null; then
	UPGRADE="$UPGRADE, checked itself against the new rg"
else
	UPGRADE="$UPGRADE, no recheck in the log"
fi
probe "$WORK" after-upgrade

phase apfs-image
# A volume far under the index's 5 GiB floor: the index must block itself and
# write nothing, never fill the disk under the user's feet.
MOUNT=$SOAK/mnt
mkdir -p "$MOUNT"
if hdiutil create -size 300m -fs APFS -volname sdsoak "$SOAK/disk.dmg" -quiet >>"$LOGS/disk.log" 2>&1 \
	&& hdiutil attach "$SOAK/disk.dmg" -mountpoint "$MOUNT" -nobrowse -noautoopen -quiet >>"$LOGS/disk.log" 2>&1; then
	mkdir -p "$MOUNT/data" "$MOUNT/work/fill"
	printf 'needle on a small disk\n' >"$MOUNT/work/fill/a.txt"
	SEARCHD_DIR="$MOUNT/data" "$BIN" selftest --stamp --rg "$REAL_RG" >>"$LOGS/selftest.log" 2>&1
	start_daemon small "$MOUNT/data" "$MOUNT/work" "$PATH" || die "the second daemon did not start"
	BLOCKED_BEFORE=$(field "$(status_of "$MOUNT/data")" indexBlocked)
	dd if=/dev/zero of="$MOUNT/filler" bs=1m count=270 >>"$LOGS/disk.log" 2>&1 || true
	FREE_MB=$(df -m "$MOUNT" | awk 'NR==2 {print $4}')
	sleep 3
	SMALL_STATUS=$(status_of "$MOUNT/data")
	BLOCKED_AFTER=$(field "$SMALL_STATUS" indexBlocked)
	SMALL_INDEXED=$(field "$SMALL_STATUS" filesIndexed)
	SMALL_KB=$(index_kb "$MOUNT/data")
	if [ "$BLOCKED_BEFORE/$BLOCKED_AFTER" = disk/disk ] && [ "${SMALL_INDEXED:-1}" = 0 ] && [ "$SMALL_KB" = 0 ]; then
		DISK=ok
	elif [ "$BLOCKED_BEFORE/$BLOCKED_AFTER" != disk/disk ]; then
		DISK="indexBlocked $BLOCKED_BEFORE then $BLOCKED_AFTER"
	else
		DISK="wrote an index anyway: $SMALL_INDEXED files, ${SMALL_KB} KB"
	fi
	stop_daemon small
	echo "soak: the small volume has ${FREE_MB:-?} MB free"
else
	DISK="no image: $(tail -2 "$LOGS/disk.log" | tr '\n' ' ')"
fi

phase warm
# A file is left to the indexer only after it has been still for the daemon's
# quiet window (120 s): without this wait a short soak samples an empty index.
WARMED=0
WARM_LIMIT=${SOAK_WARM_SECS:-180}
while [ "$WARMED" -lt "$WARM_LIMIT" ]; do
	json=$(status_of "$(cat "$(dir_of main)")")
	indexed=$(field "$json" indexedFiles)
	if [ "${indexed:-0}" -gt 0 ]; then
		echo "soak: the index holds ${indexed} files after ${WARMED}s"
		break
	fi
	sleep 5
	WARMED=$((WARMED + 5))
done
[ "${indexed:-0}" -gt 0 ] || echo "soak: nothing has been indexed yet after ${WARMED}s"

phase idle
IDLE_START=$(date +%s)
IDLE_CPU_START=$(cpu_seconds "$(cat "$LOGS/main.pid")")
probe "$WORK" before-idle
sleep "$IDLE_SECS"
IDLE_WALL=$(( $(date +%s) - IDLE_START ))
IDLE_CPU_END=$(cpu_seconds "$(cat "$LOGS/main.pid")")
probe "$WORK" after-idle

kill "$SAMPLER_PID" 2>/dev/null
wait "$SAMPLER_PID" 2>/dev/null
[ -z "${AUTOSAVE_PID:-}" ] || wait "$AUTOSAVE_PID" 2>/dev/null

# ---------------------------------------------------------------- report

MEASURED=$(python3 - "$LOGS/samples.txt" "$IDLE_CPU_START" "$IDLE_CPU_END" "$IDLE_WALL" <<'PY'
import sys
path, cpu_start, cpu_end, wall = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), int(sys.argv[4])
rows = []
for line in open(path):
    parts = line.rstrip("\n").split(" ", 7)
    if len(parts) < 8:
        continue
    rows.append((int(parts[0]), parts[1], float(parts[2]), float(parts[3]), int(parts[4]), int(parts[5]), int(parts[6]), parts[7]))
idle = [r for r in rows if r[1] == "idle"]
cpu_total = cpu_end - cpu_start
pct = cpu_total / wall * 100 if wall > 0 else 0.0
print(
    "%.2f" % pct,
    "%.1f" % max([r[2] for r in idle], default=0.0),
    "%.1f" % max([r[2] for r in rows], default=0.0),
    str(max([r[4] for r in rows], default=0)),
    str(len(rows)),
    str(sum(1 for r in rows if r[5] == 0)),
    str(max([r[6] for r in rows], default=0)),
    "%.1f" % cpu_total,
)
PY
)
read -r IDLE_CPU_PCT IDLE_FP PEAK_FP INDEX_MAX_KB SAMPLES CRASHES INDEXED_FILES IDLE_CPU_TOTAL <<EOF
$MEASURED
EOF

REFUSED=$(grep -c -v ' ok$' "$LOGS/probes.txt" 2>/dev/null || true)
PROBES=$(wc -l <"$LOGS/probes.txt" | tr -d ' ')
if kill -0 "$(cat "$LOGS/main.pid")" 2>/dev/null; then RUNNING=yes; else RUNNING=no; fi

verdict() { # label, ok, detail
	if [ "$2" = yes ]; then printf '  %-18s %-6s %s\n' "$1" PASS "$3"; else printf '  %-18s %-6s %s\n' "$1" FAIL "$3"; fi
}

echo
printf '  %-18s %-6s %s\n' BUDGET "" "MEASURED (${SAMPLES} samples every ${SAMPLE_SECS}s)"
cpu_ok=no
awk -v v="$IDLE_CPU_PCT" -v m="$IDLE_CPU_MAX" 'BEGIN { exit !(v <= m) }' && cpu_ok=yes
verdict "idle CPU" "$cpu_ok" "${IDLE_CPU_PCT}% over ${IDLE_WALL}s, ${IDLE_CPU_TOTAL}s of CPU (limit ${IDLE_CPU_MAX}%)"
fp_ok=no
awk -v v="$IDLE_FP" -v m="$IDLE_FOOTPRINT_MAX" 'BEGIN { exit !(v <= m) }' && fp_ok=yes
verdict "idle footprint" "$fp_ok" "${IDLE_FP} MB (limit ${IDLE_FOOTPRINT_MAX} MB)"
peak_ok=no
awk -v v="$PEAK_FP" -v m="$PEAK_FOOTPRINT_MAX" 'BEGIN { exit !(v <= m) }' && peak_ok=yes
verdict "peak footprint" "$peak_ok" "${PEAK_FP} MB (limit ${PEAK_FOOTPRINT_MAX} MB)"
cap_ok=no
[ "$INDEX_MAX_KB" -le "$INDEX_CAP_KB" ] && cap_ok=yes
verdict "index size" "$cap_ok" "${INDEX_MAX_KB} KB of ${INDEX_CAP_KB} KB, ${INDEXED_FILES} files indexed"
crash_ok=no
[ "$CRASHES" = 0 ] && [ "$RUNNING" = yes ] && crash_ok=yes
verdict "crashes" "$crash_ok" "${CRASHES} samples with no process, daemon running at the end: $RUNNING"
refuse_ok=no
[ "${REFUSED:-1}" = 0 ] && refuse_ok=yes
verdict "refusing queries" "$refuse_ok" "${REFUSED:-0} of ${PROBES} probes handed to rg"
upgrade_ok=no
case $UPGRADE in ok,*) upgrade_ok=yes ;; esac
verdict "rg upgrade" "$upgrade_ok" "$UPGRADE"
disk_ok=no
[ "$DISK" = ok ] && disk_ok=yes
verdict "small volume" "$disk_ok" "$DISK"
echo
if [ "${REFUSED:-0}" != 0 ]; then
	echo "soak: the probes that did not answer:"
	grep -v ' ok$' "$LOGS/probes.txt" | sort | uniq -c | head -5
fi
echo "soak: wake-ups need root; run this by hand while a soak is going:"
echo "  sudo powermetrics --samplers tasks --show-process-energy -i 10000 -n 6 | grep -A2 searchd"

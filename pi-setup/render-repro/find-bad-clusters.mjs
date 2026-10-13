// generate the phase-F corpus, normalize it with the live box-format,
// then measure every unique cluster in tmux vs pi-tui width.
import { execSync } from "node:child_process";
import fs from "node:fs";

const PI_ROOT = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI_ROOT}/node_modules/jiti/lib/jiti.mjs`);
const TUI_PKG = `${PI_ROOT}/node_modules/@earendil-works/pi-tui`;
const { visibleWidth } = await import(`${TUI_PKG}/dist/utils.js`);

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: { "@mariozechner/pi-tui": TUI_PKG, "@earendil-works/pi-tui": TUI_PKG },
});
const { normalizeForDisplay } = await jiti.import((process.env.PI_TOOLS ?? decodeURIComponent(new URL("../extensions/tools", import.meta.url).pathname)) + "/lib/box-format.ts");

// same corpus as phase F
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const lines = [];
for (let i = 0; i < 120; i++) {
  let line = "";
  for (let j = 0; j < 300; j++) {
    const r = rnd();
    let cp;
    if (r < 0.3) cp = 0x20 + Math.floor(rnd() * 0x5e);
    else if (r < 0.5) cp = 0x900 + Math.floor(rnd() * 0x400);
    else if (r < 0.6) cp = 0x600 + Math.floor(rnd() * 0x100);
    else if (r < 0.7) cp = 0x4e00 + Math.floor(rnd() * 0x1000);
    else if (r < 0.8) cp = 0x1f300 + Math.floor(rnd() * 0x300);
    else if (r < 0.9) cp = 0x300 + Math.floor(rnd() * 0x70);
    else cp = 0x1000 + Math.floor(rnd() * 0xd000);
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0x41;
    line += String.fromCodePoint(cp);
  }
  lines.push(line);
}

const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const clusters = new Set();
for (const line of lines) {
  const norm = normalizeForDisplay(line);
  for (const { segment } of seg.segment(norm)) clusters.add(segment);
}
console.log(`${clusters.size} unique clusters after normalization`);

const SESSION = "cluster-test";
execSync(`tmux kill-session -t ${SESSION} 2>/dev/null || true`, { shell: "/bin/bash" });
execSync(`tmux new-session -d -s ${SESSION} -x 100 -y 30 'sleep 600'`);
const tty = execSync(`tmux display -p -t ${SESSION} '#{pane_tty}'`).toString().trim();
const fd = fs.openSync(tty, "w");

let bad = [];
let n = 0;
for (const c of clusters) {
  fs.writeSync(fd, `\r\x1b[K${c}`);
  // tiny settle
  execSync("sleep 0.02");
  const x = parseInt(execSync(`tmux display -p -t ${SESSION} '#{cursor_x}'`).toString().trim(), 10);
  const w = visibleWidth(c);
  // only UNDERCOUNTS are fatal (line renders wider than pi-tui's model →
  // hard-wrap → desync). overcounts just pad a column short — benign.
  if (x > w) {
    bad.push({ c, cps: [...c].map((ch) => "U+" + ch.codePointAt(0).toString(16).toUpperCase()), piTui: w, tmux: x });
  }
  n++;
}
fs.closeSync(fd);
execSync(`tmux kill-session -t ${SESSION}`);
console.log(`measured ${n}, bad: ${bad.length}`);
for (const b of bad.slice(0, 40)) console.log(JSON.stringify(b));

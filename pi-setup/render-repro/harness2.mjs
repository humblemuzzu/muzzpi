/**
 * harness v2 — desync detector with DSR cursor verification.
 *
 * runs the production render stack (pi-tui TUI + Box + Markdown + our
 * box-format via jiti) and after every frame queries the terminal's REAL
 * cursor position (CSI 6n). compares against pi-tui's internal model.
 * drift change = the terminal scrolled/wrapped in a way pi-tui didn't
 * predict = the smear bug, caught at the exact frame.
 *
 * works in any terminal (Ghostty, tmux) — no capture needed.
 *
 * env:
 *   PHASE  = A  heavy ascii bash-box streaming
 *            M  markdown code-block streaming (assistant path, pi core)
 *            MU markdown with mixed unicode
 *            X  combined: markdown + bash box + loader
 *   OUT    = report file (default /tmp/pi-render-repro/dsr-report.txt)
 */
import fs from "node:fs";

const PI_ROOT = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI_ROOT}/node_modules/jiti/lib/jiti.mjs`);
const TUI_PKG = `${PI_ROOT}/node_modules/@earendil-works/pi-tui`;
const TOOLS = (process.env.PI_TOOLS ?? decodeURIComponent(new URL("../extensions/tools", import.meta.url).pathname));
const OUT = process.env.OUT || "/tmp/pi-render-repro/dsr-report.txt";
const PHASE = process.env.PHASE || "A";

const tui_mod = await import(`${TUI_PKG}/dist/index.js`);
const { TUI, ProcessTerminal, Box, Text, Container, Loader, Markdown } = tui_mod;

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: { "@mariozechner/pi-tui": TUI_PKG, "@earendil-works/pi-tui": TUI_PKG },
});
const { formatBoxesWindowed } = await jiti.import(`${TOOLS}/lib/box-format.ts`);
const { OutputBuffer } = await jiti.import(`${TOOLS}/lib/output-buffer.ts`);

const COLLAPSED_EXCERPTS = [
  { focus: "head", context: 3 },
  { focus: "tail", context: 5 },
];
const fg = (s) => `\x1b[38;5;223m${s}\x1b[39m`;
const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const bg = (s) => `\x1b[48;5;236m${s}\x1b[49m`;

// markdown theme: minimal viable theme object for pi-tui Markdown
function mdTheme() {
  const id = (s) => s;
  return {
    heading: fg, link: id, linkUrl: dim, code: (s) => `\x1b[48;5;237m${s}\x1b[49m`,
    codeBlock: (s) => `\x1b[48;5;235m${s}\x1b[49m`,
    codeBlockBorder: dim, blockquote: dim, blockquoteBorder: dim,
    listBullet: fg, hr: dim, bold: (s) => `\x1b[1m${s}\x1b[22m`,
    italic: (s) => `\x1b[3m${s}\x1b[23m`, strikethrough: id, underline: id,
  };
}

// --- content ---
const CODE_LINES = [
  "def refresh_token(session, token):",
  "    if token is not None:",
  "        session.headers['Authorization'] = f'Bearer {token}'",
  "    resp = session.post(AUTH_URL, timeout=15)",
  "    resp.raise_for_status()",
  "    return resp.json()['access_token']",
];
const UNI_LINES = [
  "# प्रमाणीकरण क्त्र श्र टोकन जाँच 日本語 🚀",
  "if token is not None:  # ✓ चेक ✅",
  "    print('स्वागत क्त्र', token[:8])",
];
const JSON_LINE = `PROD /readyz: {"status":"ok","checks":{"postgres":"ok","redis":"ok"}} `;

// --- component stack ---
const terminal = new ProcessTerminal();
const ui = new TUI(terminal);
const chat = new Container();
ui.addChild(chat);

let md = null;
let mdText = "";
const toolBox = new Box(1, 1, bg);
const output = new OutputBuffer(50, 50);
const callText = new Text(fg("$ heavy-stream … (repro)"), 0, 0);

function rebuildToolBox(isFinal) {
  toolBox.clear();
  toolBox.addChild(callText);
  const { text } = isFinal ? output.format() : output.preview();
  const outputLines = text.split("\n");
  const sections = [{ blocks: [{ lines: outputLines.map((l) => ({ text: fg(l), highlight: true })) }] }];
  let cw, cl;
  toolBox.addChild({
    render(width) {
      if (cl !== undefined && cw === width) return cl;
      cl = formatBoxesWindowed(sections, { excerpts: COLLAPSED_EXCERPTS }, ["took 1.0s"], width).split("\n");
      cw = width;
      return cl;
    },
    invalidate() { cl = undefined; cw = undefined; },
  });
}

if (PHASE === "A" || PHASE === "X") {
  ui.addChild(toolBox);
  rebuildToolBox(false);
}
if (PHASE === "M" || PHASE === "MU" || PHASE === "X") {
  md = new Markdown("", 0, 0, mdTheme());
  chat.addChild(md);
}
const loader = new Loader(ui, (s) => s, (s) => dim(s), "Working...");
ui.addChild(loader);
loader.start();

// --- DSR cursor verification ---
let pendingDsr = null;
ui.addInputListener((data) => {
  const m = /\x1b\[(\d+);(\d+)R/.exec(data);
  if (m && pendingDsr) {
    const cb = pendingDsr;
    pendingDsr = null;
    cb({ row: parseInt(m[1], 10), col: parseInt(m[2], 10) });
    return { consume: true };
  }
  return undefined;
});
function queryCursor() {
  return new Promise((resolve) => {
    const t = setTimeout(() => { pendingDsr = null; resolve(null); }, 1000);
    pendingDsr = (pos) => { clearTimeout(t); resolve(pos); };
    terminal.write("\x1b[6n");
  });
}

const report = [];
let baseline = null; // drift baseline (accounts for prompt offset before start)
let desyncs = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** sample cursor only when no render is scheduled or in flight */
async function stableCursorDrift() {
  for (let attempt = 0; attempt < 20; attempt++) {
    while (ui.renderRequested || ui.renderTimer) await sleep(10);
    const vt = ui.previousViewportTop ?? 0;
    const hwRow = ui.hardwareCursorRow;
    const pos = await queryCursor();
    // a render started while we awaited the response — sample is dirty, retry
    if (ui.renderRequested || ui.renderTimer || hwRow !== ui.hardwareCursorRow) continue;
    if (!pos) return null;
    return { drift: pos.row - (hwRow - vt + 1), pos, hwRow, vt };
  }
  return null;
}

async function verifyFrame(tick) {
  const s = await stableCursorDrift();
  if (!s) { report.push(`tick ${tick}: no stable sample`); return; }
  if (baseline === null) baseline = s.drift;
  if (s.drift !== baseline) {
    // confirm persistence — the smear is a permanent shift, not a race
    await sleep(120);
    const s2 = await stableCursorDrift();
    if (s2 && s2.drift === baseline) return; // transient, ignore
    desyncs++;
    report.push(
      `tick ${tick}: DESYNC drift ${baseline} -> ${s.drift}${s2 ? ` (confirmed ${s2.drift})` : ""} ` +
      `(dsr row=${s.pos.row} col=${s.pos.col}, model hwRow=${s.hwRow} vt=${s.vt} lines=${ui.previousLines.length} h=${terminal.rows})`,
    );
    baseline = s2 ? s2.drift : s.drift;
  }
}

// --- streaming loop ---
ui.start();
let tick = 0;
const MAX_TICKS = 150;

async function loop() {
  if (tick >= MAX_TICKS) return finish();
  tick++;
  // stream content
  if (PHASE === "A" || PHASE === "X") {
    const n = 1 + (tick % 3);
    for (let i = 0; i < n; i++) {
      output.add(JSON_LINE.repeat(1 + ((tick + i) % 12)).slice(0, 990) + "\n");
    }
    rebuildToolBox(false);
  }
  if (md) {
    const src = PHASE === "MU" ? UNI_LINES : CODE_LINES;
    if (tick % 7 === 1) mdText += "\nSome explanation paragraph before the code, streaming in like an assistant reply.\n\n```python\n";
    mdText += src[tick % src.length] + "\n";
    if (tick % 7 === 0) mdText += "```\n";
    md.setText(mdText);
  }
  if (tick % 10 === 0) chat.addChild(new Text(fg(`assistant paragraph ${tick} — filler prose line streamed mid-run`), 0, 0));
  ui.requestRender();
  // let the frame render, then verify actual vs model cursor
  setTimeout(async () => {
    await verifyFrame(tick);
    setTimeout(loop, 40);
  }, 45);
}

function finish() {
  loader.stop?.();
  if (PHASE === "A" || PHASE === "X") { rebuildToolBox(true); }
  ui.requestRender();
  setTimeout(async () => {
    await verifyFrame("final");
    const summary = `phase=${PHASE} ticks=${tick} desyncs=${desyncs} term=${terminal.columns}x${terminal.rows} fullRedraws=${ui.fullRedraws}`;
    fs.writeFileSync(OUT, summary + "\n" + report.join("\n") + "\n");
    ui.stop();
    process.exit(desyncs > 0 ? 2 : 0);
  }, 200);
}

setTimeout(loop, 300);

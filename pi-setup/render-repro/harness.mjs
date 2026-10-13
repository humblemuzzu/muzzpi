/**
 * repro harness: exact production render path for our custom bash tool.
 *
 * pipeline replicated from pi dist + our extensions:
 *   TUI (differential renderer)
 *     └─ ToolExecutionComponent-equivalent: Box(1,1,bg)
 *          ├─ renderCall Text
 *          └─ renderResult: formatBoxesWindowed (our box-format.ts via jiti)
 *
 * streams heavy chunks through OutputBuffer (our output-buffer.ts) with
 * bash.ts's sanitizeForDisplay copy, updating every 80ms like streaming.
 *
 * at the end: dumps tui's internal previousLines model to model.txt.
 * external runner then diffs against `tmux capture-pane` ground truth.
 */
import fs from "node:fs";

const PI_ROOT = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI_ROOT}/node_modules/jiti/lib/jiti.mjs`);
const TUI_PKG = `${PI_ROOT}/node_modules/@earendil-works/pi-tui`;
const TOOLS = (process.env.PI_TOOLS ?? decodeURIComponent(new URL("../extensions/tools", import.meta.url).pathname));

const tui_mod = await import(`${TUI_PKG}/dist/index.js`);
const { TUI, ProcessTerminal, Box, Text, Container, Loader } = tui_mod;

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    "@mariozechner/pi-tui": TUI_PKG,
    "@earendil-works/pi-tui": TUI_PKG,
  },
});

const boxFormat = await jiti.import(`${TOOLS}/lib/box-format.ts`);
const outputBuffer = await jiti.import(`${TOOLS}/lib/output-buffer.ts`);
const { formatBoxesWindowed } = boxFormat;
const { OutputBuffer } = outputBuffer;

// --- copy of bash.ts sanitizeForDisplay ---
function sanitizeForDisplay(text) {
  return text
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\][^\x1b]*\x1b\\/g, "")
    .replace(/\x1bP[^\x07]*\x07/g, "")
    .replace(/\x1bP[^\x1b]*\x1b\\/g, "")
    .replace(/\x1b[_^X][^\x1b]*\x1b\\/g, "")
    .replace(/\x1b[_^X][^\x07]*\x07/g, "")
    .replace(/\x1b[()][0-9A-B]/g, "")
    .replace(/\x1b[78=>]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

const COLLAPSED_EXCERPTS = [
  { focus: "head", context: 3 },
  { focus: "tail", context: 5 },
];

// theme-ish helpers (SGR like theme.fg would emit)
const fg = (s) => `\x1b[38;5;223m${s}\x1b[39m`;
const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const bg = (s) => `\x1b[48;5;236m${s}\x1b[49m`;

// --- content phases ---
const PHASE = process.env.PHASE || "A";

function makeChunks() {
  const chunks = [];
  if (PHASE === "A") {
    // pure ASCII: 1000-char single-line chunks like the screenshot scenario
    for (let i = 0; i < 120; i++) {
      const base = `chunk${i} print(re.sub(r'\\s+',' ',text[max(0,pos-260):pos+520])[:1000]) lorem ipsum dolor sit amet consectetur `;
      chunks.push(base.repeat(Math.ceil(1000 / base.length)).slice(0, 1000) + "\n");
    }
  } else if (PHASE === "B") {
    // unicode-heavy: emoji, ZWJ, VS16, CJK, arabic, devanagari, combining
    const nasty = [
      "emoji: 🚀🔥💯🎉🧑‍💻👨‍👩‍👧‍👦🏳️‍🌈❤️⚠️☹️✳️ tail",
      "cjk: 日本語のテキストと中文文本が混在している行です これは長い行になります",
      "arabic: هذا نص عربي طويل يمتد على السطر بالكامل مع كلمات كثيرة",
      "devanagari: यह एक हिंदी वाक्य है जिसमें संयुक्ताक्षर हैं क्त्र श्र",
      "combining: e\u0301a\u0300o\u0302u\u0308n\u0303 zalgo: z\u0351\u036b\u0343a\u0344l\u034dg\u034do\u0362",
      "mixed: abc 🇺🇸🇯🇵 flags and ½ ⅓ ¼ symbols → ← ↑ ↓ ⚡ ✨ ▲ ● ◆ ",
    ];
    for (let i = 0; i < 120; i++) {
      const line = nasty[i % nasty.length];
      chunks.push((line.repeat(8)).slice(0, 900) + "\n");
    }
  } else if (PHASE.startsWith("N")) {
    // single nasty class bisect: N0..N5
    const nasty = [
      "emoji: 🚀🔥💯🎉🧑‍💻👨‍👩‍👧‍👦🏳️‍🌈❤️⚠️☹️✳️ tail",
      "cjk: 日本語のテキストと中文文本が混在している行です これは長い行になります",
      "arabic: هذا نص عربي طويل يمتد على السطر بالكامل مع كلمات كثيرة",
      "devanagari: यह एक हिंदी वाक्य है जिसमें संयुक्ताक्षर हैं क्त्र श्र",
      "combining: e\u0301a\u0300o\u0302u\u0308n\u0303 zalgo: z\u0351\u036b\u0343a\u0344l\u034dg\u034do\u0362",
      "mixed: abc 🇺🇸🇯🇵 flags and ½ ⅓ ¼ symbols → ← ↑ ↓ ⚡ ✨ ▲ ● ◆ ",
    ];
    const line = nasty[Number(PHASE.slice(1))];
    for (let i = 0; i < 120; i++) {
      chunks.push((line.repeat(8)).slice(0, 900) + "\n");
    }
  } else if (PHASE === "F") {
    // fuzz: random codepoints from across the BMP + SMP, seeded per line
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 120; i++) {
      let line = "";
      for (let j = 0; j < 300; j++) {
        const r = rnd();
        let cp;
        if (r < 0.3) cp = 0x20 + Math.floor(rnd() * 0x5e);            // ascii
        else if (r < 0.5) cp = 0x900 + Math.floor(rnd() * 0x400);      // devanagari/bengali
        else if (r < 0.6) cp = 0x600 + Math.floor(rnd() * 0x100);      // arabic
        else if (r < 0.7) cp = 0x4e00 + Math.floor(rnd() * 0x1000);    // cjk
        else if (r < 0.8) cp = 0x1f300 + Math.floor(rnd() * 0x300);    // emoji
        else if (r < 0.9) cp = 0x300 + Math.floor(rnd() * 0x70);       // combining
        else cp = 0x1000 + Math.floor(rnd() * 0xd000);                 // anything BMP
        if (cp >= 0xd800 && cp <= 0xdfff) cp = 0x41;
        line += String.fromCodePoint(cp);
      }
      chunks.push(line + "\n");
    }
  } else if (PHASE === "C") {
    // tabs + partial ansi split across chunks (sanitize runs, but tests carry logic gaps)
    for (let i = 0; i < 120; i++) {
      chunks.push(`line${i}\twith\ttabs\tand\tmore\ttabs\tindent\tstuff\tlong\ttail\tpadding\tpadding\n`);
    }
  }
  return chunks;
}

// --- build TUI like interactive mode ---
const terminal = new ProcessTerminal();
const ui = new TUI(terminal);

// chat filler so total height exceeds viewport and grows (forces scroll-append path)
const chat = new Container();
ui.addChild(chat);
for (let i = 0; i < 30; i++) {
  chat.addChild(new Text(fg(`assistant filler line ${i} — some prose text that fills the scrollback area of the chat.`), 0, 0));
}

// tool execution shell: Box(1,1,bg) like ToolExecutionComponent.contentBox
const toolBox = new Box(1, 1, bg);
ui.addChild(toolBox);

// loader like pi's working spinner
const loader = new Loader(ui, (s) => s, (s) => dim(s), "Working...");
ui.addChild(loader);
loader.start();

const callText = new Text(fg("$ heavy-stream … (repro)"), 0, 0);

const output = new OutputBuffer(50, 50);
let renderCount = 0;

function rebuildToolBox(isFinal) {
  toolBox.clear();
  toolBox.addChild(callText);
  const { text } = isFinal ? output.format() : output.preview();
  const clean = sanitizeForDisplay(text);
  const outputLines = clean.split("\n");
  const sections = [{ blocks: [{ lines: outputLines.map((l) => ({ text: fg(l), highlight: true })) }] }];
  let cachedWidth, cachedLines;
  toolBox.addChild({
    render(width) {
      if (cachedLines !== undefined && cachedWidth === width) return cachedLines;
      const visual = formatBoxesWindowed(sections, { excerpts: COLLAPSED_EXCERPTS }, ["took 1.0s"], width);
      cachedLines = visual.split("\n");
      cachedWidth = width;
      return cachedLines;
    },
    invalidate() { cachedLines = undefined; cachedWidth = undefined; },
  });
}

rebuildToolBox(false);
ui.start();

const chunks = makeChunks();
let idx = 0;
const timer = setInterval(() => {
  if (idx >= chunks.length) {
    clearInterval(timer);
    rebuildToolBox(true);
    ui.requestRender();
    // let final frame settle, then dump model and freeze
    setTimeout(() => {
      loader.stop?.();
      ui.requestRender();
      setTimeout(dumpAndFreeze, 300);
    }, 300);
    return;
  }
  // add 1-3 chunks per tick (bursty like real streaming)
  const n = 1 + (idx % 3);
  for (let i = 0; i < n && idx < chunks.length; i++) output.add(chunks[idx++]);
  // also grow the chat a bit sometimes (assistant text streaming in parallel)
  if (idx % 10 === 0) {
    chat.addChild(new Text(fg(`streamed assistant line ${idx} appended mid-run`), 0, 0));
  }
  rebuildToolBox(false);
  renderCount++;
  ui.requestRender();
}, 80);

function dumpAndFreeze() {
  const model = ui.previousLines;
  fs.writeFileSync("/tmp/pi-render-repro/model.txt", JSON.stringify({
    phase: PHASE,
    width: terminal.columns,
    height: terminal.rows,
    fullRedraws: ui.fullRedraws,
    lines: model,
  }, null, 1));
  fs.writeFileSync("/tmp/pi-render-repro/done", "1");
  // freeze: keep the screen as-is for capture-pane
  setInterval(() => {}, 1000);
}

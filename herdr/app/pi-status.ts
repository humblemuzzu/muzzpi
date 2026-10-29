// muzzpi · herdr app: pi reports idle / working / blocked to herdr-core as OSC 7501.
// Installed by ./install.sh herdr-app as ~/.pi/agent/extensions/herdr-app-status.ts.
// pi gets this built in once pi#10607 ships; remove this file then.

type State = "idle" | "working" | "blocked" | "clear";

const MAX_MSG_BYTES = 256;

function base64(text: string): string {
	let bytes = Buffer.from(text.replace(/[\x00-\x1f\x7f]+/g, " ").trim(), "utf8");
	if (bytes.length > MAX_MSG_BYTES) bytes = bytes.subarray(0, MAX_MSG_BYTES);
	return bytes.toString("base64");
}

function sequence(state: State, msg?: string): string {
	if (state === "clear") return "\x1b]7501;state=clear\x1b\\";
	let body = `state=${state}:app=pi`;
	if (state === "blocked") body += ":kind=question";
	if (msg) body += `:msg=${base64(msg)}`;
	return `\x1b]7501;${body}\x1b\\`;
}

export default function (pi: any) {
	if (!process.env.HC_TERMINAL_ID || !process.stdout.isTTY) return;

	let live = false;
	let working = false;
	let blocked: (string | undefined)[] = [];
	let last = "";

	const publish = (force = false) => {
		if (!live) return;
		const out = blocked.length ? sequence("blocked", blocked.at(-1)) : sequence(working ? "working" : "idle");
		if (!force && out === last) return;
		last = out;
		try {
			process.stdout.write(out);
		} catch {}
	};

	pi.events.on("herdr:blocked", (data: any) => {
		if (!live) return;
		if (data?.active) blocked.push(data.label);
		else blocked.pop();
		publish();
	});

	pi.on("session_start", (_event: any, ctx: any) => {
		if (ctx?.mode !== "tui") return;
		live = true;
		blocked = [];
		working = ctx?.isIdle?.() === false;
		publish(true);
	});

	pi.on("agent_start", () => {
		working = true;
		publish();
	});

	pi.on("agent_settled", (_event: any, ctx: any) => {
		if (ctx?.isIdle?.() !== true) return;
		working = false;
		publish();
	});

	pi.on("session_shutdown", () => {
		if (!live) return;
		live = false;
		last = "";
		try {
			process.stdout.write(sequence("clear"));
		} catch {}
	});
}

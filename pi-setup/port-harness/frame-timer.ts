// pi -e pi-setup/port-harness/frame-timer.ts   (log: $PI_FRAME_LOG, default /tmp/pi-frames.log)
//
// Logs how long each TUI frame took to draw, and a "LAG <ms>" line whenever
// the event loop was blocked for over 40 ms: the length of a freeze.
import * as fs from "node:fs";

const LOG = process.env.PI_FRAME_LOG || "/tmp/pi-frames.log";
const LAG_MS = 40;

const log = (line: string) => {
	try {
		fs.appendFileSync(LOG, `${line}\n`);
	} catch {}
};

export default function (pi: any) {
	let lag: ReturnType<typeof setInterval> | undefined;
	let restore: (() => void) | undefined;
	pi.on("session_start", (_event: any, ctx: any) => {
		try {
			fs.writeFileSync(LOG, "");
		} catch {}
		ctx.ui.setWidget("zz-frame-timer", (tui: any) => {
			if (!restore) {
				const draw = tui.doRender;
				tui.doRender = (...args: unknown[]) => {
					const start = performance.now();
					const result = draw.apply(tui, args);
					log((performance.now() - start).toFixed(2));
					return result;
				};
				restore = () => {
					tui.doRender = draw;
				};
			}
			return { render: () => [], invalidate() {} };
		});
		let last = performance.now();
		clearInterval(lag);
		lag = setInterval(() => {
			const now = performance.now();
			if (now - last > LAG_MS) log(`LAG ${(now - last).toFixed(0)}`);
			last = now;
		}, 10);
	});
	pi.on("session_shutdown", () => {
		clearInterval(lag);
		restore?.();
		restore = undefined;
	});
}

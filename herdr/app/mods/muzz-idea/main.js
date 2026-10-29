// ⌘I: the /idea capture box (idea.sh beside this file) in a popup terminal, filed for the
// focused pane's project. The terminal is hidden from the window (no herdr labels) and
// removed when it exits; the popup closes with it.

import { View, div } from "gpui-kit";
import { focused, hc, home, appHome, notify, openOverlay, props, closeOverlay } from "herdr";

export default class Idea extends View {
  init(_props, cx) {
    const launcher = props()?.overlay;
    if (!launcher) return;
    const cwd = focused()?.cwd || home();
    cx.spawn(async () => {
      const r = await hc(["run", "--bg", "--json", "--no-parent", "--rm", "--cwd", cwd, "--", "env", `HERDR_ACTIVE_PANE_CWD=${cwd}`, "/bin/bash", `${appHome()}/mods/muzz-idea/idea.sh`]);
      closeOverlay(launcher);
      const address = r.code === 0 ? JSON.parse(r.stdout).address : null;
      if (!address) return notify({ title: "Idea box did not start", body: r.stderr.trim() || "hc run failed", level: "error" });
      openOverlay({ kind: "dialog", width: 0.75, height: 150, layout: { type: "block", content: { terminal: address } } });
    });
  }

  render() {
    return div();
  }
}

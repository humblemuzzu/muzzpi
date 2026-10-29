// ⌘W: closes the focused pane at once when it is a plain shell; asks first when an
// agent runs in it or it is the space's last terminal (the space closes with it).

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { focused, panes, spaces, run, props, closeOverlay, theme } from "herdr";

export default class Close extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.overlay = props()?.overlay;
    if (!this.overlay) return;
    const f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    if (!pane) return closeOverlay(this.overlay);
    const space = spaces().find((s) => s.id === f.space);
    const tabs = new Set(space?.tabs.map((t) => t.id) ?? []);
    this.pane = pane;
    this.space = space;
    this.last = panes().filter((p) => tabs.has(p.tab)).length <= 1;
    const agent = pane.status || pane.program?.agent ? pane.program?.name ?? "agent" : null;
    const parts = [];
    if (agent) parts.push(`Close ${agent}${pane.status ? ` (${pane.status})` : ""}? It stops.`);
    if (this.last) parts.push(`This is the last terminal in ${space?.name ?? "this space"}, so the space closes too.`);
    this.question = parts.join(" ");
    if (!this.question) this.yes();
  }

  yes() {
    closeOverlay(this.overlay);
    if (this.last && this.space) run("space.close", { id: this.space.id, confirmed: true });
    else run("pane.close", { pane: this.pane.pane });
  }

  render() {
    const t = theme();
    if (!this.question) return div();
    return v_flex()
      .id("muzz-close")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter" || e.key === "y") this.yes();
        else closeOverlay(this.overlay);
        cx.stop_propagation();
      })
      .size_full()
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().text_color(t.foreground).child(this.question))
      .child(div().text_size(11).text_color(t.dim).child("enter closes · any other key keeps it"));
  }
}

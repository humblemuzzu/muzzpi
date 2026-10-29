// ⌘O: pick a project folder. Jumps to its space when one is open, else opens a
// space there with pi (ctrl+s: a plain shell). Open projects first, then by when
// pi last ran there. The folders searched are ROOTS, under your home.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, spaces, panes, run, theme, props, closeOverlay, home, appHome } from "herdr";

const ROOTS = ["Documents/Code stuff", "StudioProjects", "Projects", "code"];
const PI = ["/bin/zsh", "-lic", "pi; exec zsh -l"];

function age(sec) {
  const s = Date.now() / 1000 - sec;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 1209600) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / 604800)}w`;
}

function matches(name, f) {
  if (!f) return true;
  if (name.includes(f)) return true;
  let i = 0;
  for (const ch of name) if (ch === f[i]) i++;
  return i === f.length;
}

function openSpace(dir) {
  const inside = (cwd) => cwd === dir || cwd?.startsWith(dir + "/");
  const tabSpace = new Map(spaces().flatMap((s) => s.tabs.map((t) => [t.id, s])));
  const pane = panes().find((p) => !p.mod && inside(p.cwd) && tabSpace.has(p.tab));
  return pane ? tabSpace.get(pane.tab) : spaces().find((s) => !s.machine && inside(s.folder));
}

export default class OpenProject extends View {
  init(_props, cx) {
    this.filter = "";
    this.at = 0;
    this.projects = null;
    this.error = null;
    this.input = InputState.new({ placeholder: "project…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value().toLowerCase(); this.at = 0; cx.notify(); });
    this.input.on("submit", () => this.go(this.rows()[this.at], false));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    cx.spawn(async (cx) => {
      try {
        const roots = ROOTS.map((r) => `${home()}/${r}`);
        const r = await exec("/bin/bash", [`${appHome()}/mods/muzz-open/list.sh`, `${home()}/.pi/agent/sessions`, ...roots]);
        this.projects = r.stdout.split("\n").filter(Boolean).map((line) => {
          const [used, dir] = line.split("\t");
          return { dir, name: dir.slice(dir.lastIndexOf("/") + 1), used: Number(used) || 0 };
        });
        if (!this.projects.length) this.error = `no project folders in ~/${ROOTS.join(", ~/")}`;
      } catch (e) {
        this.error = String(e);
      }
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  rows() {
    if (!this.projects) return [];
    return this.projects
      .filter((p) => matches(p.name.toLowerCase(), this.filter))
      .map((p) => ({ ...p, space: openSpace(p.dir) }))
      .sort((a, b) => !!b.space - !!a.space || b.used - a.used || a.name.localeCompare(b.name));
  }

  go(row, shellOnly) {
    if (!row) return;
    this.close();
    if (row.space) run("space.select", { id: row.space.id });
    else run("space.new", { name: row.name, folder: row.dir, ...(shellOnly ? {} : { argv: PI }) });
  }

  render() {
    const t = theme();
    const rows = this.rows();
    this.at = Math.min(this.at, Math.max(0, rows.length - 1));
    const row = (r, i) => {
      const on = i === this.at;
      const note = r.space ? (r.space.status ? `open · ${r.space.status}` : "open") : r.used ? age(r.used) : "";
      return h_flex()
        .id(`op-${i}`)
        .mx(4)
        .px(10)
        .h(32)
        .flex_none()
        .rounded(7)
        .gap(10)
        .items_center()
        .cursor_pointer()
        .when(on, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.go(r, false))
        .child(div().w(12).flex_none().text_color(r.space ? t[r.space.status] ?? t.accent : t.dim).child(r.space ? "●" : ""))
        .child(div().flex_1().truncate().text_color(t.foreground).child(r.name))
        .child(div().text_size(11).text_color(r.space?.status === "blocked" ? t.blocked : t.dim).child(note));
    };
    const empty = this.error ?? (this.projects ? "no match" : "looking…");
    return v_flex()
      .id("muzz-open")
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "down" && rows.length) this.at = (this.at + 1) % rows.length;
        else if (k === "up" && rows.length) this.at = (this.at + rows.length - 1) % rows.length;
        else if (k === "s" && e.modifiers.control) return this.go(rows[this.at], true);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Open project")).child(div().text_size(11).text_color(t.dim).child("enter: pi · ctrl+s: shell · esc")))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background).child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .child(
        rows.length
          ? v_flex().h(Math.min(420, 6 + rows.length * 32)).min_h(0).flex_shrink(1).overflow_y_scrollbar().children(rows.map(row))
          : div().px(10).text_color(t.dim).child(empty),
      );
  }
}

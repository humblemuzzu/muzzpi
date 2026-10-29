// ⌘J: show the agent that needs you, else the one that most recently finished.

import { View, div } from "gpui-kit";
import { agents, run, notify, props, closeOverlay } from "herdr";

const RANK = { blocked: 2, done: 1 };

export default class Attention extends View {
  init() {
    const overlay = props()?.overlay;
    if (!overlay) return;
    closeOverlay(overlay);
    const pick = agents()
      .filter((a) => RANK[a.status])
      .sort((a, b) => RANK[b.status] - RANK[a.status] || b.seq - a.seq)[0];
    if (pick) run("agent.focus", { terminal: pick.address });
    else notify({ title: "Nobody needs you", body: "No agent is waiting or just finished.", timeout: 2500 });
  }

  render() {
    return div();
  }
}

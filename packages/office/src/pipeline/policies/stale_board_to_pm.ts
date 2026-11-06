import { definePolicy, type WakeSpec } from "@outstaff/policy";
import { wakes } from "./spec.js";

const sweep: WakeSpec = { person: "role:pm", kind: "reconcile" };

export const policy = definePolicy({
  id: "stale_board_to_pm",
  summary:
    "The office's periodic board sweep (`policies.reconcile.every`) found open tickets whose status or assignee no longer matches what it knows (a ticket in review whose pull requests all merged, a blocked ticket whose blockers all closed, an active ticket nobody works on, a parent whose sub-tickets all closed): the PM is woken once with the list and the facts for each, to put each right. A ticket is listed again for the same reason only after a day.",
  on: ["board.stale"],
  instruction:
    "The office's board sweep found tickets whose status or assignee no longer matches what it knows:\n{{stale}}\nFor each, check the ticket (`ost ticket show <key>`). If it is out of step, put its status and assignee right and say why on it in one line. If it is actually fine, leave it alone and say nothing. Start no new work.",
  decides: `${wakes(sweep).decides}, on the first ticket listed, with the list`,
  decide: (_event, ctx) => ctx.wake(sweep),
});

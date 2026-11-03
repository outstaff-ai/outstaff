import type { StaticTicket } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { event, judge, SAM, t } from "./support.js";

/** sam hands back ACME-1, an item that created `created` and opened pull requests for `opened`. */
const back = (status: string, made: { created?: string[]; opened?: string[] } = {}) =>
  event("agent.handed_back", {
    subject: { ticket: "ACME-1" },
    actor: SAM,
    data: { status, kind: "assigned", ...made },
  });

type Tickets = Record<string, StaticTicket>;

const world = (tickets: Tickets, roles: Record<string, string> = {}) => ({
  tickets: { "ACME-1": t("active", "sam", { requester: "ada.admin" }), ...tickets },
  roles,
});

describe("a hand-back covers the item's other tickets awaiting review", () => {
  it("gives a sub-ticket the item created, in review, to the requester in the same act", () => {
    const w = world({ "ACME-2": t("review", "sam"), "ACME-3": t("backlog") });
    expect(judge("hand_back_done", back("done", { created: ["ACME-2", "ACME-3"] }), w)).toEqual([
      "act for sam: move ACME-1 to review, assign ACME-1 to human ada.admin, assign ACME-2 to human ada.admin",
    ]);
  });

  it("moves a ticket whose pull request the item opened to review, before the pull request is seen", () => {
    const w = world({ "ACME-2": t("active", "sam"), "ACME-4": t("ready", undefined) });
    const made = { created: ["ACME-2"], opened: ["ACME-2", "ACME-4"] };
    expect(judge("hand_back_done", back("done", made), w)).toEqual([
      "act for sam: move ACME-1 to review, assign ACME-1 to human ada.admin, move ACME-2 to review, assign ACME-2 to human ada.admin, move ACME-4 to review, assign ACME-4 to human ada.admin",
    ]);
  });

  it("leaves tickets that are not awaiting review, handed over, or already with the requester", () => {
    const w = world({
      "ACME-2": t("active", "sam"),
      "ACME-3": t("review", "noor"),
      "ACME-4": t("review", "ada.admin"),
      "ACME-5": t("done", "sam"),
    });

    const made = { created: ["ACME-1", "ACME-2", "ACME-3", "ACME-4"], opened: ["ACME-5"] };
    expect(judge("hand_back_done", back("done", made), w)).toEqual([
      "act for sam: move ACME-1 to review, assign ACME-1 to human ada.admin",
    ]);
  });

  it("acts on them alone when the item's own ticket is handed over or needs no change", () => {
    const over = world({ "ACME-2": t("review", "sam") });
    over.tickets["ACME-1"] = t("active", "noor", { requester: "ada.admin" });
    expect(judge("hand_back_done", back("done", { created: ["ACME-2"] }), over)).toEqual([
      "drop: sam handed ACME-1 over to agent noor during the work, and a hand-back does not undo a hand-over",
      "act for sam: assign ACME-2 to human ada.admin",
    ]);

    const done = world({ "ACME-2": t("review", "sam") });
    done.tickets["ACME-1"] = t("review", "ada.admin", { requester: "ada.admin" });
    expect(judge("hand_back_done", back("done", { created: ["ACME-2"] }), done)).toEqual([
      "drop: nothing to change: move: ACME-1 is already review; assign: ACME-1 is already assigned to ada.admin",
      "act for sam: assign ACME-2 to human ada.admin",
    ]);
  });

  it("gives them to the requester on a blocked hand-back too, while the item's ticket goes to the PM", () => {
    const made = { created: ["ACME-2"] };
    const alone = world({ "ACME-2": t("review", "sam") });
    expect(judge("hand_back_blocked", back("blocked", made), alone)).toEqual([
      "act for sam: move ACME-1 to blocked, assign ACME-1 to human ada.admin, assign ACME-2 to human ada.admin",
    ]);

    const pm = world({ "ACME-2": t("review", "sam") }, { pm: "priya" });
    expect(judge("hand_back_blocked_to_pm", back("blocked", made), pm)).toEqual([
      "act for sam: move ACME-1 to blocked, assign ACME-1 to agent priya, assign ACME-2 to human ada.admin",
      "wake priya (unblock) on ticket ACME-1",
    ]);
  });

  it("ignores lists that are not lists of keys", () => {
    const w = world({ "ACME-2": t("review", "sam") });
    expect(judge("hand_back_done", back("done", { created: "ACME-2" as never }), w)).toEqual([
      "act for sam: move ACME-1 to review, assign ACME-1 to human ada.admin",
    ]);
  });
});

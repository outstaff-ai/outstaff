import { describe, expect, it } from "vitest";
import { deskHarness, notice, PR9 } from "./support.js";

const seen = (head: string) => ({ human: "ada.admin", prs: { "acme/shop#9": head } });
const ci = (status: "pending" | "success") => [{ name: "ci", status }];
const ON_PR = { type: "pr", ref: "acme/shop#9" };

const FIXED = notice({ prs: [PR9], text: "Fixed the formatting.", seen: seen("a1b2c3d4e5") });
const REWORKED = notice({ prs: [PR9], text: "Reworked it.", seen: seen("f00dfeed99") });

describe("a notice superseded by more work on the same ticket", () => {
  it("is dropped while another round on the pull request is queued; that round's hand-back is sent", async () => {
    const h = deskHarness();
    h.pr({});
    await h.desk.add(FIXED, "e:fixed");
    h.item({ id: "w2", kind: "review_feedback", status: "queued", subject: ON_PR });
    await h.pass(31_000);
    expect(h.sent).toEqual([]);
    expect(h.logged).toContain(
      "notify: nothing sent to ada.admin about ACME-1: superseded by w2 (review_feedback on acme/shop#9)",
    );

    expect(h.subjects.get("handoff_notified/ACME-1")).toBeUndefined();

    h.pr({ head: "f00dfeed99" });
    h.item({ id: "w2", kind: "review_feedback", status: "done", subject: ON_PR });
    await h.desk.add(REWORKED, "e:reworked");
    await h.pass(31_000);
    expect(h.sent).toHaveLength(1);
    expect(h.bodies()[0]![0]).toMatch(/^U0ADA: Reworked it\.\nReady for your review: /);
    expect(h.subjects.get("handoff_notified/ACME-1")?.data).toEqual(seen("f00dfeed99"));
  });

  it("is dropped while a round on its ticket runs past the longest hold", async () => {
    const h = deskHarness();
    h.rounds.add("sam/ACME-1");
    h.item({
      id: "w2",
      kind: "assigned",
      status: "active",
      subject: { type: "ticket", ref: "ACME-1" },
    });

    await h.desk.add(notice({ prs: [PR9] }), "e:pr");
    await h.pass(31 * 60_000);
    await h.desk.flush();
    expect(h.sent).toEqual([]);
  });

  it("goes while unrelated work is queued: another ticket, another agent, or work that is not on the ticket", async () => {
    const h = deskHarness();
    h.item({
      id: "w2",
      kind: "assigned",
      status: "queued",
      subject: { type: "ticket", ref: "ACME-2" },
    });

    h.item({
      id: "w3",
      kind: "review_feedback",
      person: "priya",
      status: "queued",
      subject: ON_PR,
    });

    h.item({
      id: "w4",
      kind: "asked",
      status: "queued",
      subject: { type: "ticket", ref: "ACME-1" },
    });

    h.item({ id: "w5", kind: "chat", status: "active" });
    h.item({ id: "w6", kind: "review_feedback", status: "waiting", subject: ON_PR });
    await h.desk.add(FIXED, "e:fixed");
    await h.pass(31_000);
    expect(h.sent).toHaveLength(1);
  });

  it("is dropped when the work is queued while the notice waits for its checks", async () => {
    const h = deskHarness();
    h.pr({ checks: ci("pending") });
    await h.desk.add(FIXED, "e:fixed");
    await h.pass(31_000);
    expect(h.sent).toEqual([]);

    h.item({ id: "w2", kind: "review_feedback", status: "queued", subject: ON_PR });
    h.pr({ checks: ci("success") });
    await h.desk.flush();
    expect(h.sent).toEqual([]);
    expect(h.logged.some((l) => l.includes("superseded by w2"))).toBe(true);
    expect(h.subjects.get("handoff_notified/ACME-1")).toBeUndefined();
  });

  it("matches a pull request without a ticket by its own reference", async () => {
    const h = deskHarness();
    h.item({ id: "w2", kind: "rebase", status: "queued", subject: ON_PR });
    await h.desk.add(notice({ ticket: undefined, prs: [PR9] }), "e:pr");
    await h.pass(31_000);
    expect(h.sent).toEqual([]);
    expect(h.logged).toContain(
      "notify: nothing sent to ada.admin about acme/shop#9: superseded by w2 (rebase on acme/shop#9)",
    );
  });
});

describe("a blocked notice", () => {
  const BLOCKED = notice({ need: "blocked", text: "Needs the key." });
  const onTicket = { type: "ticket", ref: "ACME-1" };

  it("is dropped by the reply to the block: work a human started on the ticket since", async () => {
    const h = deskHarness();
    await h.desk.add(BLOCKED, "e:blocked");
    await h.pass(1_000);
    h.item({ id: "w2", kind: "assigned", status: "queued", subject: onTicket, trigger: "human" });
    await h.pass(31_000);
    expect(h.sent).toEqual([]);
    expect(h.logged.some((l) => l.includes("superseded by w2"))).toBe(true);
  });

  it("goes while other work on the ticket is queued: automation, or queued before the block", async () => {
    const h = deskHarness();
    h.item({ id: "w1", kind: "assigned", status: "queued", subject: onTicket, trigger: "human" });
    await h.pass(1_000);
    await h.desk.add(BLOCKED, "e:blocked");
    h.item({
      id: "w2",
      kind: "ci_failed",
      status: "queued",
      subject: ON_PR,
      trigger: "automation",
    });

    await h.pass(31_000);
    expect(h.sent).toHaveLength(1);
  });
});

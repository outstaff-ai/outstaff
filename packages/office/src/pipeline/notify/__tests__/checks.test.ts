import { describe, expect, it } from "vitest";
import { deskHarness, notice, PR9 } from "./support.js";

const HAND_BACK = notice({
  prs: [{ ...PR9, title: "Add a greeting" }],
  text: "Fixed the build.",
  seen: { human: "ada.admin", prs: { "acme/shop#9": "a1b2c3d4e5" } },
});

const RULES = { branch: "main", requiredChecks: ["ci"], requiredApprovals: 1, upToDate: false };
const ci = (status: "pending" | "success" | "failure") => [{ name: "ci", status }];
const LINE =
  "U0ADA: Ready for your review: [ACME-1](https://tracker.example/ACME-1) Add a greeting, pull request [acme/shop#9](https://github.example/acme/shop/pull/9)";

describe("a review notice held for the pull request's checks", () => {
  it("waits while the checks run, then goes once they pass, naming the head", async () => {
    const h = deskHarness();
    h.pr({ checks: ci("pending") });
    await h.desk.add(HAND_BACK, "e:back");
    await h.pass(31_000);
    await h.pass(60_000);
    await h.desk.flush();
    expect(h.sent).toEqual([]);
    expect(h.logged).toContain(
      "notify: sam holds the notice to ada.admin about ACME-1: checks still running on acme/shop#9 at a1b2c3d",
    );

    h.pr({ checks: ci("success") });
    await h.desk.flush();
    await h.desk.flush();
    expect(h.bodies()).toEqual([[`${LINE} (checks passed on a1b2c3d)\nFixed the build.`]]);
    expect(h.subjects.get("handoff_notified/ACME-1")?.data).toEqual({
      human: "ada.admin",
      prs: { "acme/shop#9": "a1b2c3d4e5" },
    });
  });

  it("sends nothing when the checks fail: ci_failed wakes the author", async () => {
    const h = deskHarness();
    h.pr({ checks: ci("pending") });
    await h.desk.add(HAND_BACK, "e:back");
    await h.pass(31_000);
    h.pr({ checks: ci("failure") });
    await h.desk.flush();
    h.pr({ checks: ci("success") });
    await h.desk.flush();
    expect(h.sent).toEqual([]);
    expect(h.logged).toContain(
      "notify: nothing sent to ada.admin about ACME-1: checks failed on acme/shop#9 at a1b2c3d: ci_failed wakes the author",
    );

    expect(h.subjects.get("handoff_notified/ACME-1")).toBeUndefined();
  });

  it("waits for the new head's checks when the head moves while it is held", async () => {
    const h = deskHarness();
    h.pr({ checks: ci("pending") });
    await h.desk.add(HAND_BACK, "e:back");
    await h.pass(31_000);
    h.pr({ head: "f00dfeed99", checks: ci("pending") });
    await h.desk.flush();
    expect(h.sent).toEqual([]);

    h.pr({ head: "f00dfeed99", checks: ci("success") });
    await h.desk.flush();
    expect(h.bodies()).toEqual([[`${LINE} (checks passed on f00dfee)\nFixed the build.`]]);
    expect(h.subjects.get("handoff_notified/ACME-1")?.data).toEqual({
      human: "ada.admin",
      prs: { "acme/shop#9": "f00dfeed99" },
    });
  });

  it("counts only the checks the merge rules require, for a pull request into the ruled branch", async () => {
    const h = deskHarness({ rules: RULES });
    h.pr({ checks: [{ name: "lint", status: "failure" }, ...ci("success")] });
    await h.desk.add(HAND_BACK, "e:back");
    await h.pass(31_000);
    expect(h.sent).toHaveLength(1);

    const stacked = deskHarness({ rules: RULES });
    stacked.pr({
      base: "feat/base",
      checks: [{ name: "lint", status: "failure" }, ...ci("success")],
    });

    await stacked.desk.add(HAND_BACK, "e:back");
    await stacked.pass(31_000);
    expect(stacked.sent).toEqual([]);
  });

  it("counts every check when the merge rules cannot be read", async () => {
    const h = deskHarness({
      rules: () => {
        throw new Error("forbidden");
      },
    });

    h.pr({ checks: [{ name: "lint", status: "pending" }, ...ci("success")] });
    await h.desk.add(HAND_BACK, "e:back");
    await h.pass(31_000);
    expect(h.sent).toEqual([]);
    expect(h.logged).toContain("notify: could not read the merge rules, so every check counts");
  });

  it("tells the human of a head once: a later hand-back on the head they were told of sends nothing", async () => {
    const h = deskHarness();
    h.pr({ checks: ci("success") });
    await h.desk.add(HAND_BACK, "e:back");
    await h.pass(31_000);
    await h.pass(60 * 60_000);
    await h.desk.add(HAND_BACK, "e:back-again");
    await h.pass(31_000);
    expect(h.sent).toHaveLength(1);
    expect(h.logged).toContain(
      "notify: nothing sent to ada.admin about ACME-1: ada.admin was told of ACME-1 at these heads already",
    );
  });

  it("names the head only of the pull requests whose checks passed, and records it for the ticket", async () => {
    const h = deskHarness();
    h.pr({ checks: ci("success") });
    await h.desk.add(notice({ prs: [PR9, { ref: "acme/shop#12" }] }), "e:opened");
    await h.pass(31_000);
    expect(h.bodies()).toEqual([
      [
        "U0ADA: Ready for your review: [ACME-1](https://tracker.example/ACME-1) Add a greeting, pull request [acme/shop#9](https://github.example/acme/shop/pull/9) (checks passed on a1b2c3d), acme/shop#12",
      ],
    ]);

    expect(h.subjects.get("handoff_notified/ACME-1")?.data).toEqual({
      human: "ada.admin",
      prs: { "acme/shop#9": "a1b2c3d4e5" },
    });
  });

  it("notifies as before with no checks on the head, or no open pull request the state knows", async () => {
    const h = deskHarness();
    h.pr({});
    await h.desk.add(HAND_BACK, "e:back");
    await h.desk.add(notice({ ticket: "ACME-2", prs: [{ ref: "acme/shop#12" }] }), "e:other");
    await h.pass(31_000);
    expect(h.bodies()).toEqual([
      [
        [
          "U0ADA: Waiting for you:",
          "- Ready for your review: [ACME-1](https://tracker.example/ACME-1) Add a greeting, pull request [acme/shop#9](https://github.example/acme/shop/pull/9)",
          "  Fixed the build.",
          "- Ready for your review: [ACME-2](https://tracker.example/ACME-2), pull request acme/shop#12",
        ].join("\n"),
      ],
    ]);
  });

  it("drops a held notice whose pull requests closed meanwhile, and sends the others of the message", async () => {
    const h = deskHarness();
    h.pr({ checks: ci("pending") });
    await h.desk.add(HAND_BACK, "e:back");
    await h.desk.add(notice({ ticket: "ACME-2", need: "blocked", text: "Needs the key." }), "e:2");
    await h.pass(31_000);
    expect(h.bodies()).toEqual([
      ["U0ADA: Blocked, needs you: [ACME-2](https://tracker.example/ACME-2)\nNeeds the key."],
    ]);

    h.pr({ state: "merged", checks: ci("pending") });
    await h.desk.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.logged).toContain(
      "notify: nothing sent to ada.admin about ACME-1: no pull request of ACME-1 it names is open any more",
    );
  });

  it("holds the reply in the chat thread the ticket's work is tied to as well", async () => {
    const h = deskHarness();
    h.item({ id: "chat-1", kind: "chat", with: "U0ADA" });
    h.item({ id: "w-1", kind: "assigned", parentId: "chat-1", on: { ticket: "ACME-1" } });
    h.pr({ checks: ci("pending") });
    await h.desk.add(HAND_BACK, "e:back");
    await h.pass(31_000);
    expect(h.sent).toEqual([]);

    h.pr({ checks: ci("success") });
    await h.desk.flush();
    expect(h.sent.map((s) => s.act.ops[0])).toMatchObject([
      {
        op: "chat_reply",
        thread: "chat-1",
        body: expect.stringContaining("(checks passed on a1b2c3d)"),
      },
    ]);
  });

  it("re-reads the pull requests of a held ticket from the code host, at most every 30 seconds", async () => {
    const h = deskHarness();
    h.pr({ checks: ci("pending") });
    h.pr({ number: 7, ticket: "ACME-BROKEN", checks: ci("pending") });
    await h.desk.add(HAND_BACK, "e:back");
    await h.desk.add(notice({ ticket: "ACME-BROKEN", prs: [{ ref: "acme/shop#7" }] }), "e:b");
    await h.pass(31_000);
    await h.desk.flush();
    await h.pass(31_000);
    await h.desk.flush();
    expect(h.refreshes).toEqual(["ACME-1", "ACME-BROKEN", "ACME-1", "ACME-BROKEN"]);
    expect(h.logged).toContain("notify: could not re-read the pull requests");
  });
});

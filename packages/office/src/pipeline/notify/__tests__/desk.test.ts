import { describe, expect, it } from "vitest";
import { deskHarness, notice, PR9 } from "./support.js";

const HAND_BACK = notice({ prs: [PR9], text: "Added the greeting. <@U0BOSS> please look." });

describe("the notice desk", () => {
  it("sends a pull request opened and the hand-back of the same round as one direct message, from the agent", async () => {
    const h = deskHarness();
    await h.desk.add(notice({ prs: [PR9] }), "e:pr");
    await h.pass(10_000);
    await h.desk.add(HAND_BACK, "e:back");
    await h.pass(25_000);
    expect(h.sent).toEqual([]);

    await h.pass(10_000);
    expect(h.sent).toMatchObject([
      { person: "sam", act: { id: "notify:e:pr:sam:ada.admin", event: "e:pr" } },
    ]);

    expect(h.bodies()).toEqual([
      [
        "U0ADA: Ready for your review: [ACME-1](https://tracker.example/ACME-1) Add a greeting, pull request [acme/shop#9](https://github.example/acme/shop/pull/9)\nAdded the greeting. @U0BOSS please look.",
      ],
    ]);

    expect(h.logged).toContain("notify: sam tells ada.admin in chat");
  });

  it("holds a notice while the agent's round on the ticket runs, then sends it", async () => {
    const h = deskHarness();
    h.rounds.add("sam/ACME-1");
    await h.desk.add(notice({ prs: [PR9] }), "e:pr");
    await h.pass(60_000);
    expect(h.sent).toEqual([]);

    h.rounds.delete("sam/ACME-1");
    await h.desk.flush();
    expect(h.sent).toHaveLength(1);
  });

  it("sends a round that never ends after the longest hold", async () => {
    const h = deskHarness();
    h.rounds.add("sam/ACME-1");
    await h.desk.add(notice(), "e:pr");
    await h.pass(31 * 60_000);
    await h.desk.flush();
    expect(h.sent).toHaveLength(1);
  });

  it("lists a human's several tickets in one message, and writes to each human apart", async () => {
    const h = deskHarness();
    await h.desk.add(HAND_BACK, "e:1");
    await h.desk.add(notice({ ticket: "ACME-2", need: "blocked", text: "Needs the key." }), "e:2");
    await h.desk.add(notice({ human: "mona", ticket: "ACME-3" }), "e:3");
    await h.pass(31_000);
    expect(h.bodies()).toEqual([
      [
        [
          "U0ADA: Waiting for you:",
          "- Ready for your review: [ACME-1](https://tracker.example/ACME-1) Add a greeting, pull request [acme/shop#9](https://github.example/acme/shop/pull/9)",
          "  Added the greeting. @U0BOSS please look.",
          "- Blocked, needs you: [ACME-2](https://tracker.example/ACME-2)",
          "  Needs the key.",
        ].join("\n"),
      ],
      ["U0MONA: Ready for your review: [ACME-3](https://tracker.example/ACME-3)"],
    ]);
  });

  it("lists every ticket one hand-back gave the human, and adds the event delivered again once", async () => {
    const h = deskHarness();
    const sub = notice({ ticket: "ACME-2", prs: [{ ref: "acme/shop#11" }] });
    for (const n of [HAND_BACK, sub, HAND_BACK, sub]) {
      await h.desk.add(n, "e:back");
    }

    await h.pass(31_000);
    expect(h.bodies()).toEqual([
      [
        [
          "U0ADA: Waiting for you:",
          "- Ready for your review: [ACME-1](https://tracker.example/ACME-1) Add a greeting, pull request [acme/shop#9](https://github.example/acme/shop/pull/9)",
          "  Added the greeting. @U0BOSS please look.",
          "- Ready for your review: [ACME-2](https://tracker.example/ACME-2), pull request acme/shop#11",
        ].join("\n"),
      ],
    ]);
  });

  it("sends nothing to a human without a chat identity, and logs it", async () => {
    const h = deskHarness();
    await h.desk.add(notice({ human: "grace.lead" }), "e:1");
    await h.pass(31_000);
    expect(h.sent).toEqual([]);
    expect(h.logged).toContain(
      "notify: grace.lead has no chat identity (humans[].identities.chat): nothing sent",
    );
  });

  it("adds an event delivered again once, and does not tell a pull request again within the hour", async () => {
    const h = deskHarness();
    await h.desk.add(HAND_BACK, "e:back");
    await h.desk.add(HAND_BACK, "e:back");
    await h.pass(31_000);
    expect(h.sent).toHaveLength(1);
    expect(h.bodies()[0]![0]!.match(/acme\/shop#9/g)).toHaveLength(1);

    // The pull request's own event came late: it was told with the hand-back.
    await h.desk.add(notice({ prs: [PR9] }), "e:pr");
    await h.desk.add(HAND_BACK, "e:back");
    await h.pass(31_000);
    expect(h.sent).toHaveLength(1);

    // A new hand-back is news, whatever it links.
    await h.desk.add(HAND_BACK, "e:back-2");
    await h.pass(31_000);
    expect(h.sent).toHaveLength(2);
  });

  it("drops what it holds for a ticket whose human was told in the chat thread the work came from", async () => {
    const h = deskHarness();
    await h.desk.add(notice({ prs: [PR9] }), "e:pr");
    await h.desk.add(notice({ ticket: "ACME-2" }), "e:other");
    await h.desk.add(notice({ prs: [PR9], told: true }), "e:back");
    await h.desk.add(notice({ prs: [PR9] }), "e:pr-late");
    await h.pass(31_000);
    expect(h.bodies()).toEqual([
      ["U0ADA: Ready for your review: [ACME-2](https://tracker.example/ACME-2)"],
    ]);
  });

  it("says what is needed from the agent's latest comment when a ticket is given to a human with no hand-back", async () => {
    const author = (id: string) => ({ id, name: id, kind: "agent" as const });
    const comment = (id: string, by: string, body: string, at: string) => ({
      id,
      author: author(by),
      body,
      url: "",
      at,
    });

    const h = deskHarness({
      comments: [
        comment("2", "u-priya", "Needs a human: the staging key.", "2030-01-01T00:02:00Z"),
        comment("1", "u-priya", "Looking into it.", "2030-01-01T00:01:00Z"),
        comment("3", "u-sam", "Blocked.", "2030-01-01T00:03:00Z"),
      ],
    });

    await h.desk.add(notice({ as: "priya", need: "blocked" }), "e:assigned");
    await h.pass(31_000);
    expect(h.bodies()).toEqual([
      [
        "U0ADA: Blocked, needs you: [ACME-1](https://tracker.example/ACME-1) Add a greeting\nNeeds a human: the staging key.",
      ],
    ]);
  });

  it("sends the line alone when the tracker cannot be read, and logs it", async () => {
    const h = deskHarness();
    await h.desk.add(notice({ as: "priya", need: "blocked" }), "e:assigned");
    await h.pass(31_000);
    expect(h.bodies()).toEqual([
      ["U0ADA: Blocked, needs you: [ACME-1](https://tracker.example/ACME-1) Add a greeting"],
    ]);

    expect(h.logged).toContain("notify: could not read the ticket's comments");
  });

  it("keeps a notice its agent could not be handed, for the next flush", async () => {
    const h = deskHarness({ failSend: 1 });
    await h.desk.add(HAND_BACK, "e:back");
    await h.pass(31_000);
    expect(h.sent).toEqual([]);
    expect(h.logged).toContain("notify: could not hand a notice to its agent");

    await h.desk.flush();
    expect(h.sent).toHaveLength(1);
  });

  it("cancels its timers when the office stops; what it holds goes after the next start", async () => {
    const h = deskHarness();
    await h.desk.add(HAND_BACK, "e:back");
    h.desk.stop();
    await h.pass(31_000);
    expect(h.sent).toEqual([]);

    await h.desk.flush();
    expect(h.sent).toHaveLength(1);
  });
});

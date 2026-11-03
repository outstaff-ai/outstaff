import { describe, expect, it } from "vitest";
import { debounceSeconds } from "#/pipeline/notify/desk.js";
import { deskHarness, notice, PR9 } from "./support.js";

describe("the notice desk at its edges", () => {
  it("keeps the book when the store fails, and sends on the next flush", async () => {
    const h = deskHarness({ failStore: 1 });
    await expect(h.desk.add(notice({ text: "Done." }), "e:1")).rejects.toThrow("store down");
    await h.desk.add(notice({ text: "Done." }), "e:1");
    await h.pass(31_000);
    expect(h.sent).toHaveLength(1);
  });

  it("logs a flush the store fails, and sends what it holds on the next one", async () => {
    const h = deskHarness();
    await h.desk.add(notice({ text: "Done." }), "e:1");
    h.breakStore(1);
    await h.pass(31_000);
    expect(h.logged).toContain("notify: could not send the held notices");

    // The message went out before the write failed; the hold is kept, and the act desk takes the same id once.
    await h.desk.flush();
    expect(h.sent.map((x) => x.act.id)).toEqual([
      "notify:e:1:sam:ada.admin",
      "notify:e:1:sam:ada.admin",
    ]);
  });

  it("joins a notice to its own human's held ones, beside another human's", async () => {
    const h = deskHarness();
    await h.desk.add(notice({ text: "One." }), "e:1");
    await h.desk.add(notice({ human: "mona", text: "Two." }), "e:2");
    await h.desk.add(notice({ ticket: "ACME-2", text: "Three." }), "e:3");
    await h.pass(31_000);
    expect(h.sent.map((s) => s.act.id)).toEqual([
      "notify:e:1:sam:ada.admin",
      "notify:e:2:sam:mona",
    ]);
  });

  it("drops the whole hold of a human told in the chat thread, and leaves another human's alone", async () => {
    const h = deskHarness();
    await h.desk.add(notice(), "e:pr");
    await h.desk.add(notice({ human: "mona" }), "e:mona");
    await h.desk.add({ ...notice({ told: true }), prs: undefined }, "e:back");
    await h.pass(31_000);
    expect(h.sent.map((s) => s.act.id)).toEqual(["notify:e:mona:sam:mona"]);
  });

  it("tells a pull request without a ticket once within the hour", async () => {
    const h = deskHarness();
    const prOnly = { ...notice({ prs: [PR9] }), ticket: undefined };
    await h.desk.add(prOnly, "e:1");
    await h.pass(31_000);
    await h.desk.add({ ...prOnly, need: "blocked" }, "e:2");
    await h.desk.add({ ...notice(), ticket: undefined, prs: undefined }, "e:3");
    await h.pass(31_000);
    // The pull request was told already, and a notice that names nothing has nothing to tell.
    expect(h.bodies()).toEqual([
      [
        "U0ADA: Ready for your review: pull request [acme/shop#9](https://github.example/acme/shop/pull/9)",
      ],
    ]);
  });

  it("goes without links and comments when the office has no tracker", async () => {
    const h = deskHarness({ noTracker: true });
    await h.desk.add(notice({ as: "mira", need: "blocked" }), "e:1");
    await h.desk.add(notice({ as: "mira", ticket: "ACME-2", text: "Done." }), "e:2");
    await h.pass(31_000);
    expect(h.bodies()).toEqual([
      [
        [
          "U0ADA: Waiting for you:",
          "- Blocked, needs you: ACME-1 Add a greeting",
          "- Ready for your review: ACME-2",
          "  Done.",
        ].join("\n"),
      ],
    ]);
  });

  it("reads the latest comment of an agent with no tracker identity by its handle", async () => {
    const h = deskHarness({
      comments: [
        {
          id: "1",
          author: { id: "x", name: "Mira", username: "mira", kind: "agent" },
          body: "Needs a key.",
          url: "",
          at: "2030-01-01T00:00:00Z",
        },
      ],
    });

    await h.desk.add(notice({ as: "mira", need: "blocked" }), "e:1");
    await h.pass(31_000);
    expect(h.bodies()[0]![0]).toContain("\nNeeds a key.");
  });
});

describe("debounceSeconds", () => {
  it("is the team's setting, else a minute, or longer than one poll", () => {
    expect(debounceSeconds({ pipeline: { notify: { debounce_seconds: 5 } } } as never)).toBe(5);
    expect(debounceSeconds({} as never)).toBe(60);
    expect(debounceSeconds({ office: { poll_interval_seconds: 60 } } as never)).toBe(75);
  });
});

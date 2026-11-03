import { describe, expect, it } from "vitest";
import type { Run } from "#/store/runs.types.js";
import { deskHarness, notice } from "./support.js";

const AT = "2030-01-01T00:00:00.000Z";
const run = (startedAt: string, finishedAt: string | null): Run =>
  ({ id: "r", workItemId: "", startedAt, finishedAt }) as Run;

const assigned = notice({ need: "review" });

describe("an assignment made in a chat session", () => {
  it("tells nothing to the human who asked for it in their chat with the agent", async () => {
    const h = deskHarness();
    h.item({ id: "c1", kind: "chat", with: "U0ADA", runs: [run(AT, null)] });
    await h.desk.add(assigned, "e:1", AT);
    await h.pass(31_000);
    expect(h.sent).toEqual([]);
    expect(h.logged).toContain("notify: ada.admin asked sam for it in chat: nothing sent");
  });

  it("still tells a human the agent's chat session with someone else gave it to", async () => {
    const h = deskHarness();
    h.item({ id: "c1", kind: "chat", with: "U0MONA", runs: [run(AT, null)] });
    await h.desk.add(assigned, "e:1", AT);
    await h.pass(31_000);
    expect(h.sent).toHaveLength(1);
  });

  it("counts only a chat session under way at the change, made within the day", async () => {
    const h = deskHarness();
    h.item({ id: "w1", kind: "assigned", with: "U0ADA", runs: [run(AT, null)] });
    h.item({ id: "c-old", kind: "chat", with: "U0ADA", updatedAt: "2029-12-30T00:00:00.000Z" });
    h.item({
      id: "c-done",
      kind: "chat",
      with: "U0ADA",
      runs: [
        run("2029-12-31T23:00:00.000Z", "2029-12-31T23:01:00.000Z"),
        run("2030-01-01T00:01:00.000Z", null),
      ],
    });

    h.item({ id: "c-mona", kind: "chat", person: "priya", with: "U0ADA", runs: [run(AT, null)] });
    await h.desk.add(assigned, "e:1", AT);
    await h.pass(31_000);
    expect(h.sent).toHaveLength(1);
  });

  it("does not look for a hand-back, an event with no time, or a human with no chat", async () => {
    const h = deskHarness();
    h.item({ id: "c1", kind: "chat", with: "U0ADA", runs: [run(AT, null)] });
    await h.desk.add(notice({ text: "Done." }), "e:1", AT);
    await h.desk.add(notice({ ticket: "ACME-2" }), "e:2");
    await h.desk.add(notice({ human: "grace.lead", ticket: "ACME-3" }), "e:3", AT);
    await h.pass(31_000);
    expect(h.sent).toHaveLength(1);
    expect(h.bodies()[0]![0]).toContain("ACME-2");
  });
});

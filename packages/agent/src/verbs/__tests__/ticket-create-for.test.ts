import { describe, expect, it } from "vitest";
import { findVerb, runVerb } from "#/verbs/index.js";
import { fakeEnv } from "@outstaff/testing.agent";

/** A chat session of sam's, on a tracker where sam (by the identity team.yaml gives them) and noor are members. */
async function chatSession() {
  const f = fakeEnv();
  f.office.work = async () => [{ id: "c1", title: "Chat", status: "active", kind: "chat" }];
  const sam = await f.tracker.seed.member({ name: "Sam Duarte", kind: "agent" });
  const noor = await f.tracker.seed.member({ name: "Noor Haddad", kind: "agent" });
  const members = f.tracker.members.bind(f.tracker);
  f.tracker.members = async () =>
    (await members()).map((m) => (m.id === sam.id ? { ...m, username: "sam.duarte" } : m));

  const create = (input: Record<string, unknown>) =>
    runVerb(
      findVerb("ticket.create")!,
      f.env,
      { title: "Rotate the staging keys", body: "Ada asked.", ...input },
      { workItemId: "c1" },
    );

  return { ...f, sam, noor, create };
}

describe("ticket.create from a chat session", () => {
  it("files a ticket for someone else as theirs: assigned to them, recorded against the request, no work item for the caller", async () => {
    const f = await chatSession();
    const r = await f.create({ assignee: "Noor Haddad" });

    const issue = await f.tracker.getIssue("SHOP-1");
    expect(issue.assignee?.id).toBe(f.noor.id);
    expect(issue.status.canonical).toBe("ready");
    expect(f.office.linked).toEqual([]);
    expect(f.office.filedFor).toEqual([
      {
        workItemId: "c1",
        ticket: "SHOP-1",
        request: "Rotate the staging keys",
        assignee: "Noor Haddad",
      },
    ]);

    expect(f.office.checked).toEqual([{ workItemId: "c1", request: "Rotate the staging keys" }]);
    expect(r.text).toContain("Filed for Noor Haddad");
    expect(r.text).toContain("Your chat work is not tied to it");
    expect(r.text).not.toContain("Filed as work item");
    expect(r.data).toMatchObject({ filedFor: "Noor Haddad" });
  });

  it("files a ticket for the caller as their work, with no assignee or one that names them", async () => {
    for (const assignee of [undefined, "me", "sam.duarte"]) {
      const f = await chatSession();
      const r = await f.create(assignee ? { assignee } : {});

      expect((await f.tracker.getIssue("SHOP-1")).assignee?.id).toBe(f.sam.id);
      expect(f.office.linked).toEqual([
        { workItemId: "c1", ticket: "SHOP-1", request: "Rotate the staging keys" },
      ]);

      expect(f.office.filedFor).toEqual([]);
      expect(r.text).toContain("Filed as work item");
    }
  });

  it("files nothing in the tracker when the office refuses the filing", async () => {
    const f = await chatSession();
    f.office.checkFiling = async () => {
      throw new Error("This chat message already filed it.");
    };

    await expect(f.create({ assignee: "Noor Haddad" })).rejects.toThrow(/already filed/);
    await expect(f.tracker.getIssue("SHOP-1")).rejects.toMatchObject({ code: "not_found" });
    expect(f.office.filedFor).toEqual([]);
  });
});

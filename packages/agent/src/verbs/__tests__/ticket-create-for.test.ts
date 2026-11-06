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

  it("starts a ticket blocked on an open ticket blocked, files it for nobody now, and says who is woken when", async () => {
    const f = await chatSession();
    const plan = await f.tracker.createIssue({
      title: "Plan the store",
      body: "",
      status: "active",
    });

    const r = await f.create({ assignee: "Noor Haddad", blockedBy: [plan.key] });

    const issue = await f.tracker.getIssue("SHOP-2");
    expect(issue.status.canonical).toBe("blocked");
    expect(issue.assignee?.id).toBe(f.noor.id);
    expect(f.office.linked).toEqual([]);
    expect(f.office.filedFor).toMatchObject([{ ticket: "SHOP-2", assignee: "Noor Haddad" }]);
    expect(r.text).toContain(
      `It starts blocked on ${plan.key}: Noor Haddad is woken on it when the last one closes, not now.`,
    );
  });

  it("files the caller's own ticket that starts blocked as no work item: the close of its last blocker wakes them", async () => {
    const f = await chatSession();
    const plan = await f.tracker.createIssue({
      title: "Plan the store",
      body: "",
      status: "ready",
    });

    const r = await f.create({ blockedBy: [plan.key], say: "Will do once the plan is done." });

    const issue = await f.tracker.getIssue("SHOP-2");
    expect(issue.status.canonical).toBe("blocked");
    expect(issue.assignee?.id).toBe(f.sam.id);
    expect(f.office.linked).toEqual([]);
    expect(f.office.filedFor).toMatchObject([{ ticket: "SHOP-2", assignee: "sam.duarte" }]);
    expect(r.text).toContain("Filed as your ticket.");
    expect(r.text).toContain(
      `It starts blocked on ${plan.key}: you are woken on it when the last one closes`,
    );
  });

  it("starts a ticket ready and files it as work when every blocker is closed", async () => {
    const f = await chatSession();
    const plan = await f.tracker.createIssue({ title: "Plan the store", body: "", status: "done" });
    await f.create({ blockedBy: [plan.key] });

    expect((await f.tracker.getIssue("SHOP-2")).status.canonical).toBe("ready");
    expect(f.office.linked).toMatchObject([{ ticket: "SHOP-2" }]);
    expect(f.office.filedFor).toEqual([]);
  });

  it("files a ticket for later in the backlog as no work item: it waits there, and the session is told to leave it", async () => {
    for (const assignee of [undefined, "Noor Haddad"]) {
      const f = await chatSession();
      const r = await f.create({ status: "backlog", ...(assignee ? { assignee } : {}) });

      const issue = await f.tracker.getIssue("SHOP-1");
      expect(issue.status.canonical).toBe("backlog");
      expect(f.office.linked).toEqual([]);
      expect(f.office.filedFor).toMatchObject([
        { ticket: "SHOP-1", assignee: assignee ?? "sam.duarte" },
      ]);

      expect(r.text).toContain("Filed in the backlog for later");
      expect(r.text).toContain("Do not work on it, link blockers to it or move it");
      expect(r.text).not.toContain("Filed as work item");
    }
  });
});

import { PortError } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { findVerb, runVerb } from "#/verbs/index.js";
import { fakeEnv } from "@outstaff/testing.agent";

/** The acme team's tracker, with the members team.yaml names; the office gives each role to its first person. */
async function team() {
  const f = fakeEnv();
  const noor = await f.tracker.seed.member({ name: "Noor Haddad", username: "noor.haddad" });
  const kofi = await f.tracker.seed.member({ name: "Kofi Mensah", username: "kofi.mensah" });
  const sam = await f.tracker.seed.member({ name: "Sam Duarte", username: "sam.duarte" });
  const routes: Record<string, string> = { developer: "noor", devops: "kofi" };
  f.office.resolveRole = async (role) => {
    f.office.rolesResolved.push(role);
    const handle = routes[role];
    if (!handle) {
      throw new PortError("not_found", `no ${role} on this team; ask a human`);
    }

    return handle;
  };

  const run = (name: string, input: Record<string, unknown>, workItemId?: string) =>
    runVerb(findVerb(name)!, f.env, input, workItemId ? { workItemId } : {});

  return { ...f, noor, kofi, sam, run };
}

describe("assigning by role", () => {
  it("creates a ticket for the person the office gives the role to, and says who", async () => {
    const f = await team();
    const r = await f.run("ticket.create", {
      title: "Track page views on the landing page",
      body: "The app half.",
      assignee: "role:developer",
    });

    expect((await f.tracker.getIssue("SHOP-1")).assignee?.id).toBe(f.noor.id);
    expect(f.office.rolesResolved).toEqual(["developer"]);
    expect(r.text).toContain("Role developer went to noor.");
  });

  it("assigns an existing ticket by role", async () => {
    const f = await team();
    const issue = await f.tracker.createIssue({ title: "Point the DNS at the new host", body: "" });
    const r = await f.run("ticket.assign", { key: issue.key, to: "Role:DevOps" });

    expect((await f.tracker.getIssue(issue.key)).assignee?.id).toBe(f.kofi.id);
    expect(f.office.rolesResolved).toEqual(["devops"]);
    expect(r.text).toContain(`Assigned ${issue.key} to Kofi Mensah (@kofi.mensah).`);
    expect(r.text).toContain("Role devops went to kofi.");
    expect(r.data).toMatchObject({ role: { name: "devops", handle: "kofi" } });
  });

  it("refuses a role nobody has before anything is written", async () => {
    const f = await team();
    await expect(
      f.run("ticket.create", { title: "Draw the logo", body: "", assignee: "role:astronaut" }),
    ).rejects.toThrow("no astronaut on this team; ask a human");

    await expect(f.tracker.getIssue("SHOP-1")).rejects.toMatchObject({ code: "not_found" });

    const issue = await f.tracker.createIssue({ title: "Draw the logo", body: "" });
    await expect(f.run("ticket.assign", { key: issue.key, to: "role:designer" })).rejects.toThrow(
      "no designer on this team; ask a human",
    );

    expect((await f.tracker.getIssue(issue.key)).assignee).toBeUndefined();
  });

  it("refuses a role without a name", async () => {
    const f = await team();
    const issue = await f.tracker.createIssue({ title: "T", body: "" });
    await expect(f.run("ticket.assign", { key: issue.key, to: "role:" })).rejects.toMatchObject({
      code: "invalid",
    });

    expect(f.office.rolesResolved).toEqual([]);
  });

  it("refuses when the person has no tracker member", async () => {
    const f = await team();
    f.office.resolveRole = async () => "mira";
    const issue = await f.tracker.createIssue({ title: "T", body: "" });
    await expect(
      f.run("ticket.assign", { key: issue.key, to: "role:architect" }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: `No tracker member matches mira's tracker identity "mira.okafor".`,
    });
  });

  it("files a chat ticket for the person the role goes to, not as the caller's work", async () => {
    const f = await team();
    f.office.work = async () => [{ id: "c1", title: "Chat", status: "active", kind: "chat" }];
    const r = await f.run(
      "ticket.create",
      { title: "Add a deploy for the landing page", body: "Ada asked.", assignee: "role:devops" },
      "c1",
    );

    expect((await f.tracker.getIssue("SHOP-1")).assignee?.id).toBe(f.kofi.id);
    expect(f.office.linked).toEqual([]);
    expect(f.office.filedFor).toEqual([
      {
        workItemId: "c1",
        ticket: "SHOP-1",
        request: "Add a deploy for the landing page",
        assignee: "kofi.mensah",
      },
    ]);

    expect(r.text).toContain("Role devops went to kofi.");
    expect(r.text).toContain("Filed for kofi.mensah");
  });

  it("files a chat ticket as the caller's own work when the role comes back to them", async () => {
    const f = await team();
    f.office.work = async () => [{ id: "c1", title: "Chat", status: "active", kind: "chat" }];
    f.office.resolveRole = async () => "sam";
    await f.run(
      "ticket.create",
      { title: "Fix the footer", body: "Ada asked.", assignee: "role:developer" },
      "c1",
    );

    expect((await f.tracker.getIssue("SHOP-1")).assignee?.id).toBe(f.sam.id);
    expect(f.office.filedFor).toEqual([]);
    expect(f.office.linked).toHaveLength(1);
  });
});

describe("the fake office", () => {
  it("gives a role to the first teammate with it and refuses one nobody has", async () => {
    const f = fakeEnv();
    expect(await f.office.resolveRole("architect")).toBe("mira");
    await expect(f.office.resolveRole("devops")).rejects.toMatchObject({ code: "not_found" });
    expect(f.office.rolesResolved).toEqual(["architect", "devops"]);
  });
});

import { buildPolicy } from "@outstaff/core";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentLayout } from "#/runner/layout.js";
import { findVerb, runVerb } from "#/verbs/index.js";
import { fakeEnv } from "@outstaff/testing.agent";

const edit = (f: ReturnType<typeof fakeEnv>, input: Record<string, unknown>, ctx = {}) =>
  runVerb(findVerb("ticket.edit")!, f.env, input, ctx);

/** A chat session of sam's, with a file in its scratch directory and no worktree. */
function chatWithFile(text: string) {
  const f = fakeEnv();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ost-ticket-edit-")));
  const layout = agentLayout(root, join(root, "secrets"));
  const dir = join(layout.scratchDir, "c1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "acme-41.md"), text);
  f.env.layout = layout;
  f.env.policy = buildPolicy({
    profile: "chat",
    person: f.env.team.people.find((p) => p.handle === "sam")!,
    team: f.env.team,
    layout,
  });

  return { ...f, root, layout };
}

describe("ticket.edit", () => {
  it("changes the title and leaves the description as it is", async () => {
    const f = fakeEnv();
    const issue = await f.tracker.createIssue({ title: "Use approach A", body: "A or B?" });
    const r = await edit(f, { key: issue.key, title: "Use approach B" });

    expect(await f.tracker.getIssue(issue.key)).toMatchObject({
      title: "Use approach B",
      body: "A or B?",
    });

    expect(r.text).toContain(`Changed the title of ${issue.key}.`);
    expect(r.links).toEqual([f.tracker.links.issue(issue.key)]);
  });

  it("replaces the title and the description together, linking ticket keys", async () => {
    const f = fakeEnv();
    const issue = await f.tracker.createIssue({ title: "Use approach A", body: "A or B?" });
    const r = await edit(f, {
      key: issue.key,
      title: "Use approach B",
      description: "Decision: B, see SHOP-9.",
    });

    const edited = await f.tracker.getIssue(issue.key);
    expect(edited.title).toBe("Use approach B");
    expect(edited.body).toContain(f.tracker.links.issue("SHOP-9"));
    expect(r.text).toContain("Changed the title and description");
  });

  it("reads the description from a file in a chat session's scratch directory", async () => {
    const f = chatWithFile("Decision: B.");
    const issue = await f.tracker.createIssue({ title: "Use approach A", body: "A or B?" });
    await edit(f, { key: issue.key, descriptionFile: "acme-41.md" }, { workItemId: "c1" });
    expect((await f.tracker.getIssue(issue.key)).body).toBe("Decision: B.");
  });

  it("refuses no change, both description forms, a blank title and an unknown ticket", async () => {
    const f = fakeEnv();
    const issue = await f.tracker.createIssue({ title: "T", body: "" });
    await expect(edit(f, { key: issue.key })).rejects.toMatchObject({ code: "invalid" });
    await expect(
      edit(f, { key: issue.key, description: "x", descriptionFile: "x.md" }),
    ).rejects.toMatchObject({ code: "invalid", message: /not both/ });

    await expect(edit(f, { key: issue.key, title: "  " })).rejects.toMatchObject({
      code: "invalid",
    });

    await expect(edit(f, { key: "SHOP-99", title: "x" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("refuses a description file over the tracker's limit", async () => {
    const f = chatWithFile("x".repeat(50_001));
    const issue = await f.tracker.createIssue({ title: "T", body: "" });
    await expect(
      edit(f, { key: issue.key, descriptionFile: "acme-41.md" }, { workItemId: "c1" }),
    ).rejects.toMatchObject({ code: "invalid", message: /over 50000 characters/ });
  });
});

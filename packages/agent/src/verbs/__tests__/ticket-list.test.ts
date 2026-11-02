import { describe, expect, it } from "vitest";
import { findVerb, runVerb } from "#/verbs/index.js";
import { fakeEnv } from "@outstaff/testing.agent";

async function setup() {
  const f = fakeEnv();
  f.env.now = () => new Date("2030-01-01T02:00:00Z");
  const sam = await f.tracker.seed.member({ name: "Sam", username: "sam", kind: "agent" });
  const mira = await f.tracker.seed.member({ name: "Mira", username: "mira", kind: "agent" });
  const tracker = f.tracker;
  const login = await tracker.createIssue({ title: "Fix login", body: "", assignee: sam.id });
  const font = await tracker.createIssue({
    title: "Pick the font",
    body: "",
    labels: ["design"],
    assignee: mira.id,
  });

  const loose = await tracker.createIssue({ title: "Loose end", body: "" });
  const sub = await tracker.createIssue({ title: "Sub task", body: "", parent: login.key });
  await tracker.transition(font.key, "blocked");
  await tracker.transition(sub.key, "done");
  const run = (input: Record<string, unknown> = {}) =>
    runVerb(findVerb("ticket.list")!, f.env, input);

  return { ...f, run, login, font, loose, sub };
}

const keys = (r: { data: unknown }) =>
  (r.data as { issues: { key: string }[] }).issues.map((i) => i.key);

describe("ost ticket list", () => {
  it("lists open tickets by default, most recently updated first, with status, assignee, age and link", async () => {
    const f = await setup();
    const r = await f.run();
    expect(keys(r)).toEqual([f.font.key, f.loose.key, f.login.key]);
    expect(r.text).toMatch(/^Tickets \(status open\), most recently updated first/);
    expect(r.text).toMatch(
      new RegExp(
        `^- ${f.font.key} \\(blocked\\) Pick the font · Mira \\(@mira\\) · updated 2030-01-01 00:00 UTC, 1 h ago · ${f.tracker.links.issue(f.font.key)}$`,
        "m",
      ),
    );

    expect(r.text).toContain(`${f.loose.key} (backlog) Loose end · nobody`);
    expect(r.links).toContain(f.tracker.links.issue(f.login.key));
  });

  it("filters by status, assignee, label, parent and update time", async () => {
    const f = await setup();
    expect(keys(await f.run({ status: "done" }))).toEqual([f.sub.key]);
    expect(keys(await f.run({ status: "blocked, backlog" }))).toEqual([
      f.font.key,
      f.loose.key,
      f.login.key,
    ]);

    expect(keys(await f.run({ status: "all" }))).toHaveLength(4);
    expect(keys(await f.run({ assignee: "me" }))).toEqual([f.login.key]);
    expect(keys(await f.run({ assignee: "mira" }))).toEqual([f.font.key]);
    expect(keys(await f.run({ assignee: "unassigned" }))).toEqual([f.loose.key]);
    expect(keys(await f.run({ label: "design" }))).toEqual([f.font.key]);
    expect(keys(await f.run({ parent: f.login.key, status: "all" }))).toEqual([f.sub.key]);
    const blocked = (await f.tracker.getIssue(f.font.key)).updatedAt;
    expect(keys(await f.run({ since: blocked, status: "all" }))).toEqual([f.sub.key, f.font.key]);
  });

  it("caps the list and says how many more match", async () => {
    const f = await setup();
    const r = await f.run({ limit: 1 });
    expect(keys(r)).toEqual([f.font.key]);
    expect(r.data).toMatchObject({ more: 2 });
    expect(r.text).toContain("…and 2 more. Narrow it with");
  });

  it("says when nothing matches", async () => {
    const f = await setup();
    const r = await f.run({ status: "canceled", label: "design" });
    expect(r.text).toBe("No tickets match (status canceled, label design).");
  });

  it("refuses a status that is not canonical and an unknown member", async () => {
    const f = await setup();
    await expect(f.run({ status: "review,later" })).rejects.toMatchObject({ code: "invalid" });
    await expect(f.run({ assignee: "nobody-here" })).rejects.toMatchObject({ code: "not_found" });
  });
});

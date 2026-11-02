import { silentLogger } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { teamConfig } from "#/intake/__tests__/test-support.js";
import { officeTicketPrs } from "#/office-ticket-prs.js";
import type { PrRecord, WorkState } from "#/workstate/index.js";

const REPO = { host: "git.acme.example", owner: "acme", name: "app" };

function pr(number: number, patch: Partial<PrRecord> = {}): PrRecord {
  return {
    ref: { repo: REPO, number },
    title: `Change ${number}`,
    url: `https://git.acme.example/acme/app/pull/${number}`,
    headRef: `change-${number}`,
    headSha: "abc",
    baseRef: "main",
    draft: false,
    state: "open",
    mergeable: "clean",
    author: { login: "mira-bot[bot]", kind: "agent", person: "mira" },
    checks: [],
    ci: "success",
    unresolvedThreads: 0,
    updatedAt: "2026-01-02T00:00:00Z",
    ...patch,
  };
}

function setup(prs: PrRecord[], catchUp: () => Promise<void> = async () => {}) {
  const workState = {
    catchUp,
    repoPrs: () => prs,
    prSubject: (ref: PrRecord["ref"]) => `${ref.repo.owner}/${ref.repo.name}#${ref.number}`,
  } as unknown as WorkState;

  return officeTicketPrs({ workState, team: teamConfig(), log: silentLogger });
}

const PRS = [
  pr(3, { state: "merged", updatedAt: "2026-01-01T00:00:00Z", ticket: "ACME-1" }),
  pr(4, { state: "closed", updatedAt: "2026-01-03T00:00:00Z" }),
  pr(5, { review: "approved", ticket: "ACME-2" }),
  pr(6, { author: { login: "ada", kind: "human" }, draft: true, ci: "failure" }),
];

describe("the office's pull request list", () => {
  it("lists open ones first, then finished ones most recently read first", async () => {
    const r = await setup(PRS).list("mira", { state: "all", limit: 10 });
    expect(r.prs.map((p) => p.number)).toEqual([6, 5, 4, 3]);
    expect(r.more).toBe(0);
    expect(r.prs[1]).toEqual({
      ref: "acme/app#5",
      number: 5,
      title: "Change 5",
      url: "https://git.acme.example/acme/app/pull/5",
      state: "open",
      draft: false,
      author: "mira",
      ci: "success",
      mergeable: "clean",
      review: "approved",
      unresolvedThreads: 0,
      ticket: "ACME-2",
      updatedAt: "2026-01-02T00:00:00Z",
    });

    expect(r.prs[0]).toMatchObject({ author: "ada", draft: true, ci: "failure" });
    expect(r.prs[0]).not.toHaveProperty("ticket");
  });

  it("filters by state, author, ticket and repository, and counts what the limit leaves out", async () => {
    const list = setup(PRS).list;
    const numbers = async (f: Parameters<typeof list>[1], person = "mira") =>
      (await list(person, f)).prs.map((p) => p.number);

    expect(await numbers({ state: "open", limit: 10 })).toEqual([6, 5]);
    expect(await numbers({ state: "merged", limit: 10 })).toEqual([3]);
    expect(await numbers({ state: "all", author: "me", limit: 10 })).toEqual([5, 4, 3]);
    expect(await numbers({ state: "all", author: "me", limit: 10 }, "ada")).toEqual([6]);
    expect(await numbers({ state: "all", author: "MIRA-BOT", limit: 10 })).toEqual([5, 4, 3]);
    expect(await numbers({ state: "all", ticket: "acme-1", limit: 10 })).toEqual([3]);
    expect(await numbers({ state: "all", repo: "acme/app", limit: 10 })).toHaveLength(4);
    expect(await numbers({ state: "all", repo: "acme/other", limit: 10 })).toEqual([]);
    expect(await list("mira", { state: "all", limit: 1 })).toMatchObject({
      prs: [{ number: 6 }],
      more: 3,
    });
  });

  it("still answers when it cannot look for new pull requests", async () => {
    const r = await setup(PRS, () => Promise.reject(new Error("down"))).list("mira", {
      state: "open",
      limit: 10,
    });

    expect(r.prs).toHaveLength(2);
  });
});

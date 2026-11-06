import { PortError } from "@outstaff/core";
import { fakeEnv } from "@outstaff/testing.agent";
import { describe, expect, it } from "vitest";
import { findVerb, runVerb } from "#/verbs/index.js";
import type { Round } from "#/verbs/types.js";

/** sam, in a round of the given kind and trigger, on a team whose code host sam can write to. */
async function inRound(round: Round | undefined) {
  const f = fakeEnv();
  const repo = f.vcs.seed.repo;
  f.env.team.repos[0]!.url = `${repo.host}/${repo.owner}/${repo.name}`;
  await f.vcs.seed.permission(repo, "sam", "write");
  const env = round ? { ...f.env, round } : f.env;

  const createTicket = () =>
    runVerb(findVerb("ticket.create")!, env, { title: "Add a CI screenshot job" }, {});

  const openPr = () =>
    runVerb(
      findVerb("pr.open")!,
      env,
      { repo: "shop", head: "ci/screenshots", title: "ci: take screenshots", body: "In CI." },
      {},
    );

  return { ...f, repo, createTicket, openPr };
}

async function refusal(p: Promise<unknown>): Promise<PortError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );

  expect(e).toBeInstanceOf(PortError);
  return e as PortError;
}

const refused: [string, Round][] = [
  ["a teammate's question", { kind: "question", trigger: "agent" }],
  ["a teammate's mention", { kind: "asked", trigger: "agent" }],
  ["an unblock", { kind: "unblock", trigger: "agent" }],
];

const onBacklog: [string, Round][] = [
  ["a human's comment", { kind: "ticket_comment", trigger: "human", ticketStatus: "backlog" }],
  ["a human's mention", { kind: "asked", trigger: "human", ticketStatus: "backlog" }],
  ["an assigned ticket", { kind: "assigned", trigger: "human", ticketStatus: "backlog" }],
];

const allowed: [string, Round][] = [
  ["an assigned ticket", { kind: "assigned", trigger: "human" }],
  ["an assigned ticket resumed by a teammate's answer", { kind: "assigned", trigger: "agent" }],
  ["a human's mention", { kind: "asked", trigger: "human" }],
  ["a chat session", { kind: "chat", trigger: "human" }],
  ["a human's comment on the ticket", { kind: "ticket_comment", trigger: "human" }],
  [
    "a human's comment on a ready ticket",
    { kind: "ticket_comment", trigger: "human", ticketStatus: "ready" },
  ],
  [
    "a work round on an active ticket",
    { kind: "assigned", trigger: "human", ticketStatus: "active" },
  ],
  [
    "a human's chat request on a backlog ticket",
    { kind: "chat", trigger: "human", ticketStatus: "backlog" },
  ],
];

describe("only a trusted human starts new work", () => {
  it.each(refused)("refuses a new ticket in %s, before anything is filed", async (_, round) => {
    const f = await inRound(round);
    const e = await refusal(f.createTicket());
    expect(e.code).toBe("forbidden");
    expect(e.message).toMatch(/does not file a ticket: only a trusted human starts new work/);
    expect(e.message).toContain("Put the proposal to a trusted human instead");
    expect(await f.tracker.listIssues({})).toEqual([]);
  });

  it.each(refused)("refuses a pull request in %s, before anything is opened", async (_, round) => {
    const f = await inRound(round);
    const e = await refusal(f.openPr());
    expect(e.code).toBe("forbidden");
    expect(e.message).toMatch(/does not open a pull request: only a trusted human starts new work/);
    expect((await f.vcs.events([f.repo])).events).toEqual([]);
  });

  it("names what started the round", async () => {
    const said = async (round: Round) => (await refusal((await inRound(round)).openPr())).message;
    expect(await said({ kind: "question", trigger: "agent" })).toContain("a teammate's question");
    expect(await said({ kind: "asked", trigger: "agent" })).toContain("a teammate's mention");
    expect(await said({ kind: "unblock", trigger: "agent" })).toContain("an unblock");
  });

  it.each([...allowed, ["no work item", undefined] as [string, undefined]])(
    "files a ticket and opens a pull request in %s",
    async (_, round) => {
      const f = await inRound(round);
      expect((await f.createTicket()).text).toContain("Created SHOP-1.");
      expect((await f.openPr()).text).toContain("Opened");
    },
  );
});

describe("a round on a ticket in backlog starts no new work", () => {
  it.each(onBacklog)(
    "refuses a new ticket and a pull request in %s, before anything is made",
    async (_, round) => {
      const f = await inRound(round);
      const ticket = await refusal(f.createTicket());
      expect(ticket.code).toBe("forbidden");
      expect(ticket.message).toMatch(/on a ticket in backlog, so it does not file a ticket/);
      expect(ticket.message).toContain(
        "moves the ticket to ready or active, or asks for the work in chat",
      );

      expect(ticket.message).toContain("Backlog is not a blocker");
      expect(await f.tracker.listIssues({})).toEqual([]);

      const pr = await refusal(f.openPr());
      expect(pr.message).toMatch(/on a ticket in backlog, so it does not open a pull request/);
      expect((await f.vcs.events([f.repo])).events).toEqual([]);
    },
  );

  it("names a teammate's round first, when a teammate started a round on a ticket in backlog", async () => {
    const f = await inRound({ kind: "asked", trigger: "agent", ticketStatus: "backlog" });
    expect((await refusal(f.createTicket())).message).toContain("a teammate's mention");
  });
});

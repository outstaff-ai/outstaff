import type { Logger, TeamConfig } from "@outstaff/core";
import { createFakeTracker } from "@outstaff/core/fakes";
import type { PayloadOf } from "@outstaff/protocol";
import { describe, expect, it } from "vitest";
import { createActMaker } from "#/runner/acts.js";

const teamOf = (tracker: string) =>
  ({ people: [{ handle: "sam", identities: { tracker } }] }) as TeamConfig;

function harness(answer: () => Promise<void> = async () => {}) {
  const answers: PayloadOf<"act_result">[] = [];
  const logged: string[] = [];
  const log: Logger = {
    debug() {},
    info: (m) => void logged.push(m),
    warn: (m) => void logged.push(m),
    error() {},
  };

  const office = {
    actResult: async (r: PayloadOf<"act_result">) => {
      answers.push(r);
      await answer();
    },
  };

  return { answers, logged, log, office };
}

describe("the act maker", () => {
  it("makes an act's changes as the agent, without a model, and answers it; an act sent again is only answered", async () => {
    const tracker = createFakeTracker({ actor: { id: "u-office", name: "Office", kind: "agent" } });
    const sam = await tracker.seed.member({ name: "Sam", kind: "agent" });
    const issue = await tracker.createIssue({ title: "Search", body: "", status: "active" });
    const h = harness();
    const maker = createActMaker({
      env: { team: teamOf(sam.id), tracker: tracker.as(sam) },
      office: h.office,
      log: h.log,
    });

    const act = {
      id: "e:p",
      ops: [
        { op: "move" as const, ticket: issue.key, to: "review" as const },
        { op: "assign" as const, ticket: issue.key, to: { kind: "agent" as const, id: "sam" } },
        { op: "comment" as const, on: { ticket: issue.key }, body: "Ready for review." },
      ],
    };

    await Promise.all([maker.make([act]), maker.make([act])]);
    const results = [
      `moved ${issue.key} to review`,
      `assigned ${issue.key} to sam`,
      `commented on ${issue.key}`,
    ];

    expect(h.answers).toEqual([
      { id: "e:p", ok: true, results },
      { id: "e:p", ok: true, results },
    ]);

    const history = (await tracker.events()).events.filter((e) => e.type !== "created");
    expect(history.map((e) => [e.type, e.actor.id])).toEqual([
      ["moved", sam.id],
      ["assigned", sam.id],
      ["commented", sam.id],
    ]);

    expect((await tracker.getIssue(issue.key)).assignee?.id).toBe(sam.id);
    expect(h.logged).toEqual(["made an act"]);
  });

  it("links a pull request on its ticket with the agent's own tracker account", async () => {
    const tracker = createFakeTracker({ actor: { id: "u-office", name: "Office", kind: "agent" } });
    const sam = await tracker.seed.member({ name: "Sam", kind: "agent" });
    const repo = { owner: "acme", name: "shop" };
    await tracker.seed.repository!(repo, [7]);
    const issue = await tracker.createIssue({ title: "Search", body: "" });
    const h = harness();
    const maker = createActMaker({
      env: { team: teamOf(sam.id), tracker: tracker.as(sam) },
      office: h.office,
      log: h.log,
    });

    await maker.make([
      { id: "e:link", ops: [{ op: "link_pr", ticket: issue.key, pr: { repo, number: 7 } }] },
    ]);

    expect(h.answers).toEqual([
      { id: "e:link", ok: true, results: [`linked acme/shop#7 on ${issue.key}`] },
    ]);

    expect(tracker.development.get(issue.key)).toEqual([{ repo, number: 7, by: sam.id }]);
  });

  it("answers a change that failed, and keeps the answer for the next delivery when sending it fails", async () => {
    const h = harness(() => Promise.reject(new Error("connection lost")));
    const maker = createActMaker({ env: { team: teamOf("u-sam") }, office: h.office, log: h.log });
    const act = {
      id: "e:p",
      ops: [{ op: "move" as const, ticket: "ACME-1", to: "done" as const }],
    };

    await maker.make([act]);
    await maker.make([act]);

    const failed = {
      id: "e:p",
      ok: false,
      results: [],
      error: "move ACME-1: no tracker is configured",
    };

    expect(h.answers).toEqual([failed, failed]);
    expect(h.logged).toEqual([
      "an act failed",
      "could not answer an act",
      "could not answer an act",
    ]);
  });
});

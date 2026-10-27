import { createOfficeConnection, type OfficeConnection } from "@outstaff/agent";
import {
  AdapterRegistry,
  envSecretSource,
  parseTeamConfig,
  type Member,
  type PortName,
  type TeamConfig,
} from "@outstaff/core";
import {
  createFakeAdapterRegistry,
  createFakeChat,
  createFakeTracker,
  createFakeVcs,
  type FakeTracker,
} from "@outstaff/core/fakes";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "../../../clock.js";
import { createOffice } from "../../../office.js";
import type { Office } from "../../../office.types.js";
import { openStore, type Store } from "../../../store/index.js";
import type { Trace } from "../../trace.types.js";

const OFFICE_ACCOUNT: Member = { id: "u-1", name: "Office", kind: "agent" };

function team(): TeamConfig {
  const result = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    humans: [{ name: "Ada Admin", identities: { vcs: "ada-admin", tracker: "u-ada" } }],
    repos: [{ name: "shop", url: "git.acme.example/acme-example/shop", kind: "primary" }],
    people: [{ handle: "sam", name: "Sam", role: "developer", identities: { tracker: "u-sam" } }],
    integrations: {
      chat: { adapter: "fake" },
      vcs: { adapter: "fake" },
      runtime: { adapter: "fake" },
      tracker: { adapter: "fake" },
    },
    office: { pipeline: "live" },
  });

  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }

  return result.config;
}

/** The fake tracker hands out ids in order; these are the members the team file names. */
async function seedMembers(tracker: FakeTracker) {
  const ada = await tracker.seed.member({ name: "Ada Admin", kind: "human" });
  const sam = await tracker.seed.member({ name: "Sam", kind: "agent" });
  return { ada, sam };
}

describe("the office with the event pipeline live", () => {
  const clock = manualClock();
  let office: Office | undefined;
  let conn: OfficeConnection | undefined;
  let store: Store;

  afterEach(async () => {
    await conn?.stop();
    await office?.stop();
    conn = undefined;
    office = undefined;
  });

  async function start() {
    const vcs = createFakeVcs({ now: clock.now });
    const tracker = createFakeTracker({ now: clock.now, actor: OFFICE_ACCOUNT });
    const { ada, sam } = await seedMembers(tracker);
    const config = team();
    config.humans![0]!.identities.tracker = ada.id;
    config.people[0]!.identities!.tracker = sam.id;
    const chat = createFakeChat({ now: clock.now });
    const stock = createFakeAdapterRegistry();
    const instances = { vcs, tracker, chat } as Record<string, unknown>;
    const registry = new AdapterRegistry();
    for (const port of ["vcs", "tracker", "chat"] as PortName[]) {
      registry.register({ ...stock.get(port, "fake")!, create: () => instances[port] as never });
    }

    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    office = await createOffice({
      team: config,
      registry,
      secrets: envSecretSource({ OUTSTAFF_AGENT_TOKEN_SAM: "sam-token" }, "/nonexistent"),
      store,
      clock,
      options: { agentPort: 0, agentHost: "127.0.0.1" },
    });

    await office.start();
    await office.parts.intake.pollOnce();
    return { tracker, config, ada, sam };
  }

  /** Sam's agent process: its connection to the office. */
  function agent() {
    const c = createOfficeConnection({
      url: `ws://127.0.0.1:${office!.agentPort()}/agent`,
      person: "sam",
      token: "sam-token",
      agentVersion: "test",
      clock,
    });

    c.start();
    return c;
  }

  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 200 && !(await check()); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  const traces = async () => (await store.listTraces({ limit: 200 })).map((t) => t.data as Trace);

  it("wakes the assignee, and makes the hand-back's changes as the office, with a comment saying whom they are for", async () => {
    const { tracker, ada, sam } = await start();
    conn = agent();
    await conn.whenConnected();

    const issue = await tracker.createIssue({
      title: "Search",
      body: "",
      status: "ready",
      assignee: sam.id,
    });

    await tracker.as(ada).assign(issue.key, sam.id);
    await office!.parts.intake.pollOnce();
    const offer = await conn.offers()[Symbol.asyncIterator]().next();
    const item = offer.value!.workItem;
    expect(item).toMatchObject({ kind: "assigned" });
    expect((await store.readJournal(item.id)).map((j) => j.text)).toContain(
      `${issue.key} is assigned to you. Work on it the way the repository asks.`,
    );

    await conn.accept(item.id);
    await conn.handBack(item.id, { summary: "Built it.", status: "done" });
    await until(async () => (await tracker.getIssue(issue.key)).status.canonical === "review");

    const done = await tracker.getIssue(issue.key);
    expect(done.status.canonical).toBe("review");
    expect(done.assignee?.id).toBe(ada.id);
    const history = (await tracker.events()).events.filter((e) => e.key === issue.key);
    const toReview = history.filter((e) => e.type === "moved" && e.data["to"] === "review");
    expect(toReview.map((e) => e.actor.id)).toEqual([OFFICE_ACCOUNT.id]);
    await until(async () => (await tracker.listComments(issue.key)).length > 0);
    expect((await tracker.listComments(issue.key)).map((c) => [c.author.id, c.body])).toEqual([
      [
        OFFICE_ACCOUNT.id,
        "Moved to review and assigned to the requester for sam, who handed the work back as done.",
      ],
    ]);

    await until(async () => (await traces()).some((t) => t.results !== undefined));
    const back = (await traces()).find((t) => t.event.type === "agent.handed_back")!;
    expect(back.results).toEqual({
      [`${back.event.id}:hand_back_done`]: {
        ok: true,
        results: [
          `moved ${issue.key} to review`,
          `assigned ${issue.key} to ${ada.id}`,
          `commented on ${issue.key}`,
        ],
      },
    });
  });
});

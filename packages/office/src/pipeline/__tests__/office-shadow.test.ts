import { createOfficeConnection, type OfficeConnection } from "@outstaff/agent";
import {
  AdapterRegistry,
  envSecretSource,
  parseTeamConfig,
  type PortName,
  type RepoRef,
  type TeamConfig,
} from "@outstaff/core";
import {
  createFakeAdapterRegistry,
  createFakeChat,
  createFakeTracker,
  createFakeVcs,
} from "@outstaff/core/fakes";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { createOffice } from "#/office.js";
import type { Office } from "#/office.types.js";
import { openStore, type Store } from "#/store/index.js";
import type { Trace } from "#/pipeline/trace.types.js";

const REPO: RepoRef = { host: "git.acme.example", owner: "acme", name: "app" };
const SAM_LOGIN = "acme-sam[bot]";

function team(pipeline: "off" | "shadow" | undefined): TeamConfig {
  const result = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    humans: [{ name: "Dana", identities: { vcs: "dana", tracker: "u-1" } }],
    repos: [{ name: "app", url: "git.acme.example/acme/app", kind: "primary" }],
    people: [
      {
        handle: "sam",
        name: "Sam",
        role: "developer",
        identities: { vcs: SAM_LOGIN, tracker: "u-2" },
      },
    ],
    integrations: {
      chat: { adapter: "fake" },
      vcs: { adapter: "fake" },
      runtime: { adapter: "fake" },
      tracker: { adapter: "fake" },
    },
    ...(pipeline ? { office: { pipeline } } : {}),
  });

  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }

  return result.config;
}

describe("the office with the event pipeline in shadow mode", () => {
  const clock = manualClock();
  let office: Office | undefined;
  let conn: OfficeConnection | undefined;

  afterEach(async () => {
    await conn?.stop();
    await office?.stop();
    conn = undefined;
    office = undefined;
  });

  async function start(pipeline: "off" | "shadow" | undefined) {
    const vcs = createFakeVcs({ now: clock.now });
    const tracker = createFakeTracker({
      now: clock.now,
      actor: { id: "u-1", name: "Dana", kind: "human" },
    });

    const chat = createFakeChat({ now: clock.now });
    const stock = createFakeAdapterRegistry();
    const instances = { vcs, tracker, chat } as Record<string, unknown>;
    const registry = new AdapterRegistry();
    for (const port of ["vcs", "tracker", "chat"] as PortName[]) {
      registry.register({ ...stock.get(port, "fake")!, create: () => instances[port] as never });
    }

    await tracker.seed.member({ name: "Sam", kind: "agent" });
    await vcs.seed.permission(REPO, "dana", "write");
    const store: Store = await openStore("sqlite::memory:", { now: () => clock.now() });
    office = await createOffice({
      team: team(pipeline),
      registry,
      secrets: envSecretSource({ OUTSTAFF_AGENT_TOKEN_SAM: "sam-token" }, "/nonexistent"),
      store,
      clock,
      options: { agentPort: 0, agentHost: "127.0.0.1" },
    });

    await office.start();
    await office.parts.intake.pollOnce();
    return { vcs, tracker, store };
  }

  const traces = async (store: Store) => (await store.listTraces()).map((t) => t.data as Trace);

  it("records a trace for intake, work state and hand-back events, and changes nothing the engine does", async () => {
    const { vcs, tracker, store } = await start("shadow");
    expect(office!.parts.pipeline).toBeDefined();

    conn = createOfficeConnection({
      url: `ws://127.0.0.1:${office!.agentPort()}/agent`,
      person: "sam",
      token: "sam-token",
      agentVersion: "test",
      clock,
    });

    conn.start();
    await conn.whenConnected();
    const issue = await tracker.createIssue({
      title: "Search",
      body: "",
      status: "ready",
      assignee: "u-2",
    });

    await office!.parts.intake.pollOnce();
    const offer = await conn.offers()[Symbol.asyncIterator]().next();
    const item = offer.value!.workItem;
    await conn.accept(item.id);
    await conn.handBack(item.id, { summary: "Done.", status: "done" });
    expect((await tracker.getIssue(issue.key)).status.canonical).toBe("review");

    const a = await vcs.seed.pullRequest(REPO, {
      title: "Base",
      head: { ref: "feat/a" },
      author: { login: SAM_LOGIN, kind: "agent" },
    });

    await vcs.seed.pullRequest(REPO, {
      title: "Top",
      head: { ref: "feat/b" },
      base: { ref: "feat/a" },
      author: { login: SAM_LOGIN, kind: "agent" },
      mergeable: ["clean", "conflicting"],
    });

    await office!.parts.intake.pollOnce();
    await vcs.seed.merge(REPO, a.number, "dana");
    await office!.parts.intake.pollOnce();

    const recorded = await traces(store);
    const assigned = recorded.find(
      (t) => t.event.type === "ticket.assigned" || t.event.type === "ticket.created",
    )!;

    expect(assigned.decisions).toMatchObject([{ type: "wake", person: "sam", kind: "assigned" }]);
    // The engine scheduled the same round, so the two agree.
    expect(assigned.engine?.effects).toMatchObject([
      { type: "wake", person: "sam", kind: "assigned" },
    ]);

    expect(assigned.comparison).toEqual({ agree: true, differences: [] });
    const back = recorded.find((t) => t.event.type === "agent.handed_back")!;
    expect(back.event.id).toMatch(/^workstate:handed_back:/);
    expect(back.decisions).toMatchObject([{ type: "act", as: "sam" }]);
    // The engine moved and assigned as the office; the pipeline would make the same changes as sam.
    expect(back.comparison?.agree).toBe(true);
    expect(back.comparison?.differences.map((d) => d.kind)).toEqual([
      "actor_changed",
      "actor_changed",
    ]);

    const conflict = recorded.find((t) => t.event.type === "pr.conflicted")!;
    expect(conflict.event.id).toMatch(/^workstate:pr\.conflicted:/);
    expect(conflict.decisions).toMatchObject([{ type: "wake", person: "sam", kind: "rebase" }]);
  });

  it("records nothing when it is off", async () => {
    for (const pipeline of [undefined, "off"] as const) {
      const { tracker, store } = await start(pipeline);
      expect(office!.parts.pipeline).toBeUndefined();
      await tracker.createIssue({ title: "Search", body: "", status: "ready", assignee: "u-2" });
      await office!.parts.intake.pollOnce();
      expect(await store.listTraces()).toEqual([]);
      await office!.stop();
    }
  });
});

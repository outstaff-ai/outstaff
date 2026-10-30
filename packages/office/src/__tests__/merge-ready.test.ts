import { createOfficeConnection, type Offer, type OfficeConnection } from "@outstaff/agent";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { createOffice } from "#/office.js";
import type { Office } from "#/office.types.js";
import { openStore, type Store } from "#/store/index.js";

const REPO: RepoRef = { host: "git.acme.example", owner: "acme", name: "app" };
const KOFI_LOGIN = "acme-kofi[bot]";

function team(onApproval: boolean): TeamConfig {
  const result = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    humans: [{ name: "Dana", identities: { vcs: "dana" } }],
    repos: [{ name: "app", url: "git.acme.example/acme/app", kind: "primary" }],
    people: [
      {
        handle: "kofi",
        name: "Kofi",
        role: "developer",
        model: "sonnet",
        identities: { vcs: KOFI_LOGIN },
      },
    ],
    integrations: {
      chat: { adapter: "fake" },
      vcs: { adapter: "fake" },
      runtime: { adapter: "fake" },
      tracker: { adapter: "fake" },
    },
    pipeline: { wake: { coalesce_seconds: 0 } },
    policies: { merge: { on_approval: onApproval } },
  });

  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }

  return result.config;
}

describe("the merge wake, live", { timeout: 30_000 }, () => {
  const clock = manualClock();
  let office: Office;
  let kofi: OfficeConnection;
  let vcs: ReturnType<typeof createFakeVcs>;
  let store: Store;

  const start = async (onApproval: boolean) => {
    vcs = createFakeVcs({ now: clock.now });
    const tracker = createFakeTracker({
      now: clock.now,
      actor: { id: "u-1", name: "Office", kind: "agent" },
    });

    const stock = createFakeAdapterRegistry();
    const instances = { vcs, tracker, chat: createFakeChat({ now: clock.now }) } as Record<
      string,
      unknown
    >;

    const registry = new AdapterRegistry();
    for (const port of ["vcs", "tracker", "chat"] as PortName[]) {
      registry.register({ ...stock.get(port, "fake")!, create: () => instances[port] as never });
    }

    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    office = await createOffice({
      team: team(onApproval),
      registry,
      secrets: envSecretSource({ OUTSTAFF_AGENT_TOKEN_KOFI: "kofi-token" }, "/nonexistent"),
      store,
      clock,
      options: { agentPort: 0, agentHost: "127.0.0.1" },
    });

    await office.start();
    kofi = createOfficeConnection({
      url: `ws://127.0.0.1:${office.agentPort()}/agent`,
      person: "kofi",
      token: "kofi-token",
      agentVersion: "test",
      clock,
    });

    kofi.start();
    await kofi.whenConnected();
  };

  afterEach(async () => {
    await kofi.stop();
    await office.stop();
  });

  beforeEach(() => {
    clock.advance(1_000);
  });

  const poll = async () => {
    clock.advance(1_000);
    await office.parts.intake.pollOnce();
  };

  const merges = async () =>
    (await store.listItems({ person: "kofi" })).filter((i) => i.kind === "merge");

  const next = async (): Promise<Offer> => {
    const r = await kofi.offers()[Symbol.asyncIterator]().next();
    if (r.done) {
      throw new Error("no offer");
    }

    return r.value;
  };

  it("an approval with pending checks wakes no one; the checks turning green wake the author with the merge context", async () => {
    await start(true);
    const pr = await vcs.seed.pullRequest(REPO, {
      title: "Keep the coupon",
      head: { ref: "kofi/coupon" },
      author: { login: KOFI_LOGIN, kind: "agent" },
    });

    await vcs.seed.check(REPO, pr.head.sha, { name: "test", status: "pending" });
    await poll();
    await vcs.seed.review(REPO, pr.number, "dana", "approved", "");
    await poll();
    expect(await merges()).toEqual([]);

    await vcs.seed.check(REPO, pr.head.sha, { name: "test", status: "success" });
    await office.parts.workState.rescan();
    const offer = await next();
    expect(offer.workItem).toMatchObject({
      kind: "merge",
      subject: { type: "pr", ref: `git.acme.example/acme/app#${pr.number}` },
    });

    expect(offer.context.wake?.merge?.pr).toMatchObject({
      number: pr.number,
      approvedBy: ["dana"],
      ci: "success",
    });
  });

  it("an approval with green checks wakes the author at once", async () => {
    await start(true);
    const pr = await vcs.seed.pullRequest(REPO, {
      title: "Keep the coupon",
      head: { ref: "kofi/coupon" },
      author: { login: KOFI_LOGIN, kind: "agent" },
    });

    await poll();
    await vcs.seed.review(REPO, pr.number, "dana", "approved", "");
    await poll();
    expect((await next()).workItem.kind).toBe("merge");
  });

  it("with merging off, an approval wakes no one to merge", async () => {
    await start(false);
    const pr = await vcs.seed.pullRequest(REPO, {
      title: "Keep the coupon",
      head: { ref: "kofi/coupon" },
      author: { login: KOFI_LOGIN, kind: "agent" },
    });

    await poll();
    await vcs.seed.review(REPO, pr.number, "dana", "approved", "");
    await poll();
    expect(await merges()).toEqual([]);
  });
});

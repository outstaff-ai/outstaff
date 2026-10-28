import {
  buildWorkPrompt,
  createOfficeConnection,
  type Offer,
  type OfficeConnection,
} from "@outstaff/agent";
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
import type { ContextManifest } from "#/pipeline/context/index.js";
import { openStore, type Store } from "#/store/index.js";

const REPO: RepoRef = { host: "git.acme.example", owner: "acme", name: "app" };
const KOFI_LOGIN = "acme-kofi[bot]";
const SAM_CHAT = "U-SAM";
const DM = "D-SAM";

function team(pipeline: "off" | "shadow" | "live"): TeamConfig {
  const result = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    humans: [
      { name: "Sam", identities: { vcs: "sam", tracker: "u-2", chat: SAM_CHAT } },
      { name: "Dana", identities: { vcs: "dana" } },
    ],
    repos: [{ name: "app", url: "git.acme.example/acme/app", kind: "primary" }],
    people: [
      {
        handle: "kofi",
        name: "Kofi",
        role: "developer",
        identities: { vcs: KOFI_LOGIN, tracker: "u-3" },
      },
    ],
    integrations: {
      chat: { adapter: "fake" },
      vcs: { adapter: "fake" },
      runtime: { adapter: "fake" },
      tracker: { adapter: "fake" },
    },
    office: { pipeline },
  });

  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }

  return result.config;
}

describe.each(["off", "shadow", "live"] as const)(
  "every wake carries the linked tickets, pull requests and chat (office.pipeline: %s)",
  { timeout: 30_000 },
  (mode) => {
    const clock = manualClock();
    let office: Office;
    let store: Store;
    let kofi: OfficeConnection;
    let vcs: ReturnType<typeof createFakeVcs>;
    let tracker: ReturnType<typeof createFakeTracker>;

    const next = async (): Promise<Offer> => {
      const r = await kofi.offers()[Symbol.asyncIterator]().next();
      if (r.done) {
        throw new Error("no offer");
      }

      await kofi.accept(r.value.workItem.id);
      return r.value;
    };

    const poll = async () => {
      clock.advance(1_000);
      await office.parts.intake.pollOnce();
    };

    beforeEach(async () => {
      vcs = createFakeVcs({ now: clock.now });
      tracker = createFakeTracker({
        now: clock.now,
        // The office's own tracker identity; the humans and the agent act through `as`.
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

      await tracker.seed.member({ name: "Sam", kind: "human" });
      await tracker.seed.member({ name: "Kofi", kind: "agent" });
      await vcs.seed.permission(REPO, "dana", "write");
      await vcs.seed.permission(REPO, "sam", "write");
      store = await openStore("sqlite::memory:", { now: () => clock.now() });
      office = await createOffice({
        team: team(mode),
        registry,
        secrets: envSecretSource({ OUTSTAFF_AGENT_TOKEN_KOFI: "kofi-token" }, "/nonexistent"),
        store,
        clock,
        options: { agentPort: 0, agentHost: "127.0.0.1" },
      });

      await office.start();
      await office.parts.intake.pollOnce();
      kofi = createOfficeConnection({
        url: `ws://127.0.0.1:${office.agentPort()}/agent`,
        person: "kofi",
        token: "kofi-token",
        agentVersion: "test",
        clock,
      });

      kofi.start();
      await kofi.whenConnected();
    });

    afterEach(async () => {
      await kofi.stop();
      await office.stop();
    });

    /**
     * Sam asks Kofi in chat to fix a bug; the chat session files it as a ticket, and Kofi opens a pull request for it
     * while the ticket's work runs. Returns the ticket, the pull request and the work item of the ticket.
     */
    async function chatToTicketToPr() {
      await kofi.chatMessage({
        messageId: "1700.1",
        channel: DM,
        text: "Kofi, the checkout drops the coupon on reload. Please fix it.",
        author: { id: SAM_CHAT, name: "Sam" },
        direct: true,
        participant: true,
      });

      const session = await next();
      const asKofi = tracker.as({ id: "u-3", name: "Kofi", kind: "agent" });
      const issue = await asKofi.createIssue({
        title: "Checkout drops the coupon",
        body: "The coupon is lost when the cart is reloaded.",
        status: "active",
        assignee: "u-3",
      });

      await kofi.linkTicket(session.workItem.id, issue.key, "Fix the coupon");
      await asKofi.comment(issue.key, "Sam says it happens on mobile too.");
      await kofi.handBack(session.workItem.id, { summary: "Filed it.", status: "done" });
      await poll();

      const work = await next();
      const pr = await vcs.seed.pullRequest(REPO, {
        title: `${issue.key} Keep the coupon on reload`,
        head: { ref: `${issue.key.toLowerCase()}-coupon` },
        author: { login: KOFI_LOGIN, kind: "agent" },
      });

      await vcs.seed.check(REPO, pr.head.sha, { name: "test", status: "pending" });
      await poll();
      await kofi.handBack(work.workItem.id, {
        summary: `Opened ${pr.url}`,
        links: [{ url: pr.url }],
        status: "done",
      });

      await poll();
      const key = `git.acme.example/acme/app#${pr.number}`;
      return { issue, pr, key, work };
    }

    it("hands a review on the PR its ticket and the chat thread that started the work, each with a link", async () => {
      const { issue, pr, key } = await chatToTicketToPr();
      await vcs.seed.review(REPO, pr.number, "dana", "changes_requested", "Keep the old name.", [
        { path: "src/cart.ts", line: 7, body: "Rename this back." },
      ]);

      await poll();
      const offer = await next();
      expect(offer.workItem).toMatchObject({
        kind: "review_feedback",
        subject: { type: "pr", ref: key },
      });

      const wake = offer.context.wake!;
      expect(wake.prs[0]).toMatchObject({ ref: key, url: pr.url, why: { role: "subject" } });
      expect(wake.tickets[0]).toMatchObject({
        key: issue.key,
        url: issue.url,
        status: expect.any(String),
        assignee: expect.any(String),
        description: "The coupon is lost when the cart is reloaded.",
        comments: expect.arrayContaining([
          expect.objectContaining({ author: "Kofi", body: "Sam says it happens on mobile too." }),
        ]),
      });

      expect(wake.chats[0]).toMatchObject({
        channel: DM,
        thread: "1700.1",
        messages: [
          { author: "Sam", text: "Kofi, the checkout drops the coupon on reload. Please fix it." },
        ],
      });

      const prompt = buildWorkPrompt(offer, { resumed: false });
      expect(prompt).toContain(`Ticket ${issue.key}: Checkout drops the coupon ${issue.url}`);
      expect(prompt).toContain(`Pull request ${key}: ${pr.title} ${pr.url}`);
      expect(prompt).toContain("Chat thread 1700.1 in channel D-SAM");
      expect(prompt).toContain(
        "    > Kofi, the checkout drops the coupon on reload. Please fix it.",
      );

      // The trace of the review shows what the wake carried; with the pipeline off nothing is traced.
      const traces = await store.listTraces({ limit: 20 });
      const carried = traces.flatMap((t) =>
        Object.values(
          (t.data as { context?: Record<string, ContextManifest> }).context ?? {},
        ).flatMap((m) =>
          m.entries
            .filter((e) => e.type === "ticket" || e.type === "chat_thread")
            .map((e) => [m.itemId, e.type, e.ref, e.url]),
        ),
      );

      const id = offer.workItem.id;
      expect(carried).toEqual(
        mode === "off"
          ? []
          : [
              [id, "ticket", issue.key, issue.url],
              [id, "chat_thread", `${DM}:1700.1`, undefined],
            ],
      );
    });

    it("hands a ticket comment the open PR's CI state, mergeability, unresolved threads and stack", async () => {
      const { issue, pr, key } = await chatToTicketToPr();
      await vcs.seed.thread(REPO, pr.number, {
        path: "src/cart.ts",
        line: 7,
        comments: [{ author: "dana", body: "Why is this needed?" }],
      });

      const stacked = await vcs.seed.pullRequest(REPO, {
        title: "Coupon follow-up",
        head: { ref: "coupon-follow-up" },
        base: { ref: pr.head.ref },
        author: { login: KOFI_LOGIN, kind: "agent" },
      });

      await poll();
      await tracker
        .as({ id: "u-2", name: "Sam", kind: "human" })
        .comment(issue.key, "@Kofi can you also check the mobile case?");

      await poll();

      const offer = await next();
      expect(offer.workItem).toMatchObject({ kind: "ticket_comment" });
      expect(offer.context.wake!.prs[0]).toMatchObject({
        ref: key,
        url: pr.url,
        state: "open",
        ci: "pending",
        failing: [],
        mergeable: "clean",
        unresolvedThreads: 1,
        threads: [{ path: "src/cart.ts", line: 7, author: "dana", body: "Why is this needed?" }],
        stackedBy: [`git.acme.example/acme/app#${stacked.number}`],
      });

      expect(buildWorkPrompt(offer, { resumed: false })).toContain(
        "  State: open, CI pending, mergeable: clean, 1 unresolved review thread.",
      );
    });

    it("hands a chat message naming the ticket that ticket and its PRs", async () => {
      const { issue, key, pr } = await chatToTicketToPr();
      await kofi.chatMessage({
        messageId: "1800.1",
        channel: DM,
        text: `Is ${issue.key} shipped yet?`,
        author: { id: SAM_CHAT, name: "Sam" },
        direct: true,
        participant: true,
      });

      const offer = await next();
      expect(offer.workItem.kind).toBe("chat");
      const wake = offer.context.wake!;
      expect(wake.chats[0]).toMatchObject({ thread: "1800.1", why: { role: "trigger" } });
      expect(wake.tickets[0]).toMatchObject({
        key: issue.key,
        url: issue.url,
        why: { role: "mentioned" },
      });

      expect(wake.prs.map((p) => [p.ref, p.url])).toEqual([[key, pr.url]]);
    });

    it("answers in one query on the item with the chat thread, the ticket and the PR, each with when and how", async () => {
      const { issue, key, work } = await chatToTicketToPr();
      const refs = await store.listItemRefs(work.workItem.id);
      const how = (type: string) => refs.find((r) => r.type === type);
      expect(how("chat_thread")).toMatchObject({
        ref: `${DM}:1700.1`,
        role: "trigger",
        source: "work_link",
      });

      expect(how("ticket")).toMatchObject({ ref: issue.key, role: "subject", source: "work_link" });
      expect(how("pr")).toMatchObject({
        ref: key,
        role: "inferred",
        source: "workstate:implements",
      });

      for (const r of refs) {
        expect(Date.parse(r.addedAt)).not.toBeNaN();
      }

      expect(how("pr")!.addedAt > how("ticket")!.addedAt).toBe(true);
    });
  },
);

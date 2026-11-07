import type { Comment, Logger, MergeRequirements, TeamConfig } from "@outstaff/core";
import { manualClock } from "#/clock.js";
import type { Run } from "#/store/runs.types.js";
import type { ItemRef, Subject, WorkItem } from "#/store/types.js";
import type { PendingAct } from "#/pipeline/act/act.types.js";
import type { Notify } from "#/pipeline/decisions.types.js";
import { createNoticeDesk } from "#/pipeline/notify/desk.js";
import type { PrRecord } from "#/workstate/types.js";

export const TEAM = {
  humans: [
    { name: "Ada Admin", identities: { tracker: "ada.admin", chat: "U0ADA" } },
    { name: "Grace Lead", identities: { tracker: "grace.lead" } },
    { name: "Mona Merge", identities: { vcs: "mona", chat: "U0MONA" } },
  ],
  people: [
    { handle: "sam", identities: { tracker: "u-sam" } },
    { handle: "priya", identities: { tracker: "u-priya" } },
  ],
  pipeline: { notify: { debounce_seconds: 30 } },
} as unknown as TeamConfig;

export const notice = (o: Partial<Notify> = {}): Notify => ({
  type: "notify",
  policy: "notify_human_on_handoff",
  as: "sam",
  human: "ada.admin",
  need: "review",
  ticket: "ACME-1",
  prs: [],
  ...o,
});

export const PR9 = { ref: "acme/shop#9", url: "https://github.example/acme/shop/pull/9" };

/** A work item's reference to the ticket it is on. */
const refsOf = (id: string, on?: { ticket: string; role?: ItemRef["role"] }): ItemRef[] =>
  on
    ? [
        {
          workItemId: id,
          type: "ticket",
          ref: on.ticket,
          role: on.role ?? "subject",
          source: "test",
          addedAt: "",
        },
      ]
    : [];

/** A desk on a manual clock, an in-memory store and fakes that record what goes out. */
export function deskHarness(
  o: {
    team?: TeamConfig;
    comments?: Comment[];
    failSend?: number;
    failStore?: number;
    noTracker?: boolean;

    /** The code host's merge rules; a function that throws stands for a host that cannot be read. */
    rules?: MergeRequirements | (() => never);
  } = {},
) {
  const clock = manualClock();
  const subjects = new Map<string, Subject>();
  const sent: { person: string; act: PendingAct }[] = [];
  const logged: string[] = [];
  const rounds = new Set<string>();
  const items: WorkItem[] = [];
  const runs = new Map<string, Run[]>();
  const refs: ItemRef[] = [];
  const prs: PrRecord[] = [];
  const refreshes: string[] = [];
  let failures = o.failSend ?? 0;
  let storeFailures = o.failStore ?? 0;
  const log: Logger = {
    debug() {},
    info: (m) => void logged.push(m),
    warn: (m) => void logged.push(m),
    error() {},
  };

  const desk = createNoticeDesk({
    team: o.team ?? TEAM,
    store: {
      getSubject: async (type, ref) => subjects.get(`${type}/${ref}`),
      listItems: async (f = {}) => items.filter((i) => i.person === f.person),
      listRuns: async (id) => runs.get(id) ?? [],
      getItem: async (id) => items.find((i) => i.id === id),
      findItemRefs: async (type, ref) => refs.filter((r) => r.type === type && r.ref === ref),
      upsertSubject: async (type, ref, data) => {
        if (storeFailures-- > 0) {
          throw new Error("store down");
        }

        subjects.set(`${type}/${ref}`, { type, ref, data, updatedAt: "" });
      },
    },
    workState: {
      inRound: (ticket, person) => rounds.has(`${person}/${ticket}`),
      ticket: (key) => (key === "ACME-1" ? ({ title: "Add a greeting" } as never) : undefined),
      prsOfTicket: (ticket) => prs.filter((p) => p.ticket === ticket),
      prSubject: (pr) => `${pr.repo.owner}/${pr.repo.name}#${pr.number}`,
      refreshPrsOf: async (ticket) => {
        refreshes.push(ticket);
        if (ticket === "ACME-BROKEN") {
          throw new Error("host down");
        }
      },
    },
    vcs:
      o.rules === undefined
        ? undefined
        : {
            mergeRequirements: async () => (typeof o.rules === "function" ? o.rules() : o.rules!),
          },
    acts: {
      send: async (person, act) => {
        if (failures-- > 0) {
          throw new Error("store down");
        }

        sent.push({ person, act });
      },
    },
    clock,
    logger: log,
    tracker: o.noTracker
      ? undefined
      : {
          links: {
            issue: (key) => `https://tracker.example/${key}`,
            comment: (key, id) => `https://tracker.example/${key}#${id}`,
          },
          listComments: async () => {
            if (!o.comments) {
              throw new Error("tracker down");
            }

            return o.comments;
          },
        },
  });

  const bodies = () =>
    sent.map((s) => s.act.ops.map((op) => (op.op === "chat_dm" ? `${op.to}: ${op.body}` : op.op)));

  /** Lets the clock pass, and the flush a timer started finish. */
  const pass = async (ms: number) => {
    clock.advance(ms);
    await new Promise((r) => setTimeout(r, 5));
  };

  /** The next `n` writes to the store fail. */
  const breakStore = (n: number) => {
    storeFailures = n;
  };

  /**
   * A work item of the agent, with its runs, its parent and the tickets it is on and, for a chat session or work from
   * chat, the human it talks with.
   */
  const item = (o: {
    id: string;
    kind: string;
    person?: string;
    updatedAt?: string;
    runs?: Run[];
    with?: string;
    parentId?: string;
    on?: { ticket: string; role?: ItemRef["role"] };
    status?: WorkItem["status"];
    subject?: WorkItem["subject"];
    trigger?: WorkItem["trigger"];
  }) => {
    // The same id again stands for the item as it is now.
    const at = items.findIndex((i) => i.id === o.id);
    const { id, kind, person, parentId, updatedAt, status, subject, trigger } = o;
    const given = Object.entries({
      id,
      kind,
      person,
      parentId,
      updatedAt,
      status,
      subject,
      trigger,
    });

    items.splice(at < 0 ? items.length : at, at < 0 ? 0 : 1, {
      person: "sam",
      parentId: null,
      subject: null,
      updatedAt: clock.now().toISOString(),
      ...Object.fromEntries(given.filter(([, v]) => v !== undefined)),
    } as WorkItem);

    refs.push(...refsOf(o.id, o.on));

    runs.set(o.id, o.runs ?? []);
    if (o.with) {
      subjects.set(`chat_origin/${o.id}`, {
        type: "chat_origin",
        ref: o.id,
        data: {
          channel: `D-${o.person ?? "sam"}`,
          thread: o.id,
          requester: { id: o.with },
          claimed: [],
        },
        updatedAt: "",
      });
    }
  };

  /**
   * The work state's record of a pull request of the ticket (`acme/shop#n`), its head and its checks; the same number
   * again replaces it, as a rescan would.
   */
  const pr = (o: {
    number?: number;
    ticket?: string;
    head?: string;
    base?: string;
    state?: PrRecord["state"];
    checks?: PrRecord["checks"];
  }) => {
    const d = {
      number: 9,
      ticket: "ACME-1",
      head: "a1b2c3d4e5",
      base: "main",
      state: "open" as const,
      checks: [],
      ...o,
    };

    const at = prs.findIndex((p) => p.ref.number === d.number);
    const rec = {
      ref: { repo: { owner: "acme", name: "shop" }, number: d.number },
      headSha: d.head,
      baseRef: d.base,
      state: d.state,
      ticket: d.ticket,
      checks: d.checks,
    } as PrRecord;

    prs.splice(at < 0 ? prs.length : at, at < 0 ? 0 : 1, rec);
  };

  return {
    desk,
    clock,
    sent,
    logged,
    rounds,
    bodies,
    pass,
    breakStore,
    item,
    subjects,
    pr,
    refreshes,
  };
}

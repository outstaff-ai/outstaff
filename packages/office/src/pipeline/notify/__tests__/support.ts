import type { Comment, Logger, TeamConfig } from "@outstaff/core";
import { manualClock } from "#/clock.js";
import type { Run } from "#/store/runs.types.js";
import type { Subject, WorkItem } from "#/store/types.js";
import type { PendingAct } from "#/pipeline/act/act.types.js";
import type { Notify } from "#/pipeline/decisions.types.js";
import { createNoticeDesk } from "#/pipeline/notify/desk.js";

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

/** A desk on a manual clock, an in-memory store and fakes that record what goes out. */
export function deskHarness(
  o: {
    team?: TeamConfig;
    comments?: Comment[];
    failSend?: number;
    failStore?: number;
    noTracker?: boolean;
  } = {},
) {
  const clock = manualClock();
  const subjects = new Map<string, Subject>();
  const sent: { person: string; act: PendingAct }[] = [];
  const logged: string[] = [];
  const rounds = new Set<string>();
  const items: WorkItem[] = [];
  const runs = new Map<string, Run[]>();
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

  /** A work item of the agent, with its runs and, for a chat session, the human it talks with. */
  const item = (o: {
    id: string;
    kind: string;
    person?: string;
    updatedAt?: string;
    runs?: Run[];
    with?: string;
  }) => {
    items.push({
      id: o.id,
      kind: o.kind,
      person: o.person ?? "sam",
      updatedAt: o.updatedAt ?? clock.now().toISOString(),
    } as WorkItem);

    runs.set(o.id, o.runs ?? []);
    if (o.with) {
      subjects.set(`chat_origin/${o.id}`, {
        type: "chat_origin",
        ref: o.id,
        data: { requester: { id: o.with }, claimed: [] },
        updatedAt: "",
      });
    }
  };

  return { desk, clock, sent, logged, rounds, bodies, pass, breakStore, item };
}

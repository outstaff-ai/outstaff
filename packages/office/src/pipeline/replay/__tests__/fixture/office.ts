import type { ReplayScenario } from "../../replay.types.js";
import { at, ev, ROLES, ticket } from "./build.js";

export const idle: ReplayScenario = {
  title: "An agent runs out of work",
  steps: [
    {
      event: ev("s5-idle-sam", "agent.idle", "sam", {}, at(220)),
      world: {
        tickets: { "ACME-160": ticket("ready", "sam"), "ACME-161": ticket("ready", "sam") },
        ready: {
          sam: [
            { key: "ACME-160", readyAt: "2026-10-05T07:30:00.000Z" },
            { key: "ACME-161", readyAt: "2026-10-05T07:10:00.000Z" },
          ],
        },
      },
      note: "intended fix: an idle agent starts its next ready ticket (ACME-161); the engine's rules never see agent.idle, the scheduler's idle pull starts it instead",
    },
    { event: ev("s5-idle-noor", "agent.idle", "noor", {}, at(221)), world: {} },
  ],
};

const UNBLOCK =
  "regression: the PM (priya) gets no unblock round; the plan turns blocked routing into a policy that is not in this set yet";

const handBack = (id: string, key: string, status: string, minute: number) =>
  ev(id, "agent.handed_back", "noor", { ticket: key }, at(minute), {
    kind: "assigned",
    status,
    workItem: `item-${key}`,
  });

export const handBacks: ReplayScenario = {
  title: "Hand-backs: blocked, done and waiting",
  steps: [
    {
      event: handBack("s6-blocked", "ACME-170", "blocked", 230),
      world: { tickets: { "ACME-170": ticket("active", "noor") }, roles: ROLES },
      note: UNBLOCK,
    },
    {
      event: handBack("s6-done", "ACME-171", "done", 231),
      world: { tickets: { "ACME-171": ticket("active", "noor") }, roles: ROLES },
    },
    {
      event: handBack("s6-done-on-blocked", "ACME-172", "done", 232),
      world: { tickets: { "ACME-172": ticket("blocked", "noor") }, roles: ROLES },
      note: UNBLOCK,
    },
    {
      event: handBack("s6-waiting", "ACME-173", "waiting", 233),
      world: { tickets: { "ACME-173": ticket("active", "noor") }, roles: ROLES },
    },
  ],
};

export const chat: ReplayScenario = {
  title: "Chat messages",
  steps: [
    {
      event: ev("s7-dm", "chat.message", "U0ADA0001", { chat: { channel: "D0SAM" } }, at(240), {
        addressed: "sam",
        body: "Can you look at the checkout bug from this morning?",
      }),
      world: {},
      note: "intended fix: chat is an ordinary event that wakes the agent written to; today the chat desk routes it outside the rules",
    },
    {
      event: ev("s7-agent-dm", "chat.message", "kofi", { chat: { channel: "D0SAM" } }, at(241), {
        addressed: "sam",
        body: "The cache key changed, rebase when you can.",
      }),
      world: {},
    },
  ],
};

const design = { "ACME-180": ticket("ready", "ada.admin") };

export const docComments: ReplayScenario = {
  title: "Comments on a design document",
  steps: [
    {
      event: ev(
        "s8-doc-comment",
        "doc.commented",
        "grace-lead",
        { doc: "doc-7", ticket: "ACME-180" },
        at(250),
        {
          docId: "doc-7",
          title: "Order events design",
          commentId: "c-1",
          body: "Which service owns the retry?",
        },
      ),
      world: { tickets: design, docs: { "doc-7": "mira" }, roles: ROLES },
    },
    {
      event: ev(
        "s8-doc-mention",
        "doc.commented",
        "ada.admin",
        { doc: "doc-7", ticket: "ACME-180" },
        at(251),
        {
          docId: "doc-7",
          title: "Order events design",
          commentId: "c-2",
          body: "@leo can you sketch the timeline view?",
          mentions: ["leo"],
        },
      ),
      world: { tickets: design, docs: { "doc-7": "mira" }, roles: ROLES },
      note: "intended fix: per the plan's table a mention goes to the agent named (leo), not also to the author, and taking ACME-180 is left to leo",
    },
  ],
};

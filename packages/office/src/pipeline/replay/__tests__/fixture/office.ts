import type { ReplayScenario } from "#/pipeline/replay/replay.types.js";
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
    },
    { event: ev("s5-idle-noor", "agent.idle", "noor", {}, at(221)), world: {} },
  ],
};

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
    },
    {
      event: handBack("s6-done", "ACME-171", "done", 231),
      world: { tickets: { "ACME-171": ticket("active", "noor") }, roles: ROLES },
    },
    {
      event: handBack("s6-done-on-blocked", "ACME-172", "done", 232),
      world: { tickets: { "ACME-172": ticket("blocked", "noor") }, roles: ROLES },
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
    },
  ],
};

const parent = (status: "ready" | "active" | "blocked", to = "sam") => ({
  "ACME-190": ticket(status, to),
  "ACME-191": ticket("blocked", "ada.admin", { parent: "ACME-190" }),
  "ACME-192": ticket("review", "ada.admin", { parent: "ACME-190" }),
});

const onParent = (
  id: string,
  type: "agent.started" | "agent.handed_back",
  minute: number,
  data = {},
) =>
  ev(id, type, "sam", { ticket: "ACME-190" }, at(minute), {
    kind: "assigned",
    workItem: `item-${id}`,
    ...data,
  });

const SILENCED_AT = at(262);

/**
 * The loop an idle pull and a silent hand-back made: a parent the agent cannot progress until a human decides on one of
 * its sub-tickets. Handed back blocked it goes to the PM; a silent one that waits on work in flight leaves it active;
 * the idle pull skips a ticket handed back silent; and a second silent hand-back the office took as blocked goes to the
 * PM with the office's reason.
 */
export const silentLoop: ReplayScenario = {
  title: "A ticket the agent cannot progress: no idle pull loop",
  steps: [
    {
      event: ev("s9-idle", "agent.idle", "sam", {}, at(260)),
      world: {
        tickets: parent("ready"),
        ready: { sam: [{ key: "ACME-190", readyAt: "2026-10-05T07:00:00.000Z" }] },
      },
    },
    { event: onParent("s9-start", "agent.started", 261), world: { tickets: parent("ready") } },
    {
      event: onParent("s9-blocked", "agent.handed_back", 262, {
        status: "blocked",
        before: { status: "ready" },
      }),
      world: { tickets: parent("active"), roles: ROLES },
    },
    {
      event: onParent("s9-silent-in-flight", "agent.handed_back", 263, {
        status: "silent",
        before: { status: "ready", assignee: { kind: "agent", id: "sam" } },
        waitingOn: ["ACME-192 is in review"],
      }),
      world: { tickets: parent("active"), roles: ROLES },
    },
    {
      event: ev("s9-idle-skips", "agent.idle", "sam", {}, at(264)),
      world: {
        tickets: parent("ready"),
        ready: {
          sam: [{ key: "ACME-190", readyAt: "2026-10-05T07:00:00.000Z", silencedAt: SILENCED_AT }],
        },
      },
    },
    {
      event: onParent("s9-silent-again", "agent.handed_back", 265, {
        status: "blocked",
        before: { status: "ready" },
        silentAgain: `sam handed ACME-190 back silent at ${SILENCED_AT}, and again with nothing from anyone else on it since: taking it as blocked`,
      }),
      world: { tickets: parent("active"), roles: ROLES },
    },
  ],
};

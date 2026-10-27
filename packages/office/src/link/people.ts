import { WAKE_SUBJECT } from "#/pipeline/live/wake.js";
import type { WakeReason } from "#/pipeline/live/live.types.js";
import type { WorkItem } from "#/store/types.js";
import type { LinkPerson, ScheduledBy } from "@outstaff/protocol";
import type { OfficeLinkOptions } from "./link.types.js";

type Deps = Pick<OfficeLinkOptions, "team" | "connected"> & {
  store: Pick<OfficeLinkOptions["store"], "listItems" | "listRuns" | "getSubject">;
};

const view = (i: WorkItem) => ({
  id: i.id,
  kind: i.kind,
  title: i.title,
  subject: i.subject,
});

/** Queue order: priority, then place, then age, as the scheduler takes them. */
const byQueue = (a: WorkItem, b: WorkItem) =>
  a.priority - b.priority || a.position - b.position || a.createdAt.localeCompare(b.createdAt);

async function reason(
  deps: Deps,
  item: WorkItem,
): Promise<{ reason: string; scheduledBy: ScheduledBy | null }> {
  const wake = (await deps.store.getSubject(WAKE_SUBJECT, item.id))?.data as WakeReason | undefined;
  return wake
    ? {
        reason: `policy ${wake.policy} on event ${wake.event}`,
        scheduledBy: { policy: wake.policy, eventId: wake.event },
      }
    : { reason: `${item.trigger}: ${item.kind.replaceAll("_", " ")}`, scheduledBy: null };
}

/** The item a person is working on, with when its run started and its latest sign of life. */
async function currentOf(deps: Deps, active: WorkItem | undefined): Promise<LinkPerson["current"]> {
  if (!active) {
    return null;
  }

  const runs = await deps.store.listRuns(active.id);
  return {
    ...view(active),
    startedAt: runs.at(-1)?.startedAt ?? null,
    // A heartbeat touches the item, so its last change is the latest sign of life.
    lastHeartbeat: active.updatedAt,
  };
}

/** Each person: connected or not, what it is working on, and its queue with why each item is there. */
export async function listPeople(deps: Deps): Promise<LinkPerson[]> {
  const online = new Set(deps.connected());
  return Promise.all(
    deps.team.people.map(async (p): Promise<LinkPerson> => {
      const items = await deps.store.listItems({ person: p.handle });
      const active = items.filter((i) => i.status === "active");
      const queued = items.filter((i) => i.status === "queued").toSorted(byQueue);
      return {
        handle: p.handle,
        name: p.name,
        role: p.role,
        connected: online.has(p.handle),
        counts: { queued: queued.length, running: active.length },
        current: await currentOf(deps, active[0]),
        queue: await Promise.all(
          queued.map(async (i) => ({
            ...view(i),
            priority: i.priority,
            trigger: i.trigger,
            ...(await reason(deps, i)),
          })),
        ),
      };
    }),
  );
}

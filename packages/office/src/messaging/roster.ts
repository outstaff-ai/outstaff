import type { Human, Member, MemberUsage } from "@outstaff/protocol";
import type { TeamConfig } from "@outstaff/core";
import type { Store } from "../store/types.js";

export interface RoleInfo {
  title: string;
  summary: string;
}

export interface RosterOptions {
  store: Pick<Store, "listItems" | "listPauses">;
  team: Pick<TeamConfig, "people" | "humans">;

  /** Titles and summaries of the roles, from the catalog when the office has it. Without an entry the role id is shown. */
  roles?: ReadonlyMap<string, RoleInfo> | Record<string, RoleInfo>;

  /** Trusted humans when team.yaml lists none (then they come from repo writers and chat members). */
  humans?: () => Promise<Human[]>;

  /** The person's busiest recent usage window, when known. */
  usage?: (person: string) => Promise<MemberUsage | undefined>;
}

export interface Roster {
  members: Member[];
  humans: Human[];
}

const infoOf = (roles: RosterOptions["roles"], role: string): RoleInfo | undefined =>
  roles instanceof Map ? roles.get(role) : (roles as Record<string, RoleInfo> | undefined)?.[role];

/** Queued plus active items per person, the measure of how busy someone is. */
export async function loadByPerson(store: Pick<Store, "listItems">): Promise<Map<string, number>> {
  const load = new Map<string, number>();
  for (const status of ["queued", "active"] as const) {
    for (const item of await store.listItems({ status })) {
      load.set(item.person, (load.get(item.person) ?? 0) + 1);
    }
  }

  return load;
}

/** The live team: read on every call, so hires and departures show without a restart. */
export async function readRoster(opts: RosterOptions): Promise<Roster> {
  const active = await opts.store.listItems({ status: "active" });
  const pauses = await opts.store.listPauses();
  const teamPaused = pauses.some((p) => p.scope === "team");
  const usages = new Map<string, MemberUsage>();
  if (opts.usage) {
    for (const p of opts.team.people) {
      const usage = await opts.usage(p.handle);
      if (usage) {
        usages.set(p.handle, usage);
      }
    }
  }

  const members = opts.team.people.map((p): Member => {
    const item = active.find((i) => i.person === p.handle);
    const paused = teamPaused || pauses.some((x) => x.scope === `person:${p.handle}`);
    const info = infoOf(opts.roles, p.role);
    const usage = usages.get(p.handle);
    return {
      handle: p.handle,
      name: p.name,
      role: p.role,
      title: info?.title ?? p.role,
      ...(info ? { summary: info.summary } : {}),
      status: item ? "working" : paused ? "paused" : "idle",
      ...(item ? { current: item.title } : {}),
      ...(usage ? { usage } : {}),
    };
  });

  const humans: Human[] = opts.team.humans
    ? opts.team.humans.map((h) => ({ name: h.name }))
    : ((await opts.humans?.()) ?? []);

  return { members, humans };
}

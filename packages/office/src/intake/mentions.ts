import type { Logger, Member, TeamConfig, Tracker } from "@outstaff/core";
import type { Clock } from "#/types.js";
import type { MentionResolver } from "./types.js";

/** How long the tracker's usernames are kept before they are read again. */
export const DEFAULT_MEMBERS_TTL_MS = 10 * 60_000;

/** How long a read of the tracker's members may take before it is given up on until the next refresh. */
export const DEFAULT_MEMBERS_TIMEOUT_MS = 10_000;

/** Lowercase, without spaces, dots, underscores and hyphens: `sam.duarte`, `Sam Duarte` and `sam_duarte` are one name. */
export const normalizeName = (name: string): string =>
  name.toLowerCase().replaceAll(/[\s._-]/g, "");

/** Each name to the handles that answer to it. More than one handle makes the name ambiguous. */
type Names = Map<string, Set<string>>;

const add = (names: Names, key: string, handle: string) => {
  if (key) {
    names.set(key, (names.get(key) ?? new Set()).add(handle));
  }
};

/** The tracker member a person's `identities.tracker` names, by member id or username. */
const memberOf = (identity: string | undefined, members: readonly Member[]) =>
  identity === undefined
    ? undefined
    : members.find((m) => m.id === identity || m.username === identity);

/** The names a person answers to: the tracker identity, the handle, the name, and the tracker's username and name. */
function namesOf(person: TeamConfig["people"][number], members: readonly Member[]): string[] {
  const member = memberOf(person.identities?.tracker, members);
  return [
    person.identities?.tracker,
    person.handle,
    person.name,
    member?.username,
    member?.name,
  ].filter((n): n is string => typeof n === "string" && n !== "");
}

function tables(team: TeamConfig, members: readonly Member[]) {
  const exact: Names = new Map();
  const loose: Names = new Map();
  for (const p of team.people) {
    for (const name of namesOf(p, members)) {
      add(exact, name.toLowerCase(), p.handle);
      add(loose, normalizeName(name), p.handle);
    }
  }

  return { exact, loose };
}

/** The one handle a name is, exactly and then normalised; nothing when it is nobody's, or more than one person's. */
function lookup(t: ReturnType<typeof tables>, name: string): string | undefined {
  const found = t.exact.get(name.toLowerCase()) ?? t.loose.get(normalizeName(name));
  return found?.size === 1 ? [...found][0] : undefined;
}

/**
 * Maps the `@name`s an adapter parsed out of a comment to the handles of the team's agents: by tracker username,
 * tracker identity, handle or name, exactly (ignoring case), else by their normalised forms. A name two people answer
 * to resolves to nobody, with a warning. The tracker's usernames are read at start and again once they are older than
 * `ttlMs`; when they cannot be read within `timeoutMs`, the last ones read are kept until the next refresh.
 */
export function createMentionResolver(opts: {
  team: TeamConfig;
  tracker?: Pick<Tracker, "members"> | undefined;
  clock: Clock;
  logger: Logger;
  ttlMs?: number;
  timeoutMs?: number;
}): MentionResolver {
  const { team, tracker, clock, logger } = opts;
  const ttl = opts.ttlMs ?? DEFAULT_MEMBERS_TTL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MEMBERS_TIMEOUT_MS;
  let members: Member[] = [];
  let loadedAt: number | undefined;
  let current = tables(team, members);

  const warnAmbiguous = () => {
    for (const [name, handles] of current.loose) {
      if (handles.size > 1) {
        logger.warn(
          `intake: @${name} could be any of ${[...handles].join(", ")}; a mention of it wakes no one`,
          { name, handles: [...handles] },
        );
      }
    }
  };

  /** The tracker's members, or a rejection once `timeoutMs` passed without them. */
  const read = async (from: Pick<Tracker, "members">) => {
    let cancel: (() => void) | undefined;
    const expired = new Promise<never>((_, reject) => {
      cancel = clock.setTimeout(
        () => reject(new Error(`no answer within ${timeoutMs} ms`)),
        timeoutMs,
      );
    });

    try {
      return await Promise.race([from.members(), expired]);
    } finally {
      cancel?.();
    }
  };

  const load = async () => {
    loadedAt = clock.now().getTime();
    try {
      members = tracker ? await read(tracker) : [];
    } catch (error) {
      logger.warn("intake: the tracker's members could not be read; mentions match the team file", {
        error: String(error),
      });
    }

    current = tables(team, members);
    warnAmbiguous();
  };

  const stale = () => loadedAt === undefined || clock.now().getTime() - loadedAt >= ttl;

  return {
    load,
    async resolve(names) {
      if (!Array.isArray(names) || names.length === 0) {
        return [];
      }

      if (tracker && stale()) {
        await load();
      }

      const handles = names.flatMap((n) => (typeof n === "string" ? [lookup(current, n)] : []));
      return [...new Set(handles.filter((h): h is string => h !== undefined))];
    },
  };
}

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

/** What a tracker event names a member as: its username, else its id (as `trackerActors` does). */
const actorId = (member: Member) => member.username ?? member.id;

/**
 * The humans the comments can name, each with the names they answer to and the id a tracker event gives them: the
 * team file's humans (by their tracker identity, code host login, chat id and name, and their tracker member's
 * username and name), and the tracker's other human members.
 */
function humansOf(team: TeamConfig, members: readonly Member[]): [string, string[]][] {
  const agents = new Set(
    team.people.flatMap((p) => (p.identities?.tracker ? [p.identities.tracker] : [])),
  );

  const listed = (team.humans ?? []).flatMap((h): [string, string[]][] => {
    const member = memberOf(h.identities.tracker, members);
    const id = member ? actorId(member) : h.identities.tracker;
    const { tracker, vcs, chat } = h.identities;
    const names = [tracker, vcs, chat, h.name, member?.username, member?.name];
    return id ? [[id, names.filter((n): n is string => !!n)]] : [];
  });

  const others = members
    .filter((m) => m.kind === "human" && !agents.has(m.id) && !agents.has(m.username ?? ""))
    .map((m): [string, string[]] => [
      actorId(m),
      [m.username, m.name, m.id].filter((n): n is string => !!n),
    ]);

  return [...listed, ...others];
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

  const humanExact: Names = new Map();
  const humanLoose: Names = new Map();
  for (const [id, names] of humansOf(team, members)) {
    for (const name of names) {
      add(humanExact, name.toLowerCase(), id);
      add(humanLoose, normalizeName(name), id);
    }
  }

  return { exact, loose, humans: { exact: humanExact, loose: humanLoose } };
}

/** The one handle a name is, exactly and then normalised; nothing when it is nobody's, or more than one person's. */
function lookup(t: { exact: Names; loose: Names }, name: string): string | undefined {
  const found = t.exact.get(name.toLowerCase()) ?? t.loose.get(normalizeName(name));
  return found?.size === 1 ? [...found][0] : undefined;
}

/** The names a comment mentions, as strings: what an adapter put in `data.mentions`. */
const namesIn = (names: unknown): string[] =>
  Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];

/**
 * Maps the `@name`s an adapter parsed out of a comment to the handles of the team's agents: by tracker username,
 * tracker identity, handle or name, exactly (ignoring case), else by their normalised forms. A name two people answer
 * to resolves to nobody, with a warning. `humans` maps the names no agent answers to onto the humans they are, as a
 * tracker event names them, the same way. The tracker's usernames are read at start and again once they are older than
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

  /** The names, each looked up with `find` on fresh tables, first mention first, without repeats. */
  const each = async (names: unknown, find: (name: string) => string | undefined) => {
    const list = namesIn(names);
    if (list.length === 0) {
      return [];
    }

    if (tracker && stale()) {
      await load();
    }

    return [...new Set(list.map(find).filter((h): h is string => h !== undefined))];
  };

  return {
    load,
    resolve: (names) => each(names, (n) => lookup(current, n)),
    humans: (names) =>
      each(names, (n) => (lookup(current, n) ? undefined : lookup(current.humans, n))),
  };
}

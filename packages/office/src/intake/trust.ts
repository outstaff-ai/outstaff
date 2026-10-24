import { PortError, repoKey, vcsAgentLogins } from "@outstaff/core";
import type { Member, RepoRef, TeamConfig, Vcs } from "@outstaff/core";
import type { Clock } from "../clock.js";
import type { Store } from "../store/index.js";
import type { Actor } from "./normalize.js";

export const DEFAULT_TRUST_TTL_MS = 10 * 60_000;
const BOT_SUFFIX = "[bot]";

interface CachedPermission {
  permission: string;
  checkedAt: string;
}

export interface Trust {
  vcsActor(repo: RepoRef, login: string): Promise<Actor>;
  trackerActor(member: Member): Actor;
}

export interface TrustOptions {
  store: Store;
  vcs: Vcs;
  team: TeamConfig;
  clock: Clock;
  ttlMs?: number;
  resolveAgent?: (login: string) => string | undefined;
}

export function createTrust(opts: TrustOptions): Trust {
  const ttl = opts.ttlMs ?? DEFAULT_TRUST_TTL_MS;
  // Agents are recognized only by the identities declared in team.yaml, never by how a login looks.
  const vcsAgents = vcsAgentLogins(opts.team);
  const trackerAgents = new Map<string, string>();
  for (const p of opts.team.people) {
    if (p.identities?.tracker) {
      trackerAgents.set(p.identities.tracker, p.handle);
    }
  }

  const explicitVcs =
    opts.team.humans &&
    new Set(
      opts.team.humans.flatMap((h) => (h.identities.vcs ? [h.identities.vcs.toLowerCase()] : [])),
    );

  const explicitTracker =
    opts.team.humans &&
    new Set(
      opts.team.humans.flatMap((h) =>
        h.identities.tracker ? [h.identities.tracker.toLowerCase()] : [],
      ),
    );

  const agentHandle = (login: string): string | undefined =>
    opts.resolveAgent?.(login) ?? vcsAgents.get(login.toLowerCase());

  const permission = async (repo: RepoRef, login: string): Promise<string | undefined> => {
    const ref = `${repoKey(repo)}:${login.toLowerCase()}`;
    const cached = await opts.store.getSubject("trust", ref);
    const hit = cached?.data as CachedPermission | undefined;
    if (hit && opts.clock.now().getTime() - Date.parse(hit.checkedAt) < ttl) {
      return hit.permission;
    }

    try {
      const found = await opts.vcs.permission(repo, login);
      await opts.store.upsertSubject("trust", ref, {
        permission: found,
        checkedAt: opts.clock.now().toISOString(),
      } satisfies CachedPermission);

      return found;
    } catch (error) {
      // Transient failures abort the page so it is retried; the cursor does not move.
      if (
        error instanceof PortError &&
        (error.code === "rate_limited" || error.code === "unavailable")
      ) {
        throw error;
      }

      return undefined;
    }
  };

  return {
    async vcsActor(repo, login) {
      const handle = agentHandle(login);
      if (handle !== undefined) {
        return { kind: "agent", id: handle, trusted: false };
      }

      if (login.endsWith(BOT_SUFFIX)) {
        return { kind: "automation", id: login, trusted: false };
      }

      if (explicitVcs) {
        return { kind: "human", id: login, trusted: explicitVcs.has(login.toLowerCase()) };
      }

      const level = await permission(repo, login);
      return { kind: "human", id: login, trusted: level === "write" || level === "admin" };
    },
    trackerActor(member) {
      const names = [member.username, member.name, member.id].filter((x) => x !== undefined);
      const handle = [member.id, member.username]
        .map((n) => (n === undefined ? undefined : trackerAgents.get(n)))
        .find((h) => h !== undefined);

      if (handle !== undefined) {
        return { kind: "agent", id: handle, trusted: false };
      }

      if (member.kind === "agent") {
        return { kind: "automation", id: member.username ?? member.id, trusted: false };
      }

      const id = member.username ?? member.id;
      const trusted = explicitTracker
        ? names.some((n) => explicitTracker.has(n.toLowerCase()))
        : true;

      return { kind: "human", id, trusted };
    },
  };
}

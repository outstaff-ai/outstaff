import type { Logger, TeamConfig } from "@outstaff/core";
import { MEMBER_ID } from "./identities.js";
import type { SlackUser, SlackWeb } from "./api.js";
import type { Sender } from "./types.js";

const TTL_MS = 10 * 60_000;

const nameOf = (user: SlackUser) => user.profile?.display_name || user.real_name || user.name;

/**
 * Who may talk to the agents. With a `humans` list in the team config: the people whose `identities.chat` is their
 * Slack member id, matched exactly. Names are never matched: any member can change their display name. Without one: full workspace members, so not guests (restricted or single-channel),
 * not deactivated and not bots. Lookups are cached; a failed lookup is untrusted and not cached.
 */
export function createTrust(deps: {
  web: SlackWeb;
  humans: TeamConfig["humans"];
  botUserId: () => string | undefined;
  now: () => Date;
  log: Logger;
}) {
  const chatIdentities = deps.humans?.flatMap((h) =>
    h.identities.chat ? [h.identities.chat] : [],
  );

  const listed = chatIdentities
    ? new Set(chatIdentities.filter((i) => MEMBER_ID.test(i)))
    : undefined;

  // `ost validate` reports this too (validateSlackIdentities); this is the backstop for configs that skipped it.
  for (const identity of chatIdentities ?? []) {
    if (!MEMBER_ID.test(identity)) {
      deps.log.warn(
        `humans identities.chat "${identity}" is not a Slack member id; use the Slack member id (Profile > ... > Copy member ID), not a name. It will not match anyone.`,
      );
    }
  }

  const cache = new Map<string, { at: number; sender: Sender }>();

  /** Listed humans when the team names any; otherwise full members, not guests. */
  const isTrustedPerson = (id: string, user: SlackUser) =>
    listed ? listed.has(id) : !user.is_restricted && !user.is_ultra_restricted;

  const classify = (id: string, user: SlackUser): Sender => {
    const name = nameOf(user);
    const bot = Boolean(user.is_bot) || id === deps.botUserId();
    return {
      bot,
      ...(name ? { name } : {}),
      trusted: !bot && !user.deleted && isTrustedPerson(id, user),
    };
  };

  return {
    async resolve(id: string): Promise<Sender> {
      const hit = cache.get(id);
      const now = deps.now().getTime();
      if (hit && now - hit.at < TTL_MS) {
        return hit.sender;
      }

      try {
        const { user } = await deps.web.users.info({ user: id });
        if (!user) {
          return { bot: false, trusted: false };
        }

        const sender = classify(id, user);
        cache.set(id, { at: now, sender });
        return sender;
      } catch (error) {
        deps.log.warn("slack users.info failed; treating the sender as untrusted", {
          user: id,
          error: String(error),
        });

        return { bot: false, trusted: false };
      }
    },
  };
}

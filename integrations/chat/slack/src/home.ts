import type { AdapterContext, AgentProfile } from "@outstaff/core";
import type { SlackWeb } from "./api.js";
import { callSlack } from "./errors.js";
import { homeView } from "./profile.js";
import type { Sender, SlackOptions } from "./types.js";

/** A held profile is shown as it is for this long after it was published; then the agent is asked again. */
const PROFILE_FRESH_MS = 60_000;
const ZONE_TTL_MS = 10 * 60_000;

/** The agent's App Home: the profiles published per person, refreshed from the agent when a held one is stale. */
export function createHome(deps: {
  ctx: AdapterContext<SlackOptions>;
  web: SlackWeb;
  trust: { resolve(id: string): Promise<Sender> };
}) {
  const { ctx, web, trust } = deps;
  const profiles = new Map<string, { profile: AgentProfile; at: number }>();
  const zones = new Map<string, { tz?: string; at: number }>();
  let profileSource: ((userId: string) => Promise<AgentProfile | undefined>) | undefined;

  /** The viewer's timezone from Slack, cached with the other lookups; unknown when the lookup fails. */
  const zoneOf = async (userId: string) => {
    const now = ctx.now().getTime();
    const hit = zones.get(userId);
    if (hit && now - hit.at < ZONE_TTL_MS) {
      return hit.tz;
    }

    let tz: string | undefined;
    try {
      tz = (await web.users.info({ user: userId })).user?.tz || undefined;
    } catch {
      // Times show in UTC.
    }

    zones.set(userId, { ...(tz ? { tz } : {}), at: now });
    return tz;
  };

  const publish = async (userId: string, profile: AgentProfile) => {
    const tz = profile.lastActiveAt ? await zoneOf(userId) : undefined;
    await callSlack(() => web.views.publish({ user_id: userId, view: homeView(profile, tz) }));
  };

  return {
    async opened(user: string) {
      let held = profiles.get(user);
      const stale = !held || ctx.now().getTime() - held.at >= PROFILE_FRESH_MS;
      // Only trusted people see the work; a profile held for a person was published for them.
      if (profileSource && stale && (held || (await trust.resolve(user)).trusted)) {
        try {
          const fresh = await profileSource(user);
          if (fresh) {
            held = { profile: structuredClone(fresh), at: ctx.now().getTime() };
            profiles.set(user, held);
          }
        } catch (error) {
          ctx.log.warn("could not refresh the profile; showing the one held", {
            error: String(error),
          });
        }
      }

      if (held) {
        await publish(user, held.profile);
      }
    },

    async set(userId: string, profile: AgentProfile) {
      profiles.set(userId, { profile: structuredClone(profile), at: ctx.now().getTime() });
      await publish(userId, profile);
    },

    onRequest(source: (userId: string) => Promise<AgentProfile | undefined>) {
      profileSource = source;
    },
  };
}

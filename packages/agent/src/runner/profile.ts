import { silentLogger, type AgentProfile } from "@outstaff/core";
import { formatWorkGroups, groupWork, type WorkGroup } from "@outstaff/protocol";
import type { ProfilePublisherOptions, ProfilePublisher } from "./types.js";

/** How to talk to the agent, as #264 behaves: questions are answered right away, work is filed or joined. */
export const PROFILE_HINT =
  "**Talk to me here.** Ask a question and I answer right away. Ask for work and I turn it into a ticket, or add it to work I already have.";

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The title of a group as a person would call it, and where it links to. */
export function groupHead(
  g: WorkGroup,
  ticketUrl: (key: string) => string | undefined,
): { title: string; url?: string } {
  const url = g.ticketKey ? (ticketUrl(g.ticketKey) ?? g.prUrl) : g.prUrl;
  const title = g.ticketKey
    ? [g.ticketKey, g.ticketTitle].filter(Boolean).join(" ")
    : g.prNumber === undefined
      ? g.title
      : `PR #${g.prNumber}${g.prTitle ? ` ${g.prTitle}` : ""}`;

  return { title, ...(url ? { url } : {}) };
}

export function createProfilePublisher(opts: ProfilePublisherOptions): ProfilePublisher {
  const log = opts.log ?? silentLogger;
  const now = opts.now ?? Date.now;
  const debounceMs = opts.debounceMs ?? 2000;
  const refreshEveryMs = opts.refreshEveryMs ?? 300_000;
  const ticketUrl = (key: string) => opts.tracker?.links.issue(key);

  // Humans whose chat identity is known; without a list the profile is published to whoever opens it.
  const viewers = [
    ...new Set(opts.team.humans?.flatMap((h) => (h.identities.chat ? [h.identities.chat] : []))),
  ];

  let lastActive = now();
  let working = false;
  let timer: NodeJS.Timeout | undefined;
  let ticker: NodeJS.Timeout | undefined;
  let lane: Promise<void> = Promise.resolve();
  let stopped = true;

  async function build(): Promise<AgentProfile> {
    const items = (await opts.office.work({})).filter((i) => i.kind !== "chat");
    const groups = groupWork(items);
    const active = groups.find((g) => g.items.some((i) => i.status === "active"));
    working = active !== undefined;
    if (working) {
      lastActive = now();
    }

    return {
      name: opts.who.name,
      role: opts.who.role,
      ...(opts.who.description ? { description: opts.who.description } : {}),
      ...(opts.who.model ? { model: opts.who.model } : {}),
      status: working ? "working" : "idle",
      ...(active ? { current: groupHead(active, ticketUrl) } : {}),
      lastActiveAt: new Date(lastActive).toISOString(),
      hint: PROFILE_HINT,
      sections: [
        {
          heading: "Current work",
          lines: formatWorkGroups(groups, ticketUrl),
        },
      ],
    };
  }

  async function publish() {
    if (stopped) {
      return;
    }

    let profile: AgentProfile;
    try {
      profile = await build();
    } catch (e) {
      log.warn("could not build the chat profile", { error: reason(e) });
      return;
    }

    for (const userId of viewers) {
      try {
        await opts.chat.setAgentProfile(userId, profile);
      } catch (e) {
        log.warn("could not publish the chat profile", { user: userId, error: reason(e) });
      }
    }
  }

  const enqueue = () => {
    lane = lane.then(publish, publish);
    return lane;
  };

  return {
    build,

    async start() {
      stopped = false;
      opts.chat.onProfileRequest?.(async () => build().catch(() => undefined));
      await enqueue();
      ticker = setInterval(() => {
        if (working) {
          void enqueue();
        }
      }, refreshEveryMs);

      ticker.unref();
    },

    changed() {
      if (stopped || timer) {
        return;
      }

      timer = setTimeout(() => {
        timer = undefined;
        void enqueue();
      }, debounceMs);

      timer.unref();
    },

    stop() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(ticker);
      timer = undefined;
      ticker = undefined;
    },
  };
}

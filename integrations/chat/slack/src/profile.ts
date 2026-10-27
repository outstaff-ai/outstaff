import type { AgentProfile } from "@outstaff/core";
import type { SlackHomeView } from "./api.js";
import { escapeSlack, toMrkdwn } from "./mrkdwn.js";

const STATUS = {
  working: ":large_green_circle: *Working*",
  idle: ":white_circle: *Idle*",
  paused: ":double_vertical_bar: *Paused*",
} as const;

// Slack caps a header at 150 characters, a section at 3000 and a view at 100 blocks.
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const section = (text: string) => ({
  type: "section",
  text: { type: "mrkdwn", text: clip(text, 3000) },
});

/** A time in the viewer's timezone, with the zone named; UTC when the zone is unknown or not valid. */
export function formatWhen(iso: string, tz?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return iso;
  }

  const format = (timeZone: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => p.value)
      .join("");

  const zone = (timeZone: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? timeZone;

  try {
    if (tz) {
      return `${format(tz)} ${zone(tz)}`;
    }
  } catch {
    // An unknown zone name falls through to UTC.
  }

  return `${format("UTC")} UTC`;
}

/** Who the agent is: its role, description and model. */
function aboutLines(profile: AgentProfile): string[] {
  const about = [`*${escapeSlack(profile.role)}*`];
  if (profile.description) {
    about.push(escapeSlack(profile.description));
  }

  if (profile.model) {
    about.push(`_Model: ${escapeSlack(profile.model)}_`);
  }

  return about;
}

/** The work item as a link when it has a web address, plain text otherwise. */
function workLabel({ title, url }: { title: string; url?: string }): string {
  return url && /^https?:\/\//.test(url) ? `<${url}|${escapeSlack(title)}>` : escapeSlack(title);
}

/** Whether the agent is working, on what, and when it was last active. */
function statusLines(profile: AgentProfile, tz: string | undefined): string[] {
  const working = profile.current && profile.status === "working";
  const status: string[] = [
    working
      ? `:large_green_circle: *Working on* ${workLabel(profile.current!)}`
      : STATUS[profile.status],
  ];

  if (profile.lastActiveAt) {
    status.push(`_Last active ${formatWhen(profile.lastActiveAt, tz)}_`);
  }

  return status;
}

/** How to talk to the agent and its extra sections, each after a divider. */
function extraBlocks(profile: AgentProfile): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = profile.hint ? [section(toMrkdwn(profile.hint))] : [];
  for (const s of (profile.sections ?? []).slice(0, 40)) {
    blocks.push(
      { type: "divider" },
      section(`*${escapeSlack(s.heading)}*\n${s.lines.map(toMrkdwn).join("\n") || "_Nothing._"}`),
    );
  }

  return blocks;
}

/**
 * The Home tab: who the agent is, whether it is working, on what, how to talk to it, and any extra sections.
 * `tz` is the viewer's timezone, when known; times are in UTC otherwise.
 */
export function homeView(profile: AgentProfile, tz?: string): SlackHomeView {
  return {
    type: "home",
    blocks: [
      { type: "header", text: { type: "plain_text", text: clip(profile.name, 150) } },
      section(aboutLines(profile).join("\n")),
      section(statusLines(profile, tz).join("\n")),
      ...extraBlocks(profile),
    ],
  };
}

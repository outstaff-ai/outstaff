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

/**
 * The Home tab: who the agent is, whether it is working, on what, how to talk to it, and any extra sections.
 * `tz` is the viewer's timezone, when known; times are in UTC otherwise.
 */
export function homeView(profile: AgentProfile, tz?: string): SlackHomeView {
  const about = [`*${escapeSlack(profile.role)}*`];
  if (profile.description) {
    about.push(escapeSlack(profile.description));
  }

  if (profile.model) {
    about.push(`_Model: ${escapeSlack(profile.model)}_`);
  }

  const status: string[] = [STATUS[profile.status]];
  if (profile.current && profile.status === "working") {
    const { title, url } = profile.current;
    const label =
      url && /^https?:\/\//.test(url) ? `<${url}|${escapeSlack(title)}>` : escapeSlack(title);

    status[0] = `:large_green_circle: *Working on* ${label}`;
  }

  if (profile.lastActiveAt) {
    status.push(`_Last active ${formatWhen(profile.lastActiveAt, tz)}_`);
  }

  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: clip(profile.name, 150) } },
    section(about.join("\n")),
    section(status.join("\n")),
  ];

  if (profile.hint) {
    blocks.push(section(toMrkdwn(profile.hint)));
  }

  for (const s of (profile.sections ?? []).slice(0, 40)) {
    blocks.push(
      { type: "divider" },
      section(`*${escapeSlack(s.heading)}*\n${s.lines.map(toMrkdwn).join("\n") || "_Nothing._"}`),
    );
  }

  return { type: "home", blocks };
}

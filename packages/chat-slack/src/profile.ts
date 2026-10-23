import type { AgentProfile } from "@outstaff/core";
import type { SlackHomeView } from "./api.js";
import { escapeSlack, toMrkdwn } from "./mrkdwn.js";

const STATUS = {
  working: ":large_green_circle: Working",
  idle: ":white_circle: Idle",
  paused: ":double_vertical_bar: Paused",
} as const;

// Slack caps a header at 150 characters, a section at 3000 and a view at 100 blocks.
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const section = (text: string) => ({
  type: "section",
  text: { type: "mrkdwn", text: clip(text, 3000) },
});

/** The Home tab: who the agent is, whether it is working, on what, and any extra sections. */
export function homeView(profile: AgentProfile): SlackHomeView {
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: clip(profile.name, 150) } },
    section(`*${escapeSlack(profile.role)}*\n${STATUS[profile.status]}`),
  ];

  if (profile.current) {
    const { title, url } = profile.current;
    const label =
      url && /^https?:\/\//.test(url) ? `<${url}|${escapeSlack(title)}>` : escapeSlack(title);

    blocks.push(section(`*Current work*\n${label}`));
  }

  for (const s of (profile.sections ?? []).slice(0, 40)) {
    blocks.push(
      { type: "divider" },
      section(`*${escapeSlack(s.heading)}*\n${s.lines.map(toMrkdwn).join("\n") || "_Nothing._"}`),
    );
  }

  return { type: "home", blocks };
}

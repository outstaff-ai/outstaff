import { z } from "zod";
import { defineVerb, result } from "./define.js";
import type { PrListRequest, PrListResult } from "./office.types.js";
import { repoLabel, requireOffice, resolveRepo } from "./support.js";
import { key } from "./ticket-support.js";

type ListedPr = PrListResult["prs"][number];

function prLine(p: ListedPr): string {
  const notes = [
    p.draft ? "draft" : "",
    `CI ${p.ci}`,
    `review ${p.review ? p.review.replaceAll("_", " ") : "none"}`,
    p.state === "open" && p.mergeable === "conflicting" ? "conflicts" : "",
    p.unresolvedThreads > 0 ? `${p.unresolvedThreads} open threads` : "",
    p.ticket ? `ticket ${p.ticket}` : "no ticket",
    `by ${p.author}`,
  ].filter(Boolean);

  return `- ${p.ref} [${p.state}] ${p.title} · ${notes.join(" · ")}${p.url ? ` · ${p.url}` : ""}`;
}

/** The filters in words. */
const described = (f: PrListRequest) =>
  [
    `state ${f.state}`,
    f.author && `author ${f.author}`,
    f.ticket && `ticket ${f.ticket}`,
    f.repo && `repository ${f.repo}`,
  ]
    .filter(Boolean)
    .join(", ");

export const prList = defineVerb({
  name: "pr.list",
  summary: "List the team's pull requests: open ones and recently merged or closed ones.",
  description:
    "Lists the pull requests of the team's repositories as the office tracks them now: number, title, state, CI state, review state, linked ticket, author and URL. Open ones first, then the recently merged or closed ones the office still keeps. Use it to answer what is open, waiting or merged from the current state rather than from earlier messages.",
  input: z.strictObject({
    state: z
      .enum(["open", "merged", "closed", "all"])
      .default("all")
      .describe("open, merged, closed, or all (open and recently finished)."),
    author: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('"me", a teammate\'s handle, or a code host login.'),
    ticket: key.optional().describe("Only pull requests linked to this ticket."),
    repo: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe("Only this repository: its name in team.yaml or owner/name."),
    limit: z.number().int().min(1).max(100).default(25).describe("How many to show."),
  }),
  args: [],
  examples: [
    "ost pr list",
    "ost pr list --state open --author me",
    "ost pr list --ticket ACME-12",
    "ost pr list --state merged --repo shop",
  ],
  async run(env, input) {
    const office = requireOffice(env);
    const repo = input.repo ? repoLabel(resolveRepo(env, input.repo)) : undefined;
    const filter = {
      state: input.state,
      limit: input.limit,
      ...(input.author ? { author: input.author } : {}),
      ...(input.ticket ? { ticket: input.ticket } : {}),
      ...(repo ? { repo } : {}),
    };

    const r = await office.prList(filter);
    const what = described(filter);
    const lines = r.prs.length
      ? [
          `Pull requests (${what}), as the office tracks them now; merged and closed ones only while recent:`,
          ...r.prs.map(prLine),
          ...(r.more > 0
            ? [
                `…and ${r.more} more. Narrow it with --state, --author, --ticket or --repo, or raise --limit.`,
              ]
            : []),
        ]
      : [`No pull requests match (${what}).`];

    return result(
      lines,
      r,
      r.prs.flatMap((p) => (p.url ? [p.url] : [])),
    );
  },
});

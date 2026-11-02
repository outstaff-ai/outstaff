import { PortError } from "@outstaff/core";
import { z } from "zod";
import { readInputFile } from "./files.js";
import { mentionGuard } from "./mentions.js";
import { requireTracker, ticketLinker } from "./support.js";
import { defineVerb, result } from "./define.js";
import { key, summary } from "./ticket-support.js";
import type { AgentEnv, VerbContext } from "./types.js";

const MAX_DESCRIPTION = 50_000;

/** The new description from `description` or `description-file`, as a tracker comment is written; none when neither is given. */
function descriptionOf(
  env: AgentEnv,
  ctx: VerbContext,
  input: { description?: string | undefined; descriptionFile?: string | undefined },
  mentionsUsers: boolean,
): string | undefined {
  if (input.description !== undefined && input.descriptionFile !== undefined) {
    throw new PortError("invalid", "Pass either description or description-file, not both.");
  }

  const text =
    input.descriptionFile === undefined
      ? input.description
      : readInputFile(env, ctx, input.descriptionFile, "description file", false);

  if (text === undefined) {
    return undefined;
  }

  if (text.length > MAX_DESCRIPTION) {
    throw new PortError("invalid", `The description is over ${MAX_DESCRIPTION} characters.`);
  }

  const guarded = mentionsUsers ? mentionGuard(env.team).apply(text) : text;
  return ticketLinker(env).format(guarded, "tracker");
}

export const ticketEdit = defineVerb({
  name: "ticket.edit",
  summary: "Change a ticket's title or description.",
  description:
    "Changes the title, the description, or both, of an existing ticket; what you leave out stays as it is. The description is replaced as a whole: read it first with ost ticket show and pass the full new text. When a decision changes a ticket's scope or approach, edit the title and description so they say what will be done, and comment the decision too: a reader trusts the description, not the comments. Change the ticket that exists; never file a new one for the same work.",
  input: z.strictObject({
    key,
    title: z.string().trim().min(1).max(300).optional().describe("New title."),
    description: z
      .string()
      .max(MAX_DESCRIPTION)
      .optional()
      .describe("New description, Markdown. Replaces the old one. Or pass description-file."),
    descriptionFile: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        "File with the new description (in the worktree or your scratch directory; the read policy applies). Use it for long text.",
      ),
  }),
  args: ["key"],
  examples: [
    'ost ticket edit ACME-41 --title "Cache the search results in Redis"',
    "ost ticket edit ACME-41 --description-file .scratch/acme-41.md",
  ],
  async run(env, input, ctx) {
    const tracker = requireTracker(env);
    const body = descriptionOf(env, ctx, input, !!tracker.mentionsUsers);
    if (input.title === undefined && body === undefined) {
      throw new PortError("invalid", "Pass title, description or description-file.");
    }

    const issue = await tracker.updateIssue(input.key, {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(body === undefined ? {} : { body }),
    });

    const changed =
      input.title === undefined
        ? "description"
        : body === undefined
          ? "title"
          : "title and description";

    const url = tracker.links.issue(issue.key);
    return result([`Changed the ${changed} of ${issue.key}.`, ...summary(issue, url)], { issue }, [
      url,
    ]);
  },
});

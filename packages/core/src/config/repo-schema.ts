import { z } from "zod";
import { d, slug } from "./schema-meta.js";
import { compileTicketLink } from "./ticket-link.js";

const REPO_KINDS = ["primary", "baseline", "infra", "other"] as const;

export const repoSchema = z
  .strictObject({
    name: slug(40, "Short name used to refer to this repository in grants."),
    url: z
      .string()
      .regex(
        /^(https?:\/\/\S+|git@\S+:\S+|[A-Za-z0-9.-]+\/[\w.-]+\/[\w.-]+)$/,
        "Use host/owner/repo, an https:// URL or a git@ address.",
      )
      .meta(d("Repository location: host/owner/repo, an https URL or a git@ address.")),
    kind: z
      .enum(REPO_KINDS)
      .meta(
        d("Role of the repository: primary (the product, at most one), baseline, infra or other."),
      ),
    default_branch: z.string().min(1).default("main").meta(d("Branch that pull requests target.")),
    checks: z
      .array(z.string().trim().min(1, "A check command cannot be empty."))
      .min(1)
      .max(10)
      .optional()
      .meta(
        d(
          "Commands an agent runs before pushing, covering only what a change affects (for example lint and the tests related to changed files). CI runs the full suite. When omitted, agents work out the affected checks themselves.",
        ),
      ),
    conventions: z
      .string()
      .trim()
      .min(1)
      .optional()
      .meta(
        d(
          "How work is done in this repository, as free text: commits, branches, pull request title and body, tests. For repositories whose own files (CONTRIBUTING.md, AGENTS.md, the pull request template) cannot say it. Agents read it in addition to those files.",
        ),
      ),
    ticket_link: z
      .array(
        z
          .string()
          .min(1)
          .max(200)
          .superRefine((pattern, ctx) => {
            const compiled = compileTicketLink(pattern);
            if (typeof compiled === "string") {
              ctx.addIssue({ code: "custom", message: compiled });
            }
          }),
      )
      .min(1)
      .max(10)
      .optional()
      .meta(
        d(
          "Extra ways this repository's pull request body names its ticket, as regular expressions with one {key} placeholder for the ticket key (for example `Ticket: {key}`). A pull request is always linked by the ticket key in its branch name, its title, or a closing keyword in its body (`Closes ACME-12`); these patterns add to the last. A key mentioned in the body in any other way links nothing.",
        ),
      ),
    instructions: z
      .array(
        z
          .string()
          .trim()
          .min(1, "A path cannot be empty.")
          .refine((v) => !v.startsWith("/") && !v.split(/[\\/]/).includes(".."), {
            message: "Use a path inside the repository, relative to its root.",
          }),
      )
      .min(1)
      .max(10)
      .optional()
      .meta(
        d(
          'Extra files in this repository that agents read before they work, relative to its root, for example ["CLAUDE.md"]. A project CLAUDE.md is not loaded into agent sessions unless it is listed here.',
        ),
      ),
    tracker: z
      .strictObject({
        labels: z
          .array(z.string().trim().min(1, "A label cannot be empty."))
          .min(1)
          .max(20)
          .meta(d("Ticket labels that mean the work belongs in this repository.")),
      })
      .optional()
      .meta(
        d(
          "Which tracker tickets this repository serves. Agents use it to decide where a ticket's work goes when the ticket does not name a repository.",
        ),
      ),
  })
  .meta(d("A repository the team works in."));

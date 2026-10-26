import { valid } from "semver";
import { z } from "zod";
import { CONFIG_CODES } from "./codes.js";
import { teamCommandsSchema, toolsSchema } from "../permissions/schema.js";
import { customIssue } from "./issues.js";
import { ruleInputSchema } from "../workflow/rules.js";
import { checkWorkflowConfig } from "../workflow/validate.js";

/** A ticket key such as ACME-12. */
export const TICKET_KEY = "[A-Za-z][A-Za-z0-9]{1,9}-\\d+";

/**
 * Compiles a `ticket_link` pattern: a regular expression with one `{key}` placeholder, matched
 * case-insensitively; the key is the group `key`. Returns the reason when the pattern is unusable.
 */
export function compileTicketLink(pattern: string): RegExp | string {
  if (pattern.split("{key}").length !== 2) {
    return "Use exactly one {key} placeholder for the ticket key.";
  }

  try {
    return new RegExp(pattern.replace("{key}", `(?<key>${TICKET_KEY})`), "gi");
  } catch {
    return "Not a valid regular expression.";
  }
}

const d = (description: string) => ({ description });

const SLUG = /^[a-z][a-z0-9-]*$/;
const REPO_KINDS = ["primary", "baseline", "infra", "other"] as const;
const STATUSES = ["backlog", "ready", "active", "review", "blocked", "done", "canceled"] as const;

const slug = (max: number, description: string) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(SLUG, "Use lowercase letters, digits and dashes, starting with a letter.")
    .meta(d(description));

const humanSchema = z
  .strictObject({
    name: z.string().min(1).meta(d("Display name of the trusted human.")),
    identities: z
      .strictObject({
        vcs: z.string().min(1).optional().meta(d("Username on the VCS host.")),
        tracker: z.string().min(1).optional().meta(d("Username or id in the issue tracker.")),
        chat: z.string().min(1).optional().meta(d("Username or id in the chat workspace.")),
        email: z.string().min(1).optional().meta(d("Email address.")),
      })
      .refine((v) => Object.values(v).some((x) => x !== undefined), {
        message: "Give at least one identity (vcs, tracker, chat or email).",
      })
      .meta(d("How this human is known on each connected system; at least one is required.")),
  })
  .meta(d("A trusted human."));

const repoSchema = z
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
  })
  .meta(d("A repository the team works in."));

const GRANT_KEY = /^(\*|kind:(primary|baseline|infra|other)|[a-z][a-z0-9-]*)$/;

const peopleSchema = z
  .strictObject({
    handle: z
      .string()
      .min(1)
      .max(30)
      .regex(SLUG, "Use lowercase letters, digits and dashes, starting with a letter.")
      .meta(d("Unique lowercase handle; used as the agent's hostname label and mention name.")),
    name: z.string().min(1).meta(d("Display name of the agent.")),
    pronouns: z.string().optional().meta(d("Pronouns shown in the agent's profile.")),
    role: z.string().min(1).meta(d('Catalog role this agent plays, for example "developer".')),
    extends: z
      .array(z.string().min(1))
      .optional()
      .meta(d("Extra catalog roles or skill bundles layered on top of the role.")),
    model: z
      .string()
      .min(1)
      .optional()
      .meta(d("LLM model for this agent; the runtime adapter's default when omitted.")),
    identities: z
      .strictObject({
        vcs: z
          .string()
          .min(1)
          .optional()
          .meta(d('Login of this agent on the VCS host, for example "acme-sam[bot]".')),
        tracker: z
          .string()
          .min(1)
          .optional()
          .meta(d("Username or id of this agent in the issue tracker.")),
        chat: z
          .string()
          .min(1)
          .optional()
          .meta(d("Username or id of this agent in the chat workspace.")),
      })
      .optional()
      .meta(
        d(
          "How this agent is known on each connected system. The office recognizes the agent's own activity only by an exact match with these.",
        ),
      ),
    repos: z
      .record(z.string(), z.enum(["read", "write"]))
      .default({})
      .meta(
        d(
          'Repository access by repo name, "kind:<primary|baseline|infra|other>" or "*"; values are "read" or "write".',
        ),
      ),
    tools: toolsSchema
      .optional()
      .meta(d("Tools for this agent only; they replace team-level tools of the same name.")),
    avatar: z
      .strictObject({
        seed: z.string().optional().meta(d("Seed for a generated avatar.")),
        url: z.url().optional().meta(d("Image URL to use as the avatar.")),
      })
      .optional()
      .meta(d("Avatar settings.")),
  })
  .meta(d("An AI agent on the team."));

export const adapterRefSchema = z
  .looseObject({
    adapter: z.string().min(1).meta(d('Name of the adapter package to use, for example "github".')),
  })
  .meta(
    d("Adapter choice; any other keys are options owned by that adapter. Never put secrets here."),
  );

const integrationsSchema = z
  .strictObject({
    chat: adapterRefSchema.meta(d("Chat adapter where humans and agents talk.")),
    vcs: adapterRefSchema.meta(d("Version control adapter (repositories and pull requests).")),
    runtime: adapterRefSchema.meta(d("LLM runtime adapter that runs the agents.")),
    tracker: adapterRefSchema.optional().meta(d("Issue tracker adapter.")),
    knowledge: adapterRefSchema.optional().meta(d("Knowledge base adapter.")),
    avatars: adapterRefSchema.optional().meta(d("Avatar generation adapter.")),
  })
  .meta(d("Which adapters connect Outstaff to your tools."));

const workflowSchema = z
  .strictObject({
    preset: z
      .enum(["kanban", "scrum", "minimal"])
      .default("kanban")
      .meta(d("Built-in workflow to start from.")),
    statuses: z
      .partialRecord(z.enum(STATUSES), z.string().min(1))
      .optional()
      .meta(d("Maps canonical statuses to the status names used in your tracker.")),
    rules: z
      .array(ruleInputSchema)
      .optional()
      .meta(
        d(
          "Rules added to the preset. A rule with a preset rule's id replaces it; { id, disabled: true } removes it.",
        ),
      ),
    templates: z
      .record(z.string().regex(/^[a-z][a-z0-9_-]*$/), z.string().min(1))
      .optional()
      .meta(
        d(
          "Comment and notification templates by id, with {{variable}} placeholders. They override built-in templates with the same id.",
        ),
      ),
    needs_human_label: z
      .string()
      .min(1)
      .optional()
      .meta(d('Ticket label that keeps work with a human. Default "needs-human".')),
  })
  .meta(d("How work moves through the team."));

const policiesSchema = z
  .strictObject({
    agent_loop_guard: z
      .strictObject({
        max_runs_per_item_per_hour: z
          .int()
          .min(1)
          .default(12)
          .meta(
            d(
              "Maximum runs per work item per hour triggered by agents or automation; humans are never limited.",
            ),
          ),
      })
      .default({ max_runs_per_item_per_hour: 12 })
      .meta(
        d(
          "Stops agents from triggering each other in endless loops. Limits only runs triggered by agents or automation; humans are never limited.",
        ),
      ),
    usage: z
      .strictObject({
        defer_scheduled_at: z
          .number()
          .min(0)
          .max(1)
          .default(0.85)
          .meta(d("Fraction of the usage limit at which scheduled work is deferred.")),
        pause_automatic_at: z
          .number()
          .min(0)
          .max(1)
          .default(0.95)
          .meta(d("Fraction of the usage limit at which all automatic work pauses.")),
        shared: z
          .array(z.array(z.string().min(1)).min(2))
          .optional()
          .meta(
            d(
              "Groups of people who use one LLM subscription, as lists of handles. A usage report from any member applies to all of them.",
            ),
          ),
      })
      .superRefine((v, ctx) => {
        if (v.defer_scheduled_at > v.pause_automatic_at) {
          ctx.addIssue(
            customIssue(
              CONFIG_CODES.usageThresholdOrder,
              "defer_scheduled_at must not exceed pause_automatic_at.",
              ["defer_scheduled_at"],
            ),
          );
        }
      })
      .default({ defer_scheduled_at: 0.85, pause_automatic_at: 0.95 })
      .meta(d("Thresholds that slow down work as the LLM usage limit approaches.")),
    acknowledge: z
      .strictObject({
        chat: z
          .boolean()
          .default(true)
          .meta(
            d(
              "React with eyes to a chat message from a trusted person when the agent has seen it. Default on.",
            ),
          ),
        vcs: z
          .boolean()
          .default(true)
          .meta(
            d(
              "React with eyes to each pull request comment the agent is about to answer, when its round starts. Needs a vcs adapter with vcs.reactions. Default on.",
            ),
          ),
      })
      .default({ chat: true, vcs: true })
      .meta(d("The reactions that show people their message or comment was picked up.")),
    feedback: z
      .strictObject({
        follow_up_round: z
          .boolean()
          .default(true)
          .meta(
            d(
              "Start another round when feedback arrived after the agent was offered its work. Default on.",
            ),
          ),
        merged_prs: z
          .boolean()
          .default(true)
          .meta(
            d(
              "Schedule the author to answer feedback on a merged pull request. Switches the preset rule merged-feedback-follow-up. Default on.",
            ),
          ),
      })
      .default({ follow_up_round: true, merged_prs: true })
      .meta(d("How agents act on feedback from trusted people beyond the first round.")),
    hand_back: z
      .strictObject({
        reassign: z
          .enum(["requester", "none"])
          .default("requester")
          .meta(
            d(
              "Who an agent's hand-back assigns the ticket to: the requester, or none to leave the assignee alone (the ticket still moves: to review when done, to blocked when blocked). Edits the preset rules hand-back-to-requester and hand-back-blocked-to-requester. Default requester.",
            ),
          ),
        fallback: z
          .enum(["first_human", "none"])
          .default("first_human")
          .meta(
            d(
              "Who stands in when a ticket has no known requester: the first human in humans, or none to skip. Default first_human.",
            ),
          ),
      })
      .default({ reassign: "requester", fallback: "first_human" })
      .meta(d("What happens to a ticket when an agent hands its work back.")),
    tickets: z
      .strictObject({
        prs_per_ticket: z
          .enum(["one", "many"])
          .default("one")
          .meta(
            d(
              "How many pull requests a ticket may have. one: ost pr open refuses a second one for a ticket and the ticket moves to done when its pull request merges; many: several are allowed and the ticket moves to done when the agent hands its work back as done and every pull request linked to it is closed with at least one merged. Edits the preset rules pr-merged-done, pr-closed-ready, hand-back-to-requester and second-pr-comment. Default one.",
            ),
          ),
      })
      .default({ prs_per_ticket: "one" })
      .meta(d("How tickets and pull requests relate.")),
    conflicts: z
      .strictObject({
        follow_up: z
          .boolean()
          .default(true)
          .meta(
            d(
              "Send a pull request that starts to conflict with its base, for example after another one merged, back to its agent author to rebase. Switches the preset rule conflict-back-to-author. Default on.",
            ),
          ),
      })
      .default({ follow_up: true })
      .meta(d("Merge conflicts between pull requests.")),
    retry: z
      .strictObject({
        on_signal: z
          .boolean()
          .default(true)
          .meta(
            d(
              "Retry a blocked work item when a trusted human moves its ticket, assigns it, reviews or comments on its pull request, or replies in its chat thread. Default on.",
            ),
          ),
        base_minutes: z
          .int()
          .min(1)
          .default(1)
          .meta(d("Wait after the first failed run of a work item; doubles with each failure.")),
        cap_minutes: z
          .int()
          .min(1)
          .default(30)
          .meta(d("Longest wait between two attempts at a failing work item.")),
        max_failures: z
          .int()
          .min(1)
          .default(3)
          .meta(
            d(
              "Consecutive failed runs after which the work item is blocked and its requester told.",
            ),
          ),
      })
      .superRefine((v, ctx) => {
        if (v.base_minutes > v.cap_minutes) {
          ctx.addIssue(
            customIssue(
              CONFIG_CODES.retryBackoffOrder,
              "base_minutes must not exceed cap_minutes.",
              ["base_minutes"],
            ),
          );
        }
      })
      .default({ on_signal: true, base_minutes: 1, cap_minutes: 30, max_failures: 3 })
      .meta(
        d(
          "How a failing work item is retried: exponential backoff, then blocked; and whether a human's signal brings a blocked item back.",
        ),
      ),
    messages: z
      .strictObject({
        max_lines: z
          .int()
          .min(1)
          .max(20)
          .default(3)
          .meta(
            d(
              "Guidance for agents: keep chat replies to about this many lines. It is a hard limit only for the office's own automatic notices (status lines, run notifications). An agent's reply is never cut; one over a high safety cap is split into several messages.",
            ),
          ),
        always_link: z
          .boolean()
          .default(true)
          .meta(d("Link tickets, pull requests and documents instead of mentioning bare ids.")),
        omit: z
          .array(z.enum(["ci", "mergeability", "hashes", "file_lists"]))
          .default(["ci", "mergeability", "hashes"])
          .meta(d("Details left out of chat messages.")),
      })
      .default({ max_lines: 3, always_link: true, omit: ["ci", "mergeability", "hashes"] })
      .meta(d("How agents write chat messages.")),
    design: z
      .strictObject({
        canvas: z
          .boolean()
          .default(true)
          .meta(
            d(
              "Let roles that declare the design.canvas capability use Claude's Artifact tools (the Design canvas). Needs the claude-agent-sdk runtime signed in with a Claude account. Default on; it does nothing for a role without the capability.",
            ),
          ),
      })
      .default({ canvas: true })
      .meta(d("What design roles may use.")),
    chat: z
      .strictObject({
        parallel_sessions: z
          .int()
          .min(1)
          .max(10)
          .default(2)
          .meta(
            d(
              "How many chat sessions an agent runs at once, beside its active work item. A message beyond that waits for a free session.",
            ),
          ),
        profile: z
          .boolean()
          .default(true)
          .meta(
            d(
              "Publish the agent's profile in chat: role, status, and current work grouped by ticket or pull request. Needs a chat adapter with chat.agentProfile. Default on.",
            ),
          ),
      })
      .default({ parallel_sessions: 2, profile: true })
      .meta(d("How agents take chat messages, and what they show in chat.")),
    commands: teamCommandsSchema.optional(),
  })
  .meta(d("Team-wide guardrails, message style and switches for what outstaff does on its own."));

export const teamConfigSchema = z
  .strictObject({
    version: z.literal(1).meta(d("Schema version of this file; currently 1.")),
    team: z
      .strictObject({
        name: slug(40, "Team slug: lowercase letters, digits and dashes, starting with a letter."),
        product: z.string().optional().meta(d("Name of the product the team builds.")),
        description: z.string().optional().meta(d("One-line description of the team.")),
      })
      .meta(d("Who the team is.")),
    humans: z
      .array(humanSchema)
      .optional()
      .meta(
        d(
          "Trusted humans. Optional; when omitted, trusted humans are repo writers and full chat-workspace members.",
        ),
      ),
    catalog: z
      .strictObject({
        version: z
          .string()
          .min(1)
          .refine((v) => valid(v) === v, {
            message: "Must be an exact semver version, for example 1.0.0.",
            params: { code: CONFIG_CODES.catalogInvalidVersion },
          })
          .meta(
            d(
              'Exact catalog release this team uses, for example "1.0.0"; must match the catalog in the agent images.',
            ),
          ),
        path: z
          .string()
          .min(1)
          .default("catalog")
          .meta(d("Directory of ejected catalog files, relative to this file.")),
      })
      .meta(d("Which catalog of roles and skills the team uses.")),
    repos: z.array(repoSchema).min(1).meta(d("Repositories the team works in; at least one.")),
    people: z.array(peopleSchema).meta(d("The agents on the team; may be empty.")),
    integrations: integrationsSchema,
    email: z
      .strictObject({
        pattern: z
          .string()
          .refine((v) => v.includes("{handle}"), {
            message: 'Must contain "{handle}".',
            params: { code: CONFIG_CODES.emailMissingPlaceholder },
          })
          .meta(d('Address pattern for agents, for example "{handle}@acme.example".')),
      })
      .optional()
      .meta(d("Email addresses for agents.")),
    office: z
      .strictObject({
        events: z
          .enum(["poll", "webhook"])
          .default("poll")
          .meta(d("How the office learns about changes: polling or webhooks.")),
        poll_interval_seconds: z
          .int()
          .min(10)
          .max(3600)
          .default(60)
          .meta(d('Seconds between polls when events is "poll".')),
        poll_warn_after_minutes: z
          .int()
          .min(1)
          .max(1440)
          .optional()
          .meta(
            d(
              "Minutes without a successful poll of an event source before the office logs a warning. Default 10.",
            ),
          ),
        channel: z
          .string()
          .min(1)
          .optional()
          .meta(
            d(
              "Team chat channel where the office mirrors agent-to-agent questions and answers, so humans can follow them. Without it they go to the ticket of the asking work item, or only to its journal.",
            ),
          ),
      })
      .optional()
      .meta(d("Office event intake settings.")),
    tools: toolsSchema
      .optional()
      .meta(d("Tools every agent of the team installs at start, with the commands they may run.")),
    workflow: workflowSchema.optional(),
    policies: policiesSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    const seenRepos = new Map<string, number>();
    let primary = -1;
    cfg.repos.forEach((r, i) => {
      if (seenRepos.has(r.name)) {
        ctx.addIssue(
          customIssue(
            CONFIG_CODES.reposDuplicateName,
            `Repo name "${r.name}" is already used by repos[${seenRepos.get(r.name)}].`,
            ["repos", i, "name"],
          ),
        );
      } else {
        seenRepos.set(r.name, i);
      }

      if (r.kind === "primary") {
        if (primary >= 0) {
          ctx.addIssue(
            customIssue(
              CONFIG_CODES.reposMultiplePrimary,
              `Only one repo may have kind "primary"; repos[${primary}] already does.`,
              ["repos", i, "kind"],
            ),
          );
        } else {
          primary = i;
        }
      }
    });

    if (cfg.workflow) {
      for (const i of checkWorkflowConfig(cfg.workflow)) {
        ctx.addIssue(customIssue(i.code, i.message, i.path));
      }
    }

    const handles = new Set(cfg.people.map((p) => p.handle));
    const grouped = new Set<string>();
    cfg.policies?.usage.shared?.forEach((group, g) => {
      group.forEach((handle, n) => {
        const path = ["policies", "usage", "shared", g, n];
        if (!handles.has(handle)) {
          ctx.addIssue(
            customIssue(
              CONFIG_CODES.usageSharedUnknownPerson,
              `Usage group refers to unknown person "${handle}".`,
              path,
            ),
          );
        } else if (grouped.has(handle)) {
          ctx.addIssue(
            customIssue(
              CONFIG_CODES.usageSharedOverlap,
              `"${handle}" is in more than one usage group (or twice in one); a person has one subscription.`,
              path,
            ),
          );
        }

        grouped.add(handle);
      });
    });

    const seenHandles = new Map<string, number>();
    cfg.people.forEach((p, i) => {
      if (seenHandles.has(p.handle)) {
        ctx.addIssue(
          customIssue(
            CONFIG_CODES.peopleDuplicateHandle,
            `Handle "${p.handle}" is already used by people[${seenHandles.get(p.handle)}].`,
            ["people", i, "handle"],
          ),
        );
      } else {
        seenHandles.set(p.handle, i);
      }

      for (const key of Object.keys(p.repos)) {
        if (!GRANT_KEY.test(key)) {
          ctx.addIssue(
            customIssue(
              CONFIG_CODES.peopleInvalidGrantKey,
              'Use a repo name, "kind:<primary|baseline|infra|other>" or "*".',
              ["people", i, "repos", key],
            ),
          );

          continue;
        }

        if (key === "*" || key.startsWith("kind:") || seenRepos.has(key)) {
          continue;
        }

        ctx.addIssue(
          customIssue(CONFIG_CODES.peopleUnknownRepo, `Grant refers to unknown repo "${key}".`, [
            "people",
            i,
            "repos",
            key,
          ]),
        );
      }
    });
  })
  .meta(d("Outstaff team configuration (.outstaff/team.yaml)."));

export type TeamConfig = z.output<typeof teamConfigSchema>;
export type TeamConfigInput = z.input<typeof teamConfigSchema>;

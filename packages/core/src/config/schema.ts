import { valid } from "semver";
import { z } from "zod";
import { CONFIG_CODES } from "./codes.js";
import { customIssue } from "./issues.js";

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
    repos: z
      .record(z.string(), z.enum(["read", "write"]))
      .default({})
      .meta(
        d(
          'Repository access by repo name, "kind:<primary|baseline|infra|other>" or "*"; values are "read" or "write".',
        ),
      ),
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
    mail: adapterRefSchema.optional().meta(d("Mailbox adapter.")),
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
      .array(z.looseObject({}))
      .optional()
      .meta(d("Custom workflow rules; their shape is defined by the workflow engine.")),
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
    messages: z
      .strictObject({
        max_lines: z
          .int()
          .min(1)
          .max(20)
          .default(3)
          .meta(d("Maximum lines in a chat message from an agent.")),
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
  })
  .meta(d("Team-wide guardrails and message style."));

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
      })
      .optional()
      .meta(d("Office event intake settings.")),
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

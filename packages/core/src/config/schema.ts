import { valid } from "semver";
import { z } from "zod";
import { CONFIG_CODES } from "./codes.js";
import { toolsSchema } from "#/permissions/schema.js";
import { customIssue } from "./issues.js";
import { integrationsSchema } from "./integrations-schema.js";
import { roleOverridesSchema } from "./network.js";
import { humanSchema, peopleSchema } from "./people-schema.js";
import { policiesSchema } from "./policies-schema.js";
import { repoSchema } from "./repo-schema.js";
import { d, slug, SLUG } from "./schema-meta.js";
import { workflowSchema } from "./workflow-schema.js";
import { linkSchema } from "./link.js";
import { pipelineSchema } from "./pipeline.js";
import { checkWorkflowConfig } from "#/workflow/validate.js";

const GRANT_KEY = /^(\*|kind:(primary|baseline|infra|other)|[a-z][a-z0-9-]*)$/;

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
        pipeline: z
          .enum(["off", "shadow", "live"])
          .optional()
          .meta(
            d(
              "Proposed (decision 0016): shadow runs every event through the event pipeline as well and only records its decisions, for `ost explain`; live lets the pipeline decide instead of the workflow rules, queueing its wakes and making its tracker changes as the office, on behalf of the agent each is for. Default off.",
            ),
          ),
      })
      .optional()
      .meta(d("Office event intake settings.")),
    tools: toolsSchema
      .optional()
      .meta(d("Tools every agent of the team installs at start, with the commands they may run.")),
    roles: z
      .record(
        z.string().regex(SLUG, "Use a role name: lowercase letters, digits and dashes."),
        roleOverridesSchema,
      )
      .optional()
      .meta(d("Settings per catalog role, for everyone who plays it.")),
    workflow: workflowSchema.optional(),
    pipeline: pipelineSchema.optional(),
    link: linkSchema.optional(),
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

    cfg.policies?.merge.repos?.forEach((name, n) => {
      if (!seenRepos.has(name)) {
        ctx.addIssue(
          customIssue(
            CONFIG_CODES.mergeUnknownRepo,
            `policies.merge.repos refers to unknown repo "${name}".`,
            ["policies", "merge", "repos", n],
          ),
        );
      }
    });

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

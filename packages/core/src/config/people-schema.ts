import { z } from "zod";
import { toolsSchema } from "../permissions/schema.js";
import { networkSchema } from "./network.js";
import { d, SLUG } from "./schema-meta.js";

export const humanSchema = z
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

export const peopleSchema = z
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
    network: networkSchema
      .optional()
      .meta(d("Network grants for this agent, merged over those of its roles.")),
    avatar: z
      .strictObject({
        seed: z.string().optional().meta(d("Seed for a generated avatar.")),
        url: z.url().optional().meta(d("Image URL to use as the avatar.")),
      })
      .optional()
      .meta(d("Avatar settings.")),
  })
  .meta(d("An AI agent on the team."));

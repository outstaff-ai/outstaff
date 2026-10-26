import { z } from "zod";
import { d } from "./schema-meta.js";

export const adapterRefSchema = z
  .looseObject({
    adapter: z.string().min(1).meta(d('Name of the adapter package to use, for example "github".')),
  })
  .meta(
    d("Adapter choice; any other keys are options owned by that adapter. Never put secrets here."),
  );

export const integrationsSchema = z
  .strictObject({
    chat: adapterRefSchema.meta(d("Chat adapter where humans and agents talk.")),
    vcs: adapterRefSchema.meta(d("Version control adapter (repositories and pull requests).")),
    runtime: adapterRefSchema.meta(d("LLM runtime adapter that runs the agents.")),
    tracker: adapterRefSchema.optional().meta(d("Issue tracker adapter.")),
    knowledge: adapterRefSchema.optional().meta(d("Knowledge base adapter.")),
    avatars: adapterRefSchema.optional().meta(d("Avatar generation adapter.")),
  })
  .meta(d("Which adapters connect Outstaff to your tools."));

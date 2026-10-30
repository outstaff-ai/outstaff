import { z } from "zod";
import { d } from "./schema-meta.js";

const STATUSES = ["backlog", "ready", "active", "review", "blocked", "done", "canceled"] as const;

export const workflowSchema = z
  .strictObject({
    statuses: z
      .partialRecord(z.enum(STATUSES), z.string().min(1))
      .optional()
      .meta(d("Maps canonical statuses to the status names used in your tracker.")),
    needs_human_label: z
      .string()
      .min(1)
      .optional()
      .meta(d('Ticket label that keeps work with a human. Default "needs-human".')),
  })
  .meta(d("How the tracker's statuses and labels map onto outstaff's."));

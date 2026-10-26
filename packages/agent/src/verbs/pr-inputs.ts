import { z } from "zod";

export const repo = z
  .string()
  .min(1)
  .max(300)
  .describe("Repository: its name in team.yaml (for example shop) or host/owner/name.");

export const number = z.number().int().min(1).describe("Pull request number.");

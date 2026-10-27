import { z } from "zod";
import { MEMBER_STATUSES } from "#/constants.js";

export const usageWindowSchema = z.strictObject({
  name: z.string().min(1).max(50).describe("Which limit, for example five_hour or seven_day."),
  utilization: z.number().min(0).describe("Fraction of the limit used; 1 is the limit."),
  resetsAt: z.string().optional().describe("ISO-8601 time at which the window resets."),
});

export const memberUsageSchema = z.strictObject({
  window: z.string().describe("The busiest window."),
  utilization: z.number().describe("Fraction of that window's limit used."),
  resetsAt: z.string().optional().describe("ISO-8601 time at which that window resets."),
});

export const memberSchema = z.strictObject({
  handle: z.string(),
  name: z.string(),
  role: z.string(),
  title: z.string().optional().describe("Display title of the role, for example Developer."),
  summary: z.string().optional().describe("One line on what the role does."),
  status: z.enum(MEMBER_STATUSES),
  current: z.string().optional().describe("What the person is working on."),
  usage: memberUsageSchema
    .optional()
    .describe("The person's busiest LLM usage window, when it was reported recently."),
});

export const humanSchema = z.strictObject({
  name: z.string(),
});

export const answerStateSchema = z.strictObject({
  id: z.string().describe("Id of the question."),
  to: z.string(),
  status: z.enum(["answered", "pending"]),
  answer: z.string().optional(),
});

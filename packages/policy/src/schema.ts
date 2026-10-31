import { z } from "zod";
import { PIPELINE_EVENT_TYPES } from "./events.js";
import { instructionProblem } from "./instructions.js";

/** The ops an act may make: bookkeeping only. Anything that needs judgement is a wake. */
export const BOOKKEEPING_OPS = ["move", "assign", "set_parent", "link_pr"] as const;

/** A policy id: lowercase letters, digits and underscores, starting with a letter. */
export const POLICY_ID = /^[a-z][a-z0-9_]*$/;

const STATUSES = ["backlog", "ready", "active", "review", "blocked", "done", "canceled"] as const;
const text = z.string().min(1);

const instruction = text.superRefine((value, ctx) => {
  const problem = instructionProblem(value);
  if (problem) {
    ctx.addIssue({ code: "custom", message: problem });
  }
});

/** What `definePolicy` and the custom policy loader accept. */
export const policySchema = z.looseObject({
  id: z.string().regex(POLICY_ID, "use lowercase letters, digits and underscores"),
  summary: text,
  on: z.array(z.enum(PIPELINE_EVENT_TYPES)).min(1),
  when: z.record(z.string(), z.unknown()).optional(),
  instruction: instruction.optional(),
  decides: text.optional(),
  priority: z.int().optional(),
  decide: z.custom<(...args: unknown[]) => unknown>((v) => typeof v === "function", {
    message: "must be a function",
  }),
});

const subject = z.strictObject({ type: z.enum(["pr", "ticket", "doc", "chat"]), ref: text });
const target = z.strictObject({ kind: z.enum(["agent", "human"]), id: text });

/** An op outside the bookkeeping set passes the shape check, so the office can reject it by name. */
const op = z.union([
  z.strictObject({ op: z.literal("move"), ticket: text, to: z.enum(STATUSES) }),
  z.strictObject({ op: z.literal("assign"), ticket: text, to: target.nullable() }),
  z.strictObject({ op: z.literal("set_parent"), ticket: text, parent: text }),
  z.strictObject({
    op: z.literal("link_pr"),
    ticket: text,
    pr: z.strictObject({
      repo: z.strictObject({ owner: text, name: text, host: text.optional() }),
      number: z.int().positive(),
      url: text.optional(),
    }),
  }),
  z.looseObject({
    op: z.string().refine((o) => !(BOOKKEEPING_OPS as readonly string[]).includes(o)),
  }),
]);

/** A proposal as a policy returns it. */
export const proposalSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("wake"),
    person: text,
    kind: text,
    instruction: z.string(),
    subject: subject.optional(),
    reason: text,
  }),
  z.strictObject({
    type: z.literal("act"),
    as: text,
    ops: z.array(op).min(1),
    note: z.string().optional(),
    reason: text,
  }),
  z.strictObject({ type: z.literal("drop"), reason: text }),
  z.strictObject({
    type: z.literal("suppress"),
    person: text,
    subject: subject.optional(),
    kind: text.optional(),
    reason: text,
  }),
]);

import { z } from "zod";
import { DEFAULT_STYLE, STYLE_IDS } from "./styles.js";

const hex = z
  .string()
  .regex(/^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Use a hex color such as b6e3f4.");

export const dicebearOptions = z.strictObject({
  style: z.enum(STYLE_IDS).default(DEFAULT_STYLE),
  background: z.array(hex).min(1).optional(),
  size: z.number().int().min(16).max(2048).optional(),
});

export type DicebearOptions = z.output<typeof dicebearOptions>;

export const directoryOptions = z.strictObject({
  path: z.string().min(1),
});

export type DirectoryOptions = z.output<typeof directoryOptions>;

export const urlOptions = z.strictObject({
  template: z
    .string()
    .refine((t) => t.includes("{seed}"), "Include {seed} where the person's seed goes.")
    .refine((t) => URL.canParse(t.replace("{seed}", "x")), "Must be a valid URL."),
});

export type UrlOptions = z.output<typeof urlOptions>;

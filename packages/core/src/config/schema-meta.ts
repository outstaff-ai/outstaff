import { z } from "zod";

export const d = (description: string) => ({ description });

export const SLUG = /^[a-z][a-z0-9-]*$/;

export const slug = (max: number, description: string) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(SLUG, "Use lowercase letters, digits and dashes, starting with a letter.")
    .meta(d(description));

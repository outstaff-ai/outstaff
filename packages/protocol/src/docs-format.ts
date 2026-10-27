import { z } from "zod";
import type { JsonSchema } from "./docs-format.types.js";

export function typeOf(s: JsonSchema): string {
  if (s.enum) {
    return s.enum.map((v) => `\`${String(v)}\``).join(" or ");
  }

  if (s.anyOf) {
    return s.anyOf.map(typeOf).join(" or ");
  }

  if (s.type === "array" && s.items) {
    return `list of ${typeOf(s.items)}`;
  }

  if (s.type === "object" && s.properties) {
    return `object (${Object.keys(s.properties).join(", ")})`;
  }

  return Array.isArray(s.type) ? s.type.join(" or ") : (s.type ?? "any");
}

export const escape = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");

/** A table padded the way the formatter writes it, so the committed page stays formatted. */
export function table(rows: string[][]): string[] {
  const widths = (rows[0] ?? []).map((_, i) =>
    Math.max(3, ...rows.map((r) => (r[i] ?? "").length)),
  );

  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" | ")} |`;
  const [head, ...body] = rows;
  return [
    line(head ?? []),
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...body.map(line),
  ];
}

/** One row per field; fields of nested objects get dotted names, and `[]` marks list items. */
export function fieldRows(s: JsonSchema, prefix: string): string[][] {
  return Object.entries(s.properties ?? {}).flatMap(([name, field]) => {
    const required = s.required?.includes(name) ? "yes" : "no";
    const path = `${prefix}${name}`;
    const item = field.type === "array" ? field.items : undefined;
    const nested = field.properties ? field : item?.properties ? item : undefined;
    const type = nested ? (item ? "list of objects" : "object") : typeOf(field);
    const row = [`\`${path}\``, escape(type), required, escape(field.description ?? "")];
    return nested ? [row, ...fieldRows(nested, `${path}${item ? "[]" : ""}.`)] : [row];
  });
}

/** The JSON Schema of a payload, as the reference pages list its fields. */
export const payloadSchema = (payload: z.ZodType): JsonSchema =>
  z.toJSONSchema(payload, { io: "input" }) as JsonSchema;

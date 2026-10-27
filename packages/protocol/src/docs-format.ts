import { z } from "zod";
import type { JsonSchema } from "./docs-format.types.js";

export function typeOf(s: JsonSchema): string {
  if (s.enum) {
    return s.enum.map((v) => `\`${String(v)}\``).join(" or ");
  }

  if (s.anyOf) {
    return s.anyOf.map(typeOf).join(" or ");
  }

  return containerType(s) ?? plainType(s);
}

/** A list or an object, described by its items or its fields. */
function containerType(s: JsonSchema): string | undefined {
  if (s.type === "array" && s.items) {
    return `list of ${typeOf(s.items)}`;
  }

  if (s.type === "object" && s.properties) {
    return `object (${Object.keys(s.properties).join(", ")})`;
  }

  return undefined;
}

const plainType = (s: JsonSchema) =>
  Array.isArray(s.type) ? s.type.join(" or ") : (s.type ?? "any");

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

const listItems = (field: JsonSchema) => (field.type === "array" ? field.items : undefined);

/** The schema whose fields are documented under a field: its own, or those of its list items. */
const nestedOf = (field: JsonSchema, item?: JsonSchema) =>
  field.properties ? field : item?.properties ? item : undefined;

/** One row per field; fields of nested objects get dotted names, and `[]` marks list items. */
export function fieldRows(s: JsonSchema, prefix: string): string[][] {
  return Object.entries(s.properties ?? {}).flatMap(([name, field]) => {
    const required = s.required?.includes(name) ? "yes" : "no";
    const path = `${prefix}${name}`;
    const item = listItems(field);
    const nested = nestedOf(field, item);
    if (!nested) {
      return [[`\`${path}\``, escape(typeOf(field)), required, escape(field.description ?? "")]];
    }

    const type = item ? "list of objects" : "object";
    const row = [`\`${path}\``, type, required, escape(field.description ?? "")];
    return [row, ...fieldRows(nested, `${path}${item ? "[]" : ""}.`)];
  });
}

/** The JSON Schema of a payload, as the reference pages list its fields. */
export const payloadSchema = (payload: z.ZodType): JsonSchema =>
  z.toJSONSchema(payload, { io: "input" }) as JsonSchema;

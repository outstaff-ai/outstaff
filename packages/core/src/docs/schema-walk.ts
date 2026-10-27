import type { Schema } from "./types.js";

export const asSchema = (value: unknown): Schema | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Schema) : undefined;

const asList = (value: unknown): Schema[] =>
  Array.isArray(value) ? value.map((v) => asSchema(v)).filter((v) => v !== undefined) : [];

const code = (value: unknown) => `\`${typeof value === "string" ? value : JSON.stringify(value)}\``;

/** Inlines $ref and single-entry allOf; returns undefined for a ref already being expanded. */
function resolve(node: Schema, root: Schema, stack: string[]): Schema | undefined {
  let current = node;
  const ref = current["$ref"];
  if (typeof ref === "string") {
    if (stack.includes(ref)) {
      return undefined;
    }

    const name = ref.replace("#/definitions/", "");
    const target = asSchema(asSchema(root["definitions"])?.[name]);
    if (!target) {
      return current;
    }

    stack.push(ref);
    const { $ref: _ref, ...rest } = current;
    return { ...target, ...rest };
  }

  const all = asList(current["allOf"]);
  if (all.length === 1 && all[0]) {
    const { allOf: _allOf, ...rest } = current;
    const inner = resolve(all[0], root, stack);
    current = inner ? { ...inner, ...rest } : rest;
  }

  return current;
}

function typeOf(node: Schema, root: Schema, stack: string[]): string {
  const resolved = resolve(node, root, [...stack]);
  if (!resolved) {
    return "condition";
  }

  const variants = asList(resolved["anyOf"]);
  if (variants.length > 0) {
    const parts = variants.map((v) => typeOf(v, root, stack));
    return [...new Set(parts)].join(" or ");
  }

  return "const" in resolved ? typeof resolved["const"] : declaredType(resolved, root, stack);
}

function declaredType(resolved: Schema, root: Schema, stack: string[]): string {
  const type = resolved["type"];
  if (type === "array") {
    const items = asSchema(resolved["items"]);
    return `list of ${items ? typeOf(items, root, stack) : "values"}`;
  }

  if (type === "object") {
    return resolved["properties"] ? "object" : "map";
  }

  return typeof type === "string" ? type : "any";
}

function constraints(node: Schema): string[] {
  const out: string[] = [];
  const bound = (key: string, label: string) => {
    const value = node[key];
    if (typeof value === "number" && value !== Number.MAX_SAFE_INTEGER) {
      out.push(`${label} ${value}`);
    }
  };

  bound("minimum", "Minimum");
  bound("maximum", "Maximum");
  bound("minLength", "Minimum length");
  bound("maxLength", "Maximum length");
  bound("minItems", "Minimum items");
  if (typeof node["pattern"] === "string") {
    out.push(`Must match ${code(node["pattern"])}`);
  }

  return out;
}

function enumValues(node: Schema): unknown[] | undefined {
  if (Array.isArray(node["enum"])) {
    return node["enum"];
  }

  const items = asSchema(node["items"]);
  if (items && Array.isArray(items["enum"])) {
    return items["enum"];
  }

  const found = asList(node["anyOf"]).flatMap((v) => enumValues(v) ?? []);
  return found.length > 0 ? [...new Set(found)] : undefined;
}

type Child = { segment: string; node: Schema; required: boolean };

/** The children of a node and of each of its variants: properties, a keyed map's entries and list items. */
function children(node: Schema, root: Schema, stack: string[]): Child[] {
  const resolved = resolve(node, root, [...stack]);
  if (!resolved) {
    return [];
  }

  return [
    ...ownChildren(resolved),
    ...asList(resolved["anyOf"]).flatMap((variant) => children(variant, root, stack)),
  ];
}

function ownChildren(resolved: Schema): Child[] {
  const required = new Set(
    Array.isArray(resolved["required"]) ? (resolved["required"] as string[]) : [],
  );

  const props = Object.entries(asSchema(resolved["properties"]) ?? {}).flatMap(([key, value]) => {
    const child = asSchema(value);
    return child ? [{ segment: `.${key}`, node: child, required: required.has(key) }] : [];
  });

  const extra = asSchema(resolved["additionalProperties"]);
  const items = asSchema(resolved["items"]);

  return [
    ...props,
    ...(extra && asSchema(extra["properties"])
      ? [{ segment: ".<key>", node: extra, required: false }]
      : []),
    ...(items ? [{ segment: "[]", node: items, required: false }] : []),
  ];
}

/** Rule ids and event names repeat across a variant; keep the first section per path. */
function section(path: string, node: Schema, required: boolean, root: Schema, stack: string[]) {
  const resolved = resolve(node, root, [...stack]) ?? node;
  const depth = path.split(/[.[]/).filter((p) => p !== "]").length;
  const description = typeof resolved["description"] === "string" ? resolved["description"] : "";

  return [
    `${"#".repeat(Math.min(depth + 1, 4))} ${path}`,
    "",
    ...(description ? [description, ""] : []),
    `- Type: ${code(typeOf(resolved, root, stack))}`,
    `- ${required ? "Required" : "Optional"}`,
    ...facts(resolved).map((fact) => `- ${fact}`),
  ].join("\n");
}

/** What else a section says: default, fixed value, allowed values and keys, and constraints. */
function facts(resolved: Schema): string[] {
  const values = enumValues(resolved);
  const names = asSchema(resolved["propertyNames"]);
  const keys = names && Array.isArray(names["enum"]) ? (names["enum"] as unknown[]) : undefined;

  return [
    ...("default" in resolved ? [`Default: ${code(resolved["default"])}`] : []),
    ...("const" in resolved ? [`Must be ${code(resolved["const"])}`] : []),
    ...(values ? [`Allowed values: ${values.map((v) => code(v)).join(", ")}`] : []),
    ...(keys ? [`Allowed keys: ${keys.map((v) => code(v)).join(", ")}`] : []),
    ...constraints(resolved),
  ];
}

export function walk(path: string, node: Schema, required: boolean, root: Schema, out: string[]) {
  walkWith(path, node, required, root, out, [], new Set());
}

function walkWith(
  path: string,
  node: Schema,
  required: boolean,
  root: Schema,
  out: string[],
  stack: string[],
  seen: Set<string>,
) {
  if (seen.has(path)) {
    return;
  }

  seen.add(path);
  const next = [...stack];
  const resolved = resolve(node, root, next);
  out.push(section(path, node, required, root, stack));
  if (!resolved) {
    return;
  }

  for (const child of children(resolved, root, next)) {
    walkWith(`${path}${child.segment}`, child.node, child.required, root, out, next, seen);
  }
}

import { CATALOG_CODES, CatalogError, type CatalogIssue } from "./codes.js";

/**
 * Strict template language for catalog markdown.
 *
 *   {{ path.to.value }}                       value (string, number, boolean)
 *   {{#if path}}..{{else}}..{{/if}}           else is optional
 *   {{#unless path}}..{{/unless}}
 *   {{#each path}}{{this}} {{this.field}} {{@index}}{{/each}}
 *   \{{                                        a literal "{{"
 *
 * There are no expressions, helpers or escaping (the output is markdown).
 * A path that does not exist in the context is an error, also in `#if`, so a
 * typo never silently hides text. A key that exists with a null, empty or false
 * value is fine: it renders as nothing and counts as false. Block tags that
 * sit alone on their line take the whole line with them.
 */

type Pos = { line: number; column: number };
type Node =
  | { t: "text"; text: string }
  | { t: "var"; path: string; pos: Pos }
  | { t: "if" | "unless"; path: string; pos: Pos; body: Node[]; otherwise: Node[] }
  | { t: "each"; path: string; pos: Pos; body: Node[] };

export type Template = { file: string; nodes: Node[] };
export type RenderOptions = { file?: string };

const PATH = /^(?:@index|(?:this|[A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)*)$/;

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") {
      starts.push(i + 1);
    }
  }

  return starts;
}

type RawTag = { start: number; end: number; inner: string };
type Raw = { kind: "tag"; tag: RawTag } | { kind: "literal"; start: number };

/** Parses a template; throws CatalogError on syntax problems. */
export function parseTemplate(source: string, options: RenderOptions = {}): Template {
  const file = options.file ?? "<template>";
  const starts = lineStarts(source);
  const posAt = (offset: number): Pos => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    return { line: lo + 1, column: offset - (starts[lo] ?? 0) + 1 };
  };

  const fail = (code: string, message: string, offset: number): never => {
    throw new CatalogError([{ code, message, file, ...posAt(offset) }]);
  };

  const raws: Raw[] = [];
  for (let i = 0; i < source.length;) {
    const open = source.indexOf("{{", i);
    if (open === -1) {
      break;
    }

    if (open > 0 && source[open - 1] === "\\") {
      raws.push({ kind: "literal", start: open - 1 });
      i = open + 2;
      continue;
    }

    const close = source.indexOf("}}", open + 2);
    if (close === -1) {
      fail(CATALOG_CODES.unclosedTag, 'Tag "{{" is never closed with "}}".', open);
    }

    raws.push({
      kind: "tag",
      tag: { start: open, end: close + 2, inner: source.slice(open + 2, close).trim() },
    });

    i = close + 2;
  }

  const root: Node[] = [];
  type Frame = {
    node: Extract<Node, { body: Node[] }>;
    kind: string;
    inElse: boolean;
    offset: number;
  };
  const stack: Frame[] = [];
  const current = (): Node[] => {
    const top = stack.at(-1);
    return top ? (top.inElse && top.node.t !== "each" ? top.node.otherwise : top.node.body) : root;
  };

  const text = (value: string) => {
    if (value) {
      current().push({ t: "text", text: value });
    }
  };

  let cursor = 0;
  for (const raw of raws) {
    if (raw.kind === "literal") {
      text(source.slice(cursor, raw.start));
      text("{{");
      cursor = raw.start + 3;
      continue;
    }

    const { start, end, inner } = raw.tag;
    const pos = posAt(start);
    const isBlock = /^(#|\/|else$)/.test(inner);
    let textEnd = start;
    let next = end;
    if (isBlock) {
      const lineStart = starts[pos.line - 1] ?? 0;
      const after = /^[ \t]*(\r?\n|$)/.exec(source.slice(end));
      if (/^[ \t]*$/.test(source.slice(lineStart, start)) && after) {
        textEnd = lineStart;
        next = end + after[0].length;
      }
    }

    text(source.slice(cursor, Math.max(cursor, textEnd)));
    cursor = next;

    const [head = "", arg = "", ...extra] = inner.split(/\s+/);
    if (inner === "else") {
      const top = stack.at(-1);
      if (!top || top.kind === "each" || top.inElse) {
        fail(
          CATALOG_CODES.unbalancedBlock,
          '"{{else}}" is only allowed once, inside "{{#if}}" or "{{#unless}}".',
          start,
        );
      } else {
        top.inElse = true;
      }
    } else if (head.startsWith("/")) {
      const kind = head.slice(1);
      const top = stack.at(-1);
      if (!["if", "unless", "each"].includes(kind) || arg) {
        fail(CATALOG_CODES.invalidTag, `Unknown tag "{{${inner}}}".`, start);
      }

      if (!top) {
        fail(
          CATALOG_CODES.unbalancedBlock,
          `"{{/${kind}}}" has no matching "{{#${kind}}}".`,
          start,
        );
      } else if (top.kind !== kind) {
        fail(
          CATALOG_CODES.unbalancedBlock,
          `"{{/${kind}}}" closes "{{#${top.kind}}}" opened at line ${posAt(top.offset).line}.`,
          start,
        );
      }

      stack.pop();
    } else if (head.startsWith("#")) {
      const kind = head.slice(1);
      if (!["if", "unless", "each"].includes(kind)) {
        fail(CATALOG_CODES.invalidTag, `Unknown block "{{${inner}}}".`, start);
      }

      if (!arg || extra.length || !PATH.test(arg)) {
        fail(
          CATALOG_CODES.invalidTag,
          `"{{#${kind}}}" needs exactly one path, for example "{{#${kind} team.name}}".`,
          start,
        );
      }

      const node = (
        kind === "each"
          ? { t: "each", path: arg, pos, body: [] }
          : { t: kind, path: arg, pos, body: [], otherwise: [] }
      ) as Frame["node"];

      current().push(node);
      stack.push({ node, kind, inElse: false, offset: start });
    } else {
      if (!PATH.test(inner)) {
        fail(
          CATALOG_CODES.invalidTag,
          `"{{${inner}}}" is not a path. Expressions and helpers are not supported.`,
          start,
        );
      }

      current().push({ t: "var", path: inner, pos });
    }
  }

  text(source.slice(cursor));
  const open = stack.at(-1);
  if (open) {
    fail(CATALOG_CODES.unbalancedBlock, `"{{#${open.kind}}}" is never closed.`, open.offset);
  }

  return { file, nodes: root };
}

type Scope = { item: unknown; index: number };
type Found = { found: true; value: unknown } | { found: false };

function resolve(path: string, root: unknown, scopes: Scope[]): Found {
  const segments = path.split(".");
  const scope = scopes.at(-1);
  let cur: unknown = root;
  let rest = segments;
  if (segments[0] === "@index" || segments[0] === "this") {
    if (!scope) {
      return { found: false };
    }

    if (segments[0] === "@index") {
      return { found: true, value: scope.index };
    }

    cur = scope.item;
    rest = segments.slice(1);
  }

  for (const key of rest) {
    if (typeof cur === "object" && cur !== null && Object.hasOwn(cur, key)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return { found: false };
    }
  }

  return { found: true, value: cur };
}

const truthy = (v: unknown): boolean =>
  !(
    v === undefined ||
    v === null ||
    v === false ||
    v === "" ||
    v === 0 ||
    (Array.isArray(v) && v.length === 0)
  );

/** Renders a template against a context. Throws CatalogError listing every problem. */
export function render(template: string, context: unknown, options: RenderOptions = {}): string {
  const parsed = parseTemplate(template, options);
  const issues: CatalogIssue[] = [];
  const problem = (code: string, message: string, pos: Pos) =>
    issues.push({ code, message, file: parsed.file, ...pos });

  const lookup = (path: string, pos: Pos, scopes: Scope[]): unknown => {
    const r = resolve(path, context, scopes);
    if (!r.found) {
      problem(CATALOG_CODES.unknownPlaceholder, `Unknown placeholder "${path}".`, pos);
      return undefined;
    }

    return r.value;
  };

  const run = (nodes: Node[], scopes: Scope[]): string => {
    let out = "";
    for (const node of nodes) {
      if (node.t === "text") {
        out += node.text;
      } else if (node.t === "var") {
        const v = lookup(node.path, node.pos, scopes);
        if (v === undefined || v === null) {
          continue;
        }

        if (typeof v === "object") {
          problem(
            CATALOG_CODES.notScalar,
            `"${node.path}" is a ${Array.isArray(v) ? "list" : "group"}; use a field or {{#each}}.`,
            node.pos,
          );
        } else {
          out += String(v);
        }
      } else if (node.t === "if" || node.t === "unless") {
        const v = truthy(lookup(node.path, node.pos, scopes));
        out += run(v === (node.t === "if") ? node.body : node.otherwise, scopes);
      } else {
        const v = lookup(node.path, node.pos, scopes);
        if (v === undefined || v === null) {
          continue;
        }

        if (!Array.isArray(v)) {
          problem(CATALOG_CODES.notIterable, `"${node.path}" is not a list.`, node.pos);
          continue;
        }

        v.forEach((item, index) => {
          out += run(node.body, [...scopes, { item, index }]);
        });
      }
    }

    return out;
  };

  const out = run(parsed.nodes, []);
  if (issues.length) {
    throw new CatalogError(issues);
  }

  return out;
}

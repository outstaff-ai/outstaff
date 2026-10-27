import { CATALOG_CODES, CatalogError } from "./codes.js";
import type { RenderOptions, Template, TemplateNode as Node, TemplatePos as Pos } from "./types.js";

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

/** A block tag (`{{#if a}}`, `{{/if}}`) split into its words. */
type Tag = { head: string; arg: string; extra: string[]; inner: string; start: number; pos: Pos };

/** An open block: its node, which part of it text goes to, and where it opened. */
type Frame = {
  node: Extract<Node, { body: Node[] }>;
  kind: string;
  inElse: boolean;
  offset: number;
};

const BLOCKS = ["if", "unless", "each"];

/** Line and column of an offset, from the offsets where lines start. */
function positionIn(starts: number[], offset: number): Pos {
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
}

/** Parses a template; throws CatalogError on syntax problems. */
export function parseTemplate(source: string, options: RenderOptions = {}): Template {
  const parser = new Parser(source, options.file ?? "<template>");

  return { file: parser.file, nodes: parser.parse() };
}

class Parser {
  private readonly starts: number[];
  private readonly root: Node[] = [];
  private readonly stack: Frame[] = [];

  /** Where the text not yet added starts. */
  private cursor = 0;

  constructor(
    private readonly source: string,
    readonly file: string,
  ) {
    this.starts = lineStarts(source);
  }

  parse(): Node[] {
    for (const raw of this.scan()) {
      if (raw.kind === "literal") {
        this.literal(raw.start);
      } else {
        this.tag(raw.tag);
      }
    }

    this.text(this.source.slice(this.cursor));
    const open = this.stack.at(-1);
    if (open) {
      this.fail(CATALOG_CODES.unbalancedBlock, `"{{#${open.kind}}}" is never closed.`, open.offset);
    }

    return this.root;
  }

  /** The tags and escaped `\{{` of the source, in order. */
  private scan(): Raw[] {
    const raws: Raw[] = [];
    let open = this.source.indexOf("{{");
    while (open !== -1) {
      const raw = this.rawAt(open);
      raws.push(raw);
      open = this.source.indexOf("{{", raw.kind === "literal" ? open + 2 : raw.tag.end);
    }

    return raws;
  }

  private rawAt(open: number): Raw {
    if (open > 0 && this.source[open - 1] === "\\") {
      return { kind: "literal", start: open - 1 };
    }

    const close = this.source.indexOf("}}", open + 2);
    if (close === -1) {
      this.fail(CATALOG_CODES.unclosedTag, 'Tag "{{" is never closed with "}}".', open);
    }

    return {
      kind: "tag",
      tag: { start: open, end: close + 2, inner: this.source.slice(open + 2, close).trim() },
    };
  }

  private fail(code: string, message: string, offset: number): never {
    throw new CatalogError([
      { code, message, file: this.file, ...positionIn(this.starts, offset) },
    ]);
  }

  /** The list text and tags go to: the open block's body (or else-part), or the top level. */
  private current(): Node[] {
    const top = this.stack.at(-1);
    if (!top) {
      return this.root;
    }

    return top.inElse && top.node.t !== "each" ? top.node.otherwise : top.node.body;
  }

  private text(value: string): void {
    if (value) {
      this.current().push({ t: "text", text: value });
    }
  }

  private literal(start: number): void {
    this.text(this.source.slice(this.cursor, start));
    this.text("{{");
    this.cursor = start + 3;
  }

  private tag({ start, end, inner }: RawTag): void {
    const pos = positionIn(this.starts, start);
    const span = this.span(start, end, inner, pos);
    this.text(this.source.slice(this.cursor, Math.max(this.cursor, span.textEnd)));
    this.cursor = span.next;

    const [head = "", arg = "", ...extra] = inner.split(/\s+/);
    const tag: Tag = { head, arg, extra, inner, start, pos };
    if (inner === "else") {
      this.else(start);
    } else if (head.startsWith("/")) {
      this.close(tag);
    } else if (head.startsWith("#")) {
      this.open(tag);
    } else {
      this.variable(tag);
    }
  }

  /** Where the text before a tag ends and the text after it starts; a block tag alone on its line takes the line. */
  private span(
    start: number,
    end: number,
    inner: string,
    pos: Pos,
  ): { textEnd: number; next: number } {
    const tagOnly = { textEnd: start, next: end };
    if (!/^(#|\/|else$)/.test(inner)) {
      return tagOnly;
    }

    const lineStart = this.starts[pos.line - 1] ?? 0;
    const after = /^[ \t]*(\r?\n|$)/.exec(this.source.slice(end));
    if (!/^[ \t]*$/.test(this.source.slice(lineStart, start)) || !after) {
      return tagOnly;
    }

    return { textEnd: lineStart, next: end + after[0].length };
  }

  private else(start: number): void {
    const top = this.stack.at(-1);
    if (!top || top.kind === "each" || top.inElse) {
      return this.fail(
        CATALOG_CODES.unbalancedBlock,
        '"{{else}}" is only allowed once, inside "{{#if}}" or "{{#unless}}".',
        start,
      );
    }

    top.inElse = true;
  }

  private close({ head, arg, inner, start }: Tag): void {
    const kind = head.slice(1);
    if (!BLOCKS.includes(kind) || arg) {
      this.fail(CATALOG_CODES.invalidTag, `Unknown tag "{{${inner}}}".`, start);
    }

    const top = this.stack.at(-1);
    if (!top) {
      return this.fail(
        CATALOG_CODES.unbalancedBlock,
        `"{{/${kind}}}" has no matching "{{#${kind}}}".`,
        start,
      );
    }

    if (top.kind !== kind) {
      this.fail(
        CATALOG_CODES.unbalancedBlock,
        `"{{/${kind}}}" closes "{{#${top.kind}}}" opened at line ${positionIn(this.starts, top.offset).line}.`,
        start,
      );
    }

    this.stack.pop();
  }

  private open({ head, arg, extra, inner, start, pos }: Tag): void {
    const kind = head.slice(1);
    if (!BLOCKS.includes(kind)) {
      this.fail(CATALOG_CODES.invalidTag, `Unknown block "{{${inner}}}".`, start);
    }

    if (!arg || extra.length || !PATH.test(arg)) {
      this.fail(
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

    this.current().push(node);
    this.stack.push({ node, kind, inElse: false, offset: start });
  }

  private variable({ inner, start, pos }: Tag): void {
    if (!PATH.test(inner)) {
      this.fail(
        CATALOG_CODES.invalidTag,
        `"{{${inner}}}" is not a path. Expressions and helpers are not supported.`,
        start,
      );
    }

    this.current().push({ t: "var", path: inner, pos });
  }
}

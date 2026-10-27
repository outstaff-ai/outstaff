import { readFileSync } from "node:fs";
import { CATALOG_CODES, CatalogError } from "./codes.js";
import { parseTemplate } from "./template-parse.js";
import type { CatalogDoc, CatalogIssue } from "./types.js";

/** One load of a catalog: the problems found so far, and reads that record theirs. */
export class Loading {
  readonly issues: CatalogIssue[] = [];

  add(code: string, message: string, file: string, at = { line: 1, column: 1 }): void {
    this.issues.push({ code, message, file, line: at.line, column: at.column });
  }

  read(file: string): string | undefined {
    try {
      return readFileSync(file, "utf8");
    } catch {
      this.add(CATALOG_CODES.readFailed, "Cannot read file.", file);
      return undefined;
    }
  }

  /** A markdown document, whose template syntax problems are recorded; undefined when it cannot be read. */
  doc(name: string, file: string): CatalogDoc | undefined {
    const text = this.read(file);
    if (text === undefined) {
      return undefined;
    }

    try {
      parseTemplate(text, { file });
    } catch (e) {
      if (!(e instanceof CatalogError)) {
        throw e;
      }

      this.issues.push(...e.issues);
    }

    return { name, file, text };
  }
}

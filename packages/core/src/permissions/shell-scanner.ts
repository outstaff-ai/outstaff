import { expansionsIn } from "./shell-expansion.js";
import type { Heredoc, Token } from "./shell.types.js";

/** One pass over a command line: the position, the word being built, pending here-documents and the tokens so far. */
export class Scanner {
  readonly tokens: Token[] = [];
  i = 0;
  private readonly heredocs: Heredoc[] = [];
  private buf = "";
  private inWord = false;
  private digitsOnly = true;

  constructor(readonly src: string) {}

  /** Whether the whole line has been read. */
  get done(): boolean {
    return this.i >= this.src.length;
  }

  /** Whether a word is being built. */
  get wordStarted(): boolean {
    return this.inWord;
  }

  /** The character `offset` places past the current one. */
  at(offset = 0): string | undefined {
    return this.src[this.i + offset];
  }

  /** Consumes `ch` when it is the current character; returns whether it did. */
  skip(ch: string): boolean {
    if (this.at() !== ch) {
      return false;
    }

    this.i++;

    return true;
  }

  skipBlanks(): void {
    while (this.at() === " " || this.at() === "\t") {
      this.i++;
    }
  }

  push(...tokens: Token[]): void {
    this.tokens.push(...tokens);
  }

  /** Adds text to the current word, starting one if needed; `digit` keeps an all-digit word eligible as an fd. */
  add(s: string, digit = false): void {
    this.buf += s;
    this.inWord = true;
    if (!digit) {
      this.digitsOnly = false;
    }
  }

  endWord(): void {
    if (this.inWord) {
      this.tokens.push({ k: "word", v: this.buf });
    }

    this.buf = "";
    this.inWord = false;
    this.digitsOnly = true;
  }

  /** Ends the current word before a redirection; a word of digits alone ("2>") is the fd prefix and is dropped. */
  endWordBeforeRedirect(): void {
    if (this.inWord && this.digitsOnly && this.buf !== "") {
      this.buf = "";
      this.inWord = false;
    } else {
      this.endWord();
    }
  }

  addHeredoc(heredoc: Heredoc): void {
    this.heredocs.push(heredoc);
  }

  /** Reads the bodies of the pending here-documents, which start at the current position (a line start). */
  readHeredocBodies(): void {
    for (const h of this.heredocs.splice(0)) {
      const body = this.readHeredocBody(h);
      if (h.expands) {
        this.tokens.push(...expansionsIn(body.join("\n")));
      }
    }
  }

  private readHeredocBody(h: Heredoc): string[] {
    const body: string[] = [];
    while (!this.done) {
      const line = this.readLine();
      if ((h.stripTabs ? line.replace(/^\t+/, "") : line) === h.delimiter) {
        break;
      }

      body.push(line);
    }

    return body;
  }

  private readLine(): string {
    const start = this.i;
    const nl = this.src.indexOf("\n", start);
    const end = nl < 0 ? this.src.length : nl;
    this.i = nl < 0 ? end : nl + 1;

    return this.src.slice(start, end);
  }
}

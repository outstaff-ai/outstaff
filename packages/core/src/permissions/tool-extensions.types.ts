/** An extension of a tool, from its `extensions` entry `owner/name@ref`. */
export interface ToolExtension {
  owner: string;
  name: string;

  /** The release tag or commit the extension is pinned to. */
  ref: string;
}

/** An extension of a tool that is installed, and the command it adds. */
export interface InstalledExtension {
  /** The tool the extension extends, for example gh. */
  tool: string;

  /** The command it adds as the tool's first word, for example actions-lock. */
  command: string;

  /** The extension as declared, `owner/name@ref`. */
  extension: string;
}

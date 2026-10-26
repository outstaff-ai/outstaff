import type { Style } from "@dicebear/core";
import type { z } from "zod";
import type { dicebearOptions, directoryOptions, urlOptions } from "./options.js";

export interface StyleInfo {
  id: string;
  style: Style<object>;
  creator: string;
  license: string;

  /** CC0, MIT and similar: no attribution needed. */
  permissive: boolean;
}

export type DicebearOptions = z.output<typeof dicebearOptions>;

export type DirectoryOptions = z.output<typeof directoryOptions>;

export type UrlOptions = z.output<typeof urlOptions>;

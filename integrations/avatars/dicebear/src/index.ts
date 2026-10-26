import { defineAdapter } from "@outstaff/core";
import { createDicebearAvatars } from "./dicebear.js";
import { dicebearOptions, directoryOptions, urlOptions } from "./options.js";
import { createDirectoryAvatars, createUrlAvatars } from "./sources.js";

export { createDicebearAvatars } from "./dicebear.js";
export { createDirectoryAvatars, createUrlAvatars } from "./sources.js";
export { dicebearOptions, directoryOptions, urlOptions } from "./options.js";
export type { DicebearOptions, DirectoryOptions, StyleInfo, UrlOptions } from "./types.js";

export { DEFAULT_STYLE, STYLES, STYLE_IDS } from "./styles.js";

const noSecrets = () => [];

export const dicebearAvatars = defineAdapter({
  port: "avatars",
  name: "dicebear",
  capabilities: ["avatars.generate"],
  options: dicebearOptions,
  secrets: noSecrets,
  create: (ctx) => createDicebearAvatars(ctx.options),
});

export const directoryAvatars = defineAdapter({
  port: "avatars",
  name: "directory",
  capabilities: ["avatars.generate"],
  options: directoryOptions,
  secrets: noSecrets,
  create: (ctx) => createDirectoryAvatars(ctx.options),
});

export const urlAvatars = defineAdapter({
  port: "avatars",
  name: "url",
  capabilities: ["avatars.generate"],
  options: urlOptions,
  secrets: noSecrets,
  create: (ctx) => createUrlAvatars(ctx),
});

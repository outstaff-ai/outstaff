import type { TeamConfig } from "@outstaff/core";
import {
  generateName,
  HANDLE,
  baseHandle,
  uniqueHandle,
  RESERVED_HANDLES,
} from "../../hire-names.js";
import type { Context, GlobalOptions, NewPerson } from "../../types.js";
import { defaultGrants, formatGrants, parseGrants } from "./grants.js";
import type { ChosenPerson, Grants, HireOptions } from "./types.js";

const given = (v: string | undefined): string | undefined => v?.trim() || undefined;

/** Asks about, or generates, each value of the new person; prints the error and returns an exit code when one is not valid. */
export async function choosePerson(
  ctx: Context,
  options: HireOptions & GlobalOptions,
  config: TeamConfig,
  role: string,
  permissions: string,
): Promise<ChosenPerson | number> {
  const interactive = !options.yes && !options.json && ctx.ask !== undefined;
  const ask = async (question: string, fallback: string): Promise<string> =>
    interactive ? ctx.ask!(question, fallback) : fallback;

  const taken = config.people.map((p) => p.handle);
  if ([options.name, options.handle, options.pronouns, options.model].some((v) => v === "")) {
    ctx.err("error    An option was given an empty value.\n");
    return 1;
  }

  const name = await ask("Name", given(options.name) ?? generateName(taken));
  if (/[\r\n]/.test(name)) {
    ctx.err("error    The name must be a single line.\n");
    return 1;
  }

  const wanted = given(options.handle);
  const handle = await ask("Handle", wanted ?? uniqueHandle(baseHandle(name), taken));
  if (!HANDLE.test(handle) || RESERVED_HANDLES.includes(handle)) {
    ctx.err(
      `error    "${handle}" is not a valid handle: use lowercase letters, digits and dashes, starting with a letter, at most 30, and not "office".\n`,
    );

    return 1;
  }

  if (taken.includes(handle)) {
    ctx.err(`error    The handle "${handle}" is already used by another person.\n`);
    return 1;
  }

  const pronouns = await ask("Pronouns", given(options.pronouns) ?? "they/them");
  const model = given(options.model);

  let grants: Grants | string = options.repos
    ? parseGrants(options.repos, config)
    : defaultGrants(config, permissions);

  if (typeof grants === "string") {
    ctx.err(`error    --repos: ${grants}\n`);
    return 1;
  }

  if (interactive && !options.repos) {
    grants = parseGrants(
      await ask("Repo access (repo=read|write, comma separated)", formatGrants(grants)),
      config,
    );

    if (typeof grants === "string") {
      ctx.err(`error    ${grants}\n`);
      return 1;
    }
  }

  const avatarArg = given(options.avatar);
  const isUrl = avatarArg !== undefined && /^https?:\/\//i.test(avatarArg);
  if (isUrl && !URL.canParse(avatarArg)) {
    ctx.err(`error    --avatar: "${avatarArg}" is not a valid URL.\n`);
    return 1;
  }

  const seed = isUrl ? handle : (avatarArg ?? handle);
  const person: NewPerson = {
    handle,
    name,
    pronouns,
    role,
    ...(model ? { model } : {}),
    repos: grants,
    avatar: isUrl ? { url: avatarArg } : { seed },
  };

  const summary = [
    `Handle:    ${handle}`,
    `Name:      ${name}`,
    `Pronouns:  ${pronouns}`,
    `Role:      ${role}`,
    `Model:     ${model ?? "(the runtime's default)"}`,
    `Repos:     ${formatGrants(grants)}`,
    `Avatar:    ${isUrl ? avatarArg : `seed ${seed}`}`,
  ];

  return { person, summary, name, handle, seed, isUrl };
}

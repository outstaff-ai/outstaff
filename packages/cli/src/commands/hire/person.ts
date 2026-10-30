import type { TeamConfig } from "@outstaff/core";
import { generateName, HANDLE, baseHandle, uniqueHandle, RESERVED_HANDLES } from "#/hire-names.js";
import type { Context, GlobalOptions, NewPerson } from "#/types.js";
import { defaultGrants, formatGrants, parseGrants } from "./grants.js";
import type { ChosenPerson, Grants, HireOptions } from "./types.js";

const given = (v: string | undefined): string | undefined => v?.trim() || undefined;

type Ask = (question: string, fallback: string) => Promise<string>;
type AvatarChoice = {
  isUrl: boolean;
  seed: string;
  avatar: NonNullable<NewPerson["avatar"]>;
  label: string;
};

/** A value given or answered that is not valid; its message is printed as the error. */
class Invalid extends Error {}

function rejectEmptyOptions(options: HireOptions): void {
  if ([options.name, options.handle, options.pronouns, options.model].some((v) => v === "")) {
    throw new Invalid("An option was given an empty value.");
  }
}

async function chooseName(ask: Ask, options: HireOptions, taken: string[]): Promise<string> {
  const name = await ask("Name", given(options.name) ?? generateName(taken));
  if (/[\r\n]/.test(name)) {
    throw new Invalid("The name must be a single line.");
  }

  return name;
}

async function chooseHandle(
  ask: Ask,
  options: HireOptions,
  name: string,
  taken: string[],
): Promise<string> {
  const handle = await ask(
    "Handle",
    given(options.handle) ?? uniqueHandle(baseHandle(name), taken),
  );

  if (!HANDLE.test(handle) || RESERVED_HANDLES.includes(handle)) {
    throw new Invalid(
      `"${handle}" is not a valid handle: use lowercase letters, digits and dashes, starting with a letter, at most 30, and not "office".`,
    );
  }

  if (taken.includes(handle)) {
    throw new Invalid(`The handle "${handle}" is already used by another person.`);
  }

  return handle;
}

/** --model, which a terminal user may edit; there is no default, so without one hiring stops. */
async function chooseModel(ask: Ask, options: HireOptions): Promise<string> {
  const model = (await ask("Model", given(options.model) ?? "")).trim();
  if (!model) {
    throw new Invalid(
      "Give the model the person runs on with --model, for example --model sonnet. There is no default model.",
    );
  }

  return model;
}

const grantsOrThrow = (grants: Grants | string, prefix: string): Grants => {
  if (typeof grants === "string") {
    throw new Invalid(`${prefix}${grants}`);
  }

  return grants;
};

/** --repos when given; otherwise the role's defaults, which a terminal user may edit. */
async function chooseGrants(
  ask: Ask | undefined,
  options: HireOptions,
  config: TeamConfig,
  permissions: string,
): Promise<Grants> {
  if (options.repos) {
    return grantsOrThrow(parseGrants(options.repos, config), "--repos: ");
  }

  const defaults = defaultGrants(config, permissions);
  if (!ask) {
    return defaults;
  }

  const answer = await ask(
    "Repo access (repo=read|write, comma separated)",
    formatGrants(defaults),
  );

  return grantsOrThrow(parseGrants(answer, config), "");
}

/** --avatar as an https image URL or a seed; the handle is the seed by default. */
function chooseAvatar(options: HireOptions, handle: string): AvatarChoice {
  const arg = given(options.avatar);
  if (arg === undefined || !/^https?:\/\//i.test(arg)) {
    const seed = arg ?? handle;
    return { isUrl: false, seed, avatar: { seed }, label: `seed ${seed}` };
  }

  if (!URL.canParse(arg)) {
    throw new Invalid(`--avatar: "${arg}" is not a valid URL.`);
  }

  return { isUrl: true, seed: handle, avatar: { url: arg }, label: arg };
}

function summaryOf(person: NewPerson, avatar: AvatarChoice): string[] {
  return [
    `Handle:    ${person.handle}`,
    `Name:      ${person.name}`,
    `Pronouns:  ${person.pronouns}`,
    `Role:      ${person.role}`,
    `Model:     ${person.model}`,
    `Repos:     ${formatGrants(person.repos)}`,
    `Avatar:    ${avatar.label}`,
  ];
}

/** Asks about, or generates, each value in turn; throws Invalid at the first one that is not valid. */
async function pickPerson(
  ask: Ask | undefined,
  options: HireOptions,
  config: TeamConfig,
  role: string,
  permissions: string,
): Promise<ChosenPerson> {
  const answer: Ask = async (question, fallback) => (ask ? ask(question, fallback) : fallback);
  const taken = config.people.map((p) => p.handle);
  rejectEmptyOptions(options);
  const name = await chooseName(answer, options, taken);
  const handle = await chooseHandle(answer, options, name, taken);
  const pronouns = await answer("Pronouns", given(options.pronouns) ?? "they/them");
  const model = await chooseModel(answer, options);
  const repos = await chooseGrants(ask, options, config, permissions);
  const avatar = chooseAvatar(options, handle);
  const person: NewPerson = {
    handle,
    name,
    pronouns,
    role,
    model,
    repos,
    avatar: avatar.avatar,
  };

  const summary = summaryOf(person, avatar);
  return { person, summary, name, handle, seed: avatar.seed, isUrl: avatar.isUrl };
}

/** Asks about, or generates, each value of the new person; prints the error and returns an exit code when one is not valid. */
export async function choosePerson(
  ctx: Context,
  options: HireOptions & GlobalOptions,
  config: TeamConfig,
  role: string,
  permissions: string,
): Promise<ChosenPerson | number> {
  const ask = !options.yes && !options.json ? ctx.ask?.bind(ctx) : undefined;
  try {
    return await pickPerson(ask, options, config, role, permissions);
  } catch (e) {
    if (!(e instanceof Invalid)) {
      throw e;
    }

    ctx.err(`error    ${e.message}\n`);
    return 1;
  }
}

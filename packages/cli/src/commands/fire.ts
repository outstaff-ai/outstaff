import { readFileSync, writeFileSync } from "node:fs";
import type { TeamConfig } from "@outstaff/core";
import { defineCommand } from "#/define.js";
import { onlyArg } from "./args.js";
import { openTeam } from "#/open-team.js";
import { projectRoot, secretsLocation, shown } from "#/project.js";
import { removePerson } from "#/teamfile.js";
import type { Context, GlobalOptions, Removal } from "#/types.js";
import { validate } from "./validate.js";

const describe = (u: { before: string[]; after: string[] | null }) =>
  u.after
    ? `usage group [${u.before.join(", ")}] becomes [${u.after.join(", ")}]`
    : `usage group [${u.before.join(", ")}] is dropped, since a group needs two people`;

type Person = TeamConfig["people"][number];
type FireOptions = GlobalOptions & { yes?: boolean; secretsDir?: string };

/** The person with this handle; undefined (after listing the team) when there is none. */
function findPerson(ctx: Context, config: TeamConfig, handle: string): Person | undefined {
  const person = config.people.find((p) => p.handle === handle);
  if (!person) {
    ctx.err(
      `error    Unknown person "${handle}". People in this team: ${config.people.map((p) => p.handle).join(", ") || "none"}.\n`,
    );
  }

  return person;
}

/** Reads the team file and removes the person; undefined (after printing why) when that fails. */
function readRemoval(ctx: Context, file: string, handle: string): Removal | undefined {
  let removal: Removal | undefined;
  try {
    removal = removePerson(readFileSync(file, "utf8"), handle);
  } catch (e) {
    ctx.err(`error    Cannot edit ${file}: ${(e as Error).message}\n`);
    return undefined;
  }

  if (!removal) {
    ctx.err(`error    "${handle}" is not in the people list of ${file}.\n`);
  }

  return removal;
}

function printUsage(ctx: Context, removal: Removal): void {
  for (const u of removal.usage) {
    ctx.out(`  policies.usage.shared: ${describe(u)}\n`);
  }
}

/** Whether to go ahead: --yes, or a confirmation after showing what changes. Prints why not. */
async function approved(
  ctx: Context,
  options: FireOptions,
  person: Person,
  file: string,
  removal: Removal,
): Promise<boolean> {
  if (options.yes) {
    return true;
  }

  const json = options.json === true;
  const ask = json ? undefined : ctx.confirm?.bind(ctx);
  if (!json) {
    ctx.out(`Remove ${person.name} (${person.handle}, ${person.role}) from ${file}?\n`);
    printUsage(ctx, removal);
  }

  if (ask && (await ask(`Remove ${person.handle}?`))) {
    return true;
  }

  ctx.err(
    ask
      ? "Nothing was changed.\n"
      : "error    Not confirmed, so nothing was changed. Run again with --yes to remove.\n",
  );

  return false;
}

const named = (id: string | undefined): string => (id ? ` (${id})` : "");

/** What to remove by hand, outside the team file. */
function cleanupChecklist(person: Person, secretsDir: string): string[] {
  const { handle } = person;
  const ids = person.identities ?? {};
  return [
    `GitHub App${named(ids.vcs)}: uninstall it from the repositories, then delete the App.`,
    `Chat app${named(ids.chat)}: remove the app from the workspace.`,
    `Tracker member${named(ids.tracker)}: remove the member from the project, and reassign their open tickets.`,
    `Secrets: delete ${secretsDir}/ and .outstaff/people/${handle}/, and the person's OUTSTAFF_AGENT_TOKEN_${handle.toUpperCase().replaceAll("-", "_")} from the office's secrets.`,
    `Compose: delete the ${handle} service, its ${handle}-home volume and its secrets, and the office's token secret for ${handle}. Kubernetes: delete people/${handle}/ and its line in the top kustomization.yaml, and the outstaff-agent-${handle} Secret.`,
    `Office: stop the agent's container first; work items still assigned to ${handle} stay in the office's queue until they are reassigned or canceled in the tracker.`,
  ];
}

function printRemoved(
  ctx: Context,
  person: Person,
  file: string,
  removal: Removal,
  checklist: string[],
): void {
  ctx.out(`Removed ${person.name} (${person.handle}) from ${file}\n`);
  printUsage(ctx, removal);
  for (const r of removal.references) {
    ctx.out(`warning  ${r} still mentions "${person.handle}"; edit it by hand.\n`);
  }

  ctx.out("\nClean up by hand, outside the team file:\n");
  checklist.forEach((c, i) => ctx.out(`  ${i + 1}. ${c}\n`));
  ctx.out("\n");
}

/** Runs `ost validate`, capturing its JSON report instead of printing it in JSON mode. */
async function validateAfter(
  ctx: Context,
  options: FireOptions,
): Promise<{ code: number; report: unknown }> {
  let jsonOut = "";
  const code = await validate.run(
    options.json ? { ...ctx, out: (t) => void (jsonOut += t) } : ctx,
    {
      ...(options.team !== undefined ? { team: options.team } : {}),
      json: options.json === true,
    },
    [],
  );

  return { code, report: options.json ? parseReport(jsonOut) : null };
}

function parseReport(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const fire = defineCommand<{ yes?: boolean; secretsDir?: string }>({
  name: "fire",
  summary: "Remove a person from the team file and list what to clean up.",
  description:
    "Removes the person from `people` in the team file, keeping its comments and quoting. If `policies.usage.shared` lists the person, the person is removed from the group too (a group left with one member is dropped), and any other place that still mentions the handle is listed and left alone. It asks to confirm in a terminal and needs --yes without one. It changes nothing outside the team file: it prints the checklist of what to remove by hand (the person's GitHub App, chat app and tracker member, the secrets, the compose service or Kubernetes folder, and the work still assigned to them in the office), then runs `ost validate`.",
  args: "<handle>",
  options: [
    { flags: "--yes", description: "Do not ask to confirm." },
    {
      flags: "--secrets-dir <dir>",
      description:
        "Directory of secret files, named in the checklist. Defaults to OUTSTAFF_SECRETS_DIR, then .outstaff/secrets/<handle> next to the team file.",
    },
  ],
  examples: ["ost fire sam", "ost fire sam --yes --json"],
  exitCodes: [
    "0: the person was removed and the team file validates",
    "1: the team could not be loaded, the handle is unknown, the removal was not confirmed, or the team file has errors afterwards",
  ],
  async run(ctx, options, args) {
    const handle = onlyArg(args);
    if (handle === undefined) {
      ctx.err("error    Give exactly one handle.\n");
      return 1;
    }

    const opened = await openTeam(ctx, options);
    if (!opened.ok) {
      return opened.code;
    }

    const { config, source } = opened.team;
    const person = findPerson(ctx, config, handle);
    if (!person) {
      return 1;
    }

    const removal = readRemoval(ctx, source.file, handle);
    if (!removal) {
      return 1;
    }

    const json = options.json === true;
    if (!(await approved(ctx, options, person, source.file, removal))) {
      return 1;
    }

    writeFileSync(source.file, removal.yaml);

    const secretsDir = shown(
      ctx,
      secretsLocation(ctx, options, projectRoot(ctx, source), handle).dir,
    );

    const checklist = cleanupChecklist(person, secretsDir);
    if (!json) {
      printRemoved(ctx, person, source.file, removal, checklist);
    }

    const validated = await validateAfter(ctx, options);
    if (json) {
      ctx.out(
        `${JSON.stringify(
          {
            removed: handle,
            file: source.file,
            usage: removal.usage,
            references: removal.references,
            checklist,
            validate: validated.report,
          },
          null,
          2,
        )}\n`,
      );
    }

    return validated.code;
  },
});

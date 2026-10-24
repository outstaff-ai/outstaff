import { readFileSync, writeFileSync } from "node:fs";
import { defineCommand } from "../define.js";
import { openTeam } from "../ejected.js";
import { removePerson } from "../teamfile.js";
import { DEFAULT_SECRETS_DIR } from "./setup.js";
import { validate } from "./validate.js";

const describe = (u: { before: string[]; after: string[] | null }) =>
  u.after
    ? `usage group [${u.before.join(", ")}] becomes [${u.after.join(", ")}]`
    : `usage group [${u.before.join(", ")}] is dropped, since a group needs two people`;

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
        "Directory of secret files, named in the checklist. Defaults to OUTSTAFF_SECRETS_DIR, then ./secrets.",
    },
  ],
  examples: ["ost fire sam", "ost fire sam --yes --json"],
  exitCodes: [
    "0: the person was removed and the team file validates",
    "1: the team could not be loaded, the handle is unknown, the removal was not confirmed, or the team file has errors afterwards",
  ],
  async run(ctx, options, args) {
    const [handle, ...extra] = args;
    if (handle === undefined || extra.length > 0) {
      ctx.err("error    Give exactly one handle.\n");
      return 1;
    }

    const opened = await openTeam(ctx, options);
    if (!opened.ok) {
      return opened.code;
    }

    const { config, source } = opened.team;
    const person = config.people.find((p) => p.handle === handle);
    if (!person) {
      ctx.err(
        `error    Unknown person "${handle}". People in this team: ${config.people.map((p) => p.handle).join(", ") || "none"}.\n`,
      );

      return 1;
    }

    let removal: ReturnType<typeof removePerson>;
    try {
      removal = removePerson(readFileSync(source.file, "utf8"), handle);
    } catch (e) {
      ctx.err(`error    Cannot edit ${source.file}: ${(e as Error).message}\n`);
      return 1;
    }

    if (!removal) {
      ctx.err(`error    "${handle}" is not in the people list of ${source.file}.\n`);
      return 1;
    }

    if (!options.yes) {
      if (!options.json) {
        ctx.out(`Remove ${person.name} (${handle}, ${person.role}) from ${source.file}?\n`);
        for (const u of removal.usage) {
          ctx.out(`  policies.usage.shared: ${describe(u)}\n`);
        }
      }

      const ok = !options.json && ctx.confirm ? await ctx.confirm(`Remove ${handle}?`) : false;
      if (!ok) {
        ctx.err(
          ctx.confirm && !options.json
            ? "Nothing was changed.\n"
            : "error    Not confirmed, so nothing was changed. Run again with --yes to remove.\n",
        );

        return 1;
      }
    }

    writeFileSync(source.file, removal.yaml);

    const secretsDir = options.secretsDir ?? ctx.env["OUTSTAFF_SECRETS_DIR"] ?? DEFAULT_SECRETS_DIR;
    const ids = person.identities ?? {};
    const checklist = [
      `GitHub App${ids.vcs ? ` (${ids.vcs})` : ""}: uninstall it from the repositories, then delete the App.`,
      `Chat app${ids.chat ? ` (${ids.chat})` : ""}: remove the app from the workspace.`,
      `Tracker member${ids.tracker ? ` (${ids.tracker})` : ""}: remove the member from the project, and reassign their open tickets.`,
      `Secrets: delete ${secretsDir}/${handle}/ and .outstaff/people/${handle}/, and the person's OUTSTAFF_AGENT_TOKEN_${handle.toUpperCase().replaceAll("-", "_")} from the office's secrets.`,
      `Compose: delete the ${handle} service, its ${handle}-home volume and its secrets, and the office's token secret for ${handle}. Kubernetes: delete people/${handle}/ and its line in the top kustomization.yaml, and the outstaff-agent-${handle} Secret.`,
      `Office: stop the agent's container first; work items still assigned to ${handle} stay in the office's queue until they are reassigned or canceled in the tracker.`,
    ];

    if (!options.json) {
      ctx.out(`Removed ${person.name} (${handle}) from ${source.file}\n`);
      for (const u of removal.usage) {
        ctx.out(`  policies.usage.shared: ${describe(u)}\n`);
      }

      for (const r of removal.references) {
        ctx.out(`warning  ${r} still mentions "${handle}"; edit it by hand.\n`);
      }

      ctx.out("\nClean up by hand, outside the team file:\n");
      checklist.forEach((c, i) => ctx.out(`  ${i + 1}. ${c}\n`));
      ctx.out("\n");
    }

    let jsonOut = "";
    const validateCode = await validate.run(
      options.json ? { ...ctx, out: (t) => void (jsonOut += t) } : ctx,
      {
        ...(options.team !== undefined ? { team: options.team } : {}),
        json: options.json === true,
      },
      [],
    );

    if (options.json) {
      let report: unknown = null;
      try {
        report = JSON.parse(jsonOut);
      } catch {
        report = null;
      }

      ctx.out(
        `${JSON.stringify(
          {
            removed: handle,
            file: source.file,
            usage: removal.usage,
            references: removal.references,
            checklist,
            validate: report,
          },
          null,
          2,
        )}\n`,
      );
    }

    return validateCode;
  },
});

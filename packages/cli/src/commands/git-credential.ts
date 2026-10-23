import {
  createAgentEnv,
  createCredentialHelper,
  fileOnlySecrets,
  isCredentialOperation,
} from "@outstaff/agent";
import { formatCatalogIssue, formatIssue, PortError } from "@outstaff/core";
import { loadCatalogs } from "../catalogs.js";
import { defineCommand } from "../define.js";
import { loadTeam } from "../load.js";
import { Failure, defaultRegistry } from "./verbs.js";

export const gitCredential = defineCommand({
  name: "git-credential",
  summary: "Git credential helper: gives git a short-lived token for one repository.",
  description:
    "Speaks git's credential helper protocol on standard input and output. For `get` it finds the team repository git is talking to, checks the person's grant on it and prints a short-lived token scoped to that repository and grant. `store` and `erase` do nothing, so no token is kept anywhere. Agents set it up per clone (credential.helper); you rarely run it by hand.",
  args: "<operation>",
  options: [],
  examples: [
    "git config credential.helper '!ost git-credential'",
    "printf 'protocol=https\\nhost=github.com\\npath=acme-example/shop.git\\n' | ost git-credential get",
  ],
  exitCodes: [
    "0: done; for `get` the answer is on standard output, empty when the request is not for a repository the person has a grant on",
    "1: the operation is unknown or the token could not be issued",
  ],
  async run(ctx, options, args) {
    const operation = args[0] ?? "";
    if (!isCredentialOperation(operation)) {
      ctx.err(`error    invalid: operation must be get, store or erase, not "${operation}".\n`);
      return 1;
    }

    if (operation !== "get") {
      return 0;
    }

    try {
      // Git starts this from the agent's shell, where secrets in the environment are scrubbed: files only.
      const person = ctx.env["OUTSTAFF_PERSON"];
      if (!person) {
        throw new Failure("Set OUTSTAFF_PERSON to the handle of the person you act as.");
      }

      const loaded = await loadTeam(ctx, options);
      if (!loaded.ok) {
        throw new Failure(loaded.issues.map(formatIssue).join("\n"));
      }

      const found = loadCatalogs(ctx, loaded.config, loaded.source.dir);
      if (!found.ok) {
        throw new Failure(found.issues.map(formatCatalogIssue).join("\n"));
      }

      const roles = { ...found.catalogs.stock.roles, ...found.catalogs.ejected?.roles };
      const me = loaded.config.people.find((p) => p.handle === person);
      const profile = me && roles[me.role]?.permissions;
      if (!profile) {
        throw new Failure(`${person} is not a person of the team, or has an unknown role.`);
      }

      const env = await createAgentEnv({
        team: loaded.config,
        person,
        registry: ctx.registry ?? defaultRegistry(),
        secrets: fileOnlySecrets(ctx.env),
      });

      if (!env.vcs) {
        throw new Failure(env.unavailable?.vcs ?? "The team has no vcs adapter.");
      }

      const helper = createCredentialHelper({
        team: env.team,
        person: env.person,
        vcs: env.vcs,
        profile,
      });

      ctx.out(await helper.run("get", (await ctx.stdin?.()) ?? ""));
      return 0;
    } catch (e) {
      if (e instanceof PortError || e instanceof Failure) {
        ctx.err(`error    ${e instanceof PortError ? e.code : "invalid"}: ${e.message}\n`);
        return 1;
      }

      throw e;
    }
  },
});

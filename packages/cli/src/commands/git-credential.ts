import { createCredentialHelper, isCredentialOperation } from "@outstaff/agent";
import { defineCommand } from "#/define.js";
import type { Context, GlobalOptions } from "#/types.js";
import { actingPerson, reportFailure } from "./acting-person.js";

type CredentialHelper = ReturnType<typeof createCredentialHelper>;

async function credentialHelper(ctx: Context, options: GlobalOptions): Promise<CredentialHelper> {
  const { team, person, vcs, profile } = await actingPerson(ctx, options);
  return createCredentialHelper({ team, person, vcs, profile });
}

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
      const helper = await credentialHelper(ctx, options);
      ctx.out(await helper.run("get", (await ctx.stdin?.()) ?? ""));
      return 0;
    } catch (e) {
      return reportFailure(ctx, e);
    }
  },
});

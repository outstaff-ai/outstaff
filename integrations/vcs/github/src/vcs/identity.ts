import { PortError, type CredentialUse, type RepoRef, type Vcs } from "@outstaff/core";
import { permissionLevel } from "#/mapping.js";
import { OPTIONAL_WRITE, PERMISSIONS, ownAppToken, repoPath } from "./context.js";
import type { GithubContext } from "./types.js";

/** Credentials for a person, and a login's permission on a repository. */
export function identityOperations(c: GithubContext): Pick<Vcs, "credentials" | "permission"> {
  const { http, self, grantOf, office, apiToken, own, botAuthor } = c;

  // Cloning uses the read-only office App, for people with a read or write grant on the repo.
  async function readCredentials(person: string, repo: RepoRef, use: CredentialUse) {
    if (!grantOf(person, repo)) {
      throw new PortError("forbidden", `"${person}" has no grant on ${repo.owner}/${repo.name}.`);
    }

    const issued = await office().token(repo, {
      repositories: [repo.name],
      ...(use === "git" ? { permissions: PERMISSIONS.read } : {}),
    });

    return { token: issued.token, expiresAt: issued.expiresAt };
  }

  // Writing uses the person's own App, and only from that person's own container.
  async function writeCredentials(person: string, repo: RepoRef, use: CredentialUse) {
    if (grantOf(person, repo) !== "write") {
      throw new PortError(
        "forbidden",
        `"${person}" has no write grant on ${repo.owner}/${repo.name}.`,
      );
    }

    const app = own();
    if (!app || person !== self) {
      throw new PortError(
        "forbidden",
        `Write credentials are only issued to ${self ?? "an agent"} from its own container, not for "${person}" here.`,
      );
    }

    // A token for the CLI asks for no permissions, so it carries what the App is granted: the App is the limit.
    const issued = await ownAppToken(
      app,
      person,
      "write",
      repo,
      use === "git"
        ? {
            repositories: [repo.name],
            permissions: PERMISSIONS.write,
            optionalPermissions: OPTIONAL_WRITE,
          }
        : { repositories: [repo.name] },
    );

    if (use === "cli") {
      return { token: issued.token, expiresAt: issued.expiresAt };
    }

    const author = await botAuthor(await app.slug(), issued.token);
    return { token: issued.token, expiresAt: issued.expiresAt, author };
  }

  return {
    async credentials(person, repo, access, use = "git") {
      return access === "read"
        ? readCredentials(person, repo, use)
        : writeCredentials(person, repo, use);
    },

    async permission(repo, login) {
      const token = await apiToken(repo);
      try {
        const res = await http.request<{ permission: string }>(
          "GET",
          `${repoPath(repo)}/collaborators/${encodeURIComponent(login)}/permission`,
          { token },
        );

        return permissionLevel(res.data.permission);
      } catch (e) {
        if (e instanceof PortError && e.code === "not_found") {
          return "none";
        }

        throw e;
      }
    },
  };
}

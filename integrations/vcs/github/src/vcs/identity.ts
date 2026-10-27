import { PortError, type Vcs } from "@outstaff/core";
import { permissionLevel } from "../mapping.js";
import { OPTIONAL_WRITE, PERMISSIONS, repoPath } from "./context.js";
import type { GithubContext } from "./types.js";

/** Credentials for a person, and a login's permission on a repository. */
export function identityOperations(c: GithubContext): Pick<Vcs, "credentials" | "permission"> {
  const { http, self, grantOf, office, apiToken, own, botAuthor } = c;
  return {
    async credentials(person, repo, access) {
      if (access === "read") {
        // Cloning uses the read-only office App, for people with a read or write grant on the repo.
        if (!grantOf(person, repo)) {
          throw new PortError(
            "forbidden",
            `"${person}" has no grant on ${repo.owner}/${repo.name}.`,
          );
        }

        const issued = await office().token(repo, {
          repositories: [repo.name],
          permissions: PERMISSIONS.read,
        });

        return { token: issued.token, expiresAt: issued.expiresAt };
      }

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

      let issued;
      try {
        issued = await app.token(repo, {
          repositories: [repo.name],
          permissions: PERMISSIONS.write,
          optionalPermissions: OPTIONAL_WRITE,
        });
      } catch (e) {
        // The App lacks the permission, is not installed on the repo, or the repo is not visible to it.
        if (e instanceof PortError && (e.code === "invalid" || e.code === "not_found")) {
          throw new PortError(
            "forbidden",
            `${person} has no write access to ${repo.owner}/${repo.name}: ${e.message}`,
            { cause: e },
          );
        }

        throw e;
      }

      const author = await botAuthor(await app.slug(), issued.token);
      return { token: issued.token, expiresAt: issued.expiresAt, author };
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

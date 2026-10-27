import type { StandInRequest } from "@outstaff/testing.http";
import type { GithubAuth, GithubStore } from "./types.js";

/** The App ids of the in-process scheme: sam's own App, and the office App. */
export const OWN_APP = 201;
export const OFFICE_APP = 100;

const personOf = (app: number) => (app === OWN_APP ? "sam" : undefined);

const bearerOf = (req: StandInRequest) =>
  (req.headers.get("authorization") ?? "").replace(/^[Bb]earer /, "");

/** The `iss` of a JWT, unverified. */
const issuerOf = (req: StandInRequest): number =>
  Number(JSON.parse(Buffer.from(bearerOf(req).split(".")[1]!, "base64url").toString()).iss);

const granted = (level: string, write: boolean) =>
  write ? level === "write" || level === "admin" : level !== "none";

const REFUSED = {
  status: 422,
  body: { message: "The permissions requested are not granted to this installation." },
};

/**
 * The in-process scheme: a JWT names its App without a signature check, and an installation token is
 * `tok_<person>` (`tok_office` for the office App), refused when the person's seeded permission is too low.
 */
export function fakeAuth(s: GithubStore): GithubAuth {
  return {
    appOf: issuerOf,
    slugOf: (app) => personOf(app) ?? "acme-office",
    issue(app, req) {
      const person = personOf(app);

      // An App with no seeded permission is fully granted; seeding a lower level withdraws it.
      const level = person ? (s.perms.get(person) ?? "write") : "write";
      return granted(level, req.json?.permissions?.contents === "write")
        ? {
            status: 201,
            body: { token: `tok_${person ?? "office"}`, expires_at: "2099-01-01T00:00:00Z" },
          }
        : REFUSED;
    },
    actorOf: (req) => {
      const token = bearerOf(req);
      return `${token.startsWith("tok_") ? token.slice(4) : "unknown"}[bot]`;
    },
  };
}

import { appOf, installationOf, personOf } from "./requests.js";
import type { FakeState, Route } from "../types.js";

/** The App endpoints: installations, installation tokens, the App itself and bot users. */
export function authRoutes(s: FakeState): Route[] {
  const { repo, perms } = s;
  return [
    {
      method: "GET",
      path: "/app/installations",
      handler: (r) => [{ id: installationOf(appOf(r)), account: { login: repo.owner } }],
    },
    {
      method: "POST",
      path: "/app/installations/:id/access_tokens",
      handler: (r) => {
        const person = personOf(Number(r.params["id"]) - 1000);
        // An App with no seeded permission is fully granted; seeding a lower level withdraws it.
        const level = person ? (perms.get(person) ?? "write") : "write";
        const wantsWrite = r.json?.permissions?.contents === "write";
        const allowed = wantsWrite ? level === "write" || level === "admin" : level !== "none";
        if (!allowed) {
          return {
            status: 422,
            body: { message: "The permissions requested are not granted to this installation." },
          };
        }

        return {
          status: 201,
          body: { token: `tok_${person ?? "office"}`, expires_at: "2099-01-01T00:00:00Z" },
        };
      },
    },
    {
      method: "GET",
      path: "/app",
      handler: (r) => ({ slug: personOf(appOf(r)) ?? "acme-office" }),
    },
    {
      method: "GET",
      path: "/users/:login",
      handler: (r) => ({ id: 5000 + r.params["login"]!.length }),
    },
  ];
}

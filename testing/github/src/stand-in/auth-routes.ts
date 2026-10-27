import type { Route } from "@outstaff/testing.http";
import { UNAUTHORIZED } from "./model.js";
import type { GithubAuth, GithubStore } from "./types.js";

/** An installation's id is its App's id plus 1000. */
export const installationOf = (app: number) => app + 1000;

/** The App endpoints: installations, installation tokens, the App itself, and users. */
export function authRoutes(s: GithubStore, auth: GithubAuth, api: string): Route[] {
  return [
    {
      method: "GET",
      path: `${api}/app/installations`,
      handler: (r) => {
        const app = auth.appOf(r);
        return app === undefined
          ? UNAUTHORIZED
          : [{ id: installationOf(app), account: { login: s.repo.owner } }];
      },
    },
    {
      method: "POST",
      path: `${api}/app/installations/:id/access_tokens`,
      handler: (r) => {
        const app = Number(r.params["id"]) - 1000;
        return auth.appOf(r) === app ? auth.issue(app, r) : UNAUTHORIZED;
      },
    },
    {
      method: "GET",
      path: `${api}/app`,
      handler: (r) => {
        const app = auth.appOf(r);
        return app === undefined ? UNAUTHORIZED : { slug: auth.slugOf(app) };
      },
    },
    {
      method: "GET",
      path: `${api}/users/:login`,
      handler: (r) => ({ id: 5000 + r.params["login"]!.length }),
    },
  ];
}

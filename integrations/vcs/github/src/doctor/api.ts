import type { DeriveContext } from "@outstaff/core";
import { githubOptions } from "../options.js";
import type { Reply } from "./types.js";

/** Only the API root matters here; other options are not this check's business, so a stray key does not stop it. */
function apiRoot(options: unknown): string {
  const given = (options as { apiUrl?: unknown } | undefined)?.apiUrl;
  return githubOptions.shape.apiUrl.parse(given).replace(/\/+$/, "");
}

export async function call<T>(
  ctx: DeriveContext,
  method: string,
  path: string,
  token: string,
): Promise<Reply<T>> {
  const apiUrl = apiRoot(ctx.options);
  const res = await ctx.fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "outstaff-doctor",
      authorization: `Bearer ${token}`,
    },
  });

  return res.ok ? { ok: true, data: (await res.json()) as T } : { ok: false, status: res.status };
}

/** Lower-case `owner/name` of every repository the installation covers, or the failing HTTP status. */
export async function installedRepos(
  ctx: DeriveContext,
  jwt: string,
  installationId: string,
): Promise<string[] | number> {
  const minted = await call<{ token: string }>(
    ctx,
    "POST",
    `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    jwt,
  );

  if (!minted.ok) {
    return minted.status;
  }

  const names: string[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await call<{ repositories: { full_name: string }[] }>(
      ctx,
      "GET",
      `/installation/repositories?per_page=100&page=${page}`,
      minted.data.token,
    );

    if (!r.ok) {
      return r.status;
    }

    names.push(...r.data.repositories.map((x) => x.full_name.toLowerCase()));
    if (r.data.repositories.length < 100) {
      break;
    }
  }

  return names;
}

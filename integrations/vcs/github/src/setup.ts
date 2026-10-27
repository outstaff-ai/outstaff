import { readFileSync } from "node:fs";
import {
  parseRepoUrl,
  profileAllowsWrite,
  type DeriveContext,
  type Profile,
  type SecretSource,
  type SetupContext,
} from "@outstaff/core";
import { githubOptions } from "./options.js";
import { signAppJwt } from "./jwt.js";

/** Whether the person's role declares it changes CI workflow files (the `vcs.workflows` capability). */
export const needsWorkflows = (ctx: Pick<SetupContext, "roleCapabilities">): boolean =>
  ctx.roleCapabilities?.includes("vcs.workflows") ?? false;

type Team = SetupContext["team"];

/** Repositories a person has any grant on, by the grant rules of `team.people[].repos`. */
export function grantedRepos(team: Team, person: NonNullable<SetupContext["person"]>) {
  const grants = person.repos;
  return team.repos.flatMap((repo) => {
    const level = grants[repo.name] ?? grants[`kind:${repo.kind}`] ?? grants["*"];
    return level ? [{ repo, level }] : [];
  });
}

/**
 * Repositories the person's own App must be installed on: the ones they can write. The role profile caps the grant
 * the way the credential helper does; reads go through the office App.
 */
export function writableRepos(
  team: Team,
  person: NonNullable<SetupContext["person"]>,
  profile?: Profile,
) {
  return profile && !profileAllowsWrite(profile)
    ? []
    : grantedRepos(team, person).filter((g) => g.level === "write");
}

interface Api {
  get: <T>(path: string, token?: string) => Promise<T>;
}

function api(ctx: DeriveContext): Api {
  const { apiUrl } = githubOptions.parse(ctx.options ?? {});
  return {
    async get<T>(path: string, token?: string) {
      const res = await ctx.fetch(`${apiUrl}${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "outstaff-setup",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });

      if (!res.ok) {
        throw new Error(`GET ${path} returned ${res.status}`);
      }

      return (await res.json()) as T;
    },
  };
}

export function privateKey(secrets: SecretSource, prefix: string): string | undefined {
  const inline = secrets.get(`${prefix}PRIVATE_KEY`);
  if (inline) {
    return inline;
  }

  const file = secrets.get(`${prefix}PRIVATE_KEY_FILE`);
  return file ? readFileSync(file, "utf8") : undefined;
}

async function deriveApp(
  secrets: SecretSource,
  ctx: DeriveContext,
  prefix: string,
): Promise<Record<string, string>> {
  const appId = secrets.get(`${prefix}ID`);
  if (!appId) {
    return {};
  }

  let pem: string | undefined;
  try {
    pem = privateKey(secrets, prefix);
  } catch {
    ctx.warn(`${prefix}PRIVATE_KEY_FILE points at a file that cannot be read.`);
    return {};
  }

  if (!pem) {
    ctx.warn(`${prefix}ID is set but there is no private key yet; skipping that App.`);
    return {};
  }

  const gh = api(ctx);
  const jwt = signAppJwt(appId, pem, ctx.now());
  const out: Record<string, string> = {};
  let slug = secrets.get(`${prefix}SLUG`);
  if (!slug) {
    slug = (await gh.get<{ slug: string }>("/app", jwt)).slug;
    out[`${prefix}SLUG`] = slug;
  }

  if (!secrets.get(`${prefix}INSTALLATION_ID`)) {
    const owners = new Set(ctx.team.repos.map((r) => parseRepoUrl(r.url).owner.toLowerCase()));
    const installs = await gh.get<{ id: number; account?: { login: string } | null }[]>(
      "/app/installations?per_page=100",
      jwt,
    );

    const match = installs.find((i) => owners.has(i.account?.login.toLowerCase() ?? ""));
    if (match) {
      out[`${prefix}INSTALLATION_ID`] = String(match.id);
    } else {
      ctx.warn(
        `The App ${slug} is not installed on ${[...owners].join(", ")}; install it, then run this again.`,
      );
    }
  }

  if (!secrets.get(`${prefix}BOT_EMAIL`)) {
    const bot = await gh.get<{ id: number }>(`/users/${encodeURIComponent(`${slug}[bot]`)}`);
    out[`${prefix}BOT_EMAIL`] = `${bot.id}+${slug}[bot]@users.noreply.github.com`;
  }

  return out;
}

export async function deriveGithub(
  secrets: SecretSource,
  ctx: DeriveContext,
): Promise<Record<string, string>> {
  const prefixes = ctx.scope === "person" ? ["GH_APP_", "GH_OFFICE_APP_"] : ["GH_OFFICE_APP_"];
  const out: Record<string, string> = {};
  for (const prefix of prefixes) {
    try {
      Object.assign(out, await deriveApp(secrets, ctx, prefix));
    } catch (e) {
      ctx.warn(`GitHub ${prefix}: ${(e as Error).message}`);
    }
  }

  return out;
}

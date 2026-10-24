import { readFileSync } from "node:fs";
import {
  parseRepoUrl,
  profileAllowsWrite,
  type DeriveContext,
  type Profile,
  type SecretSource,
  type SetupContext,
  type SetupStep,
} from "@outstaff/core";
import { githubOptions } from "./options.js";
import { signAppJwt } from "./jwt.js";

const READ = {
  metadata: "read",
  contents: "read",
  pull_requests: "read",
  issues: "read",
  checks: "read",
  statuses: "read",
} as const;

const WRITE = { ...READ, contents: "write", pull_requests: "write", issues: "write" } as const;

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

const slugOf = (team: Team, who: string) => `${team.team.name}-${who}`.slice(0, 34);

function manifest(name: string, permissions: Record<string, string>): string {
  return JSON.stringify(
    {
      name,
      url: "https://github.com",
      public: false,
      hook_attributes: { url: "https://example.invalid/unused", active: false },
      default_permissions: permissions,
      default_events: [],
    },
    null,
    2,
  );
}

const keyHelp = (prefix: string) =>
  `Keep the App id as \`${prefix}ID\`. Keep the private key as \`${prefix}PRIVATE_KEY\` (a file named that in your secrets directory holding the PEM text) or point \`${prefix}PRIVATE_KEY_FILE\` at the file. \`ost setup --derive\` fills \`${prefix}SLUG\`, \`${prefix}INSTALLATION_ID\` and \`${prefix}BOT_EMAIL\` from them, and offers to move a freshly downloaded \`*.pem\` for the App from your Downloads folder.`;

const createStep = (
  title: string,
  appName: string,
  permissions: Record<string, string>,
  summary: string,
): SetupStep => ({
  title,
  body: `Open GitHub > Settings (or the organization's settings) > Developer settings > GitHub Apps > New GitHub App. Name it \`${appName}\`, leave the webhook off, and set these repository permissions, which are the only ones the adapter uses: ${summary} Set "Where can this GitHub App be installed" to "Only on this account". The manifest below lists the same settings; GitHub only takes it through the app-manifest flow, so use it as the checklist.`,
  manifest: manifest(appName, permissions),
});

export function githubSetupGuide(ctx: SetupContext): SetupStep[] {
  const { team, person, scope } = ctx;
  if (scope === "office" || !person) {
    const all = team.repos.map((r) => `\`${r.url}\``).join(", ");
    return [
      createStep(
        "Create the office GitHub App",
        slugOf(team, "office"),
        READ,
        "metadata, contents, pull requests, issues, checks and commit statuses, all read-only.",
      ),
      {
        title: "Install it on exactly the team repositories",
        body: `On the App's page choose Install App, pick the account that owns the repositories, and select "Only select repositories": ${all}. Nothing else.`,
      },
      {
        title: "Generate a private key and copy the keys",
        body: `On the App's page, Private keys > Generate a private key. ${keyHelp("GH_OFFICE_APP_")} Agents need the same three values for the read-only office App, since they clone read-granted repositories with it.`,
      },
    ];
  }

  const granted = grantedRepos(team, person);
  if (granted.length === 0) {
    return [
      {
        title: `${person.name} needs no GitHub credentials`,
        body: "This person has no repository grants, so they need neither their own GitHub App nor the office App's keys, and their agent starts without a code host. Give them a grant under `people[].repos` if they should read or change code.",
      },
    ];
  }

  const writable = writableRepos(team, person, ctx.profile);
  const writes = writable.length > 0;
  const list = writable.map((g) => `\`${g.repo.url}\``).join(", ");

  return [
    createStep(
      `${writes ? "Create" : "Optionally create"} ${person.name}'s GitHub App`,
      slugOf(team, person.handle),
      writes ? WRITE : READ,
      writes
        ? "metadata, checks and commit statuses read-only; contents, pull requests and issues read and write (pull requests are commented on through the issues API)."
        : "metadata, contents, pull requests, issues, checks and commit statuses, all read-only. This person has only read grants, so their own App is optional: it lets them comment on or review pull requests as themselves.",
    ),
    {
      title: writes
        ? "Install it on exactly the repositories this person can write"
        : "Install it on no repository, or skip it",
      body: writes
        ? `Install App, pick the owning account, "Only select repositories": ${list}. Nothing else: the App carries write permissions, and a GitHub App's permissions are per installation, not per repository, so the repository list is the real boundary. Read access comes from the office App, so read-only repositories do not belong on this installation.`
        : "This person has no write access, so their own App needs no repository. Read access comes from the office App.",
    },
    {
      title: "Generate a private key and copy the keys",
      body: `Private keys > Generate a private key. ${keyHelp("GH_APP_")}`,
    },
    {
      title: "Add the office App's keys",
      body: "Agents clone read-granted repositories with the shared read-only office App. Put the same `GH_OFFICE_APP_*` values the office uses in this person's secrets (see `ost setup office`).",
    },
  ];
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

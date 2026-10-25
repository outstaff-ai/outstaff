import {
  parseRepoUrl,
  type DeriveContext,
  type DoctorCheck,
  type SecretSource,
} from "@outstaff/core";
import { githubOptions } from "./options.js";
import { signAppJwt } from "./jwt.js";
import { grantedRepos, needsWorkflows, privateKey, writableRepos } from "./setup.js";

const READ_PERMISSIONS = [
  "metadata",
  "contents",
  "pull_requests",
  "issues",
  "checks",
  "statuses",
] as const;

const WRITE_PERMISSIONS = ["contents", "pull_requests", "issues"] as const;

interface Installation {
  account?: { login: string } | null;
  repository_selection?: "all" | "selected";
  permissions?: Record<string, string>;
}

type Reply<T> = { ok: true; data: T } | { ok: false; status: number };

const ok = (name: string, detail: string, key?: string): DoctorCheck => ({
  ...(key ? { key } : {}),
  name,
  status: "ok",
  detail,
});

const bad = (
  status: "warn" | "fail",
  name: string,
  detail: string,
  fix: string,
  key?: string,
): DoctorCheck => ({ ...(key ? { key } : {}), name, status, detail, fix });

const repoName = (url: string) => {
  const r = parseRepoUrl(url);
  return `${r.owner}/${r.name}`.toLowerCase();
};

/** Only the API root matters here; other options are not this check's business, so a stray key does not stop it. */
function apiRoot(options: unknown): string {
  const given = (options as { apiUrl?: unknown } | undefined)?.apiUrl;
  return githubOptions.shape.apiUrl.parse(given).replace(/\/+$/, "");
}

async function call<T>(
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
async function installedRepos(
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

interface AppExpectation {
  prefix: "GH_APP_" | "GH_OFFICE_APP_";
  label: string;

  /** Lower-case `owner/name` the installation has to cover. */
  repos: string[];

  /** Repositories beyond `repos` are a finding only when the App is meant to be narrow. */
  exact: boolean;

  /** Names the risk of extra repositories: the person's own App can write there. */
  extraCanWrite?: boolean;
  readOnly: boolean;
  wantWrite: boolean;

  /** The person's role changes CI workflow files, so the App needs the Workflows permission. */
  wantWorkflows?: boolean;

  /** The bot login the team file names for this App. */
  login?: string;
}

async function checkApp(
  secrets: SecretSource,
  ctx: DeriveContext,
  want: AppExpectation,
): Promise<DoctorCheck[]> {
  const { prefix, label } = want;
  const id = secrets.get(`${prefix}ID`);
  let pem: string | undefined;
  try {
    pem = privateKey(secrets, prefix);
  } catch {
    return [
      bad(
        "fail",
        `${label}: private key file`,
        `${prefix}PRIVATE_KEY_FILE points at a file that cannot be read.`,
        `Point ${prefix}PRIVATE_KEY_FILE at the downloaded .pem, or provide ${prefix}PRIVATE_KEY.`,
        `${prefix}PRIVATE_KEY_FILE`,
      ),
    ];
  }

  if (!id || !pem) {
    return [];
  }

  let jwt: string;
  try {
    jwt = signAppJwt(id, pem, ctx.now());
  } catch {
    return [
      bad(
        "fail",
        `${label}: private key`,
        `${prefix}PRIVATE_KEY is not a usable RSA private key in PEM form.`,
        "Generate a new private key on the App's page and store the whole PEM text.",
        `${prefix}PRIVATE_KEY`,
      ),
    ];
  }

  const app = await call<{ slug: string }>(ctx, "GET", "/app", jwt);
  if (!app.ok) {
    return [
      bad(
        "fail",
        `${label}: authenticates`,
        `GitHub answered ${app.status} to /app, so ${prefix}ID or ${prefix}PRIVATE_KEY is wrong${app.status === 401 ? " (or the clock is off by more than a minute)" : ""}.`,
        `Check ${prefix}ID is the App id (a number, not the client id) and the key belongs to that App.`,
        `${prefix}ID`,
      ),
    ];
  }

  const out: DoctorCheck[] = [
    ok(`${label}: authenticates`, `The key signs a JWT and /app answers (${app.data.slug}).`),
  ];

  const slug = secrets.get(`${prefix}SLUG`);
  if (slug && slug !== app.data.slug) {
    out.push(
      bad(
        "fail",
        `${label}: slug`,
        `${prefix}SLUG is "${slug}" but the App's slug is "${app.data.slug}".`,
        `Set ${prefix}SLUG to ${app.data.slug}, or run \`ost setup --derive\`.`,
        `${prefix}SLUG`,
      ),
    );
  } else if (slug) {
    out.push(ok(`${label}: slug`, `${prefix}SLUG matches the App.`, `${prefix}SLUG`));
  }

  if (want.login && want.login !== `${app.data.slug}[bot]`) {
    out.push(
      bad(
        "fail",
        `${label}: identity`,
        `identities.vcs is "${want.login}" but this App's bot is "${app.data.slug}[bot]".`,
        `Set identities.vcs to ${app.data.slug}[bot] in the team file.`,
      ),
    );
  } else if (want.login) {
    out.push(ok(`${label}: identity`, `identities.vcs matches ${want.login}.`));
  }

  const installationId = secrets.get(`${prefix}INSTALLATION_ID`);
  if (!installationId) {
    return out;
  }

  const inst = await call<Installation>(
    ctx,
    "GET",
    `/app/installations/${encodeURIComponent(installationId)}`,
    jwt,
  );

  if (!inst.ok) {
    out.push(
      bad(
        "fail",
        `${label}: installation`,
        `${prefix}INSTALLATION_ID is "${installationId}" but GitHub answered ${inst.status} for that installation of ${app.data.slug}.`,
        "Install the App on the team's account, then run `ost setup --derive` or copy the number from the installation URL.",
        `${prefix}INSTALLATION_ID`,
      ),
    );

    return out;
  }

  const owners = new Set(want.repos.map((r) => r.split("/")[0]!));
  const account = inst.data.account?.login.toLowerCase();
  if (account && owners.size > 0 && !owners.has(account)) {
    out.push(
      bad(
        "fail",
        `${label}: installation`,
        `${prefix}INSTALLATION_ID belongs to "${account}" but the repositories are owned by ${[...owners].join(", ")}.`,
        "Use the installation on the account that owns the team repositories.",
        `${prefix}INSTALLATION_ID`,
      ),
    );

    return out;
  }

  out.push(ok(`${label}: installation`, `${prefix}INSTALLATION_ID is an installation of the App.`));

  const granted = inst.data.permissions ?? {};
  const level = (p: string) => granted[p] ?? "none";
  const missingRead = READ_PERMISSIONS.filter((p) => level(p) === "none");
  const missingWrite: string[] = want.wantWrite
    ? WRITE_PERMISSIONS.filter((p) => level(p) !== "write")
    : [];

  const missingWorkflows = want.wantWorkflows && level("workflows") !== "write";
  if (missingWorkflows) {
    missingWrite.push("workflows");
  }

  if (missingRead.length > 0 || missingWrite.length > 0) {
    out.push(
      bad(
        "fail",
        `${label}: permissions`,
        `The App lacks ${[
          ...missingRead.map((p) => `${p}:read`),
          ...missingWrite.map((p) => `${p}:write`),
        ].join(
          ", ",
        )}${want.wantWrite ? " (this person has a write grant)" : ""}${missingWorkflows ? ". Without Workflows, GitHub refuses to push a change under .github/workflows/ (this person's role changes CI)" : ""}.`,
        "Edit the App's permissions, then accept the new permissions on the installation.",
      ),
    );
  } else {
    out.push(ok(`${label}: permissions`, "The App has the permissions the grants need."));
  }

  // Least privilege: a permission outside what the grants and the role need is advice, not a failure.
  const needed = new Set<string>([
    ...READ_PERMISSIONS,
    ...(want.wantWorkflows ? ["workflows"] : []),
  ]);

  const surplus = Object.entries(granted)
    .filter(([name, v]) => v !== "none" && !needed.has(name))
    .map(([name, v]) => `${name}:${v}`);

  if (surplus.length > 0) {
    out.push(
      bad(
        "warn",
        `${label}: surplus permissions`,
        `The App has ${surplus.join(", ")}, which neither the grants nor this person's role need.`,
        "Remove those permissions from the App, then accept the change on the installation.",
      ),
    );
  }

  const writes = Object.entries(granted)
    .filter(([, v]) => v === "write" || v === "admin")
    .map(([k, v]) => `${k}:${v}`);

  if (want.readOnly && writes.length > 0) {
    out.push(
      bad(
        "fail",
        `${label}: read-only`,
        `The office App must be read-only but has ${writes.join(", ")}.`,
        "Set every permission of the office App to read-only (or no access).",
      ),
    );
  } else if (want.readOnly) {
    out.push(ok(`${label}: read-only`, "The App has no write permission."));
  } else if (!want.readOnly && !want.wantWrite && writes.length > 0) {
    out.push(
      bad(
        "warn",
        `${label}: unused write access`,
        `This person has no write grant but the App has ${writes.join(", ")}.`,
        "Reduce the App to read-only permissions.",
      ),
    );
  }

  if (inst.data.repository_selection === "all") {
    out.push(
      bad(
        "warn",
        `${label}: repositories`,
        "The App is installed on all repositories of the account.",
        want.extraCanWrite
          ? 'Change the installation to "Only select repositories" and pick exactly the ones this person can write.'
          : 'Change the installation to "Only select repositories" and pick exactly the granted ones.',
      ),
    );

    return out;
  }

  const have = await installedRepos(ctx, jwt, installationId);
  if (typeof have === "number") {
    out.push(
      bad(
        "fail",
        `${label}: repositories`,
        `GitHub answered ${have} when listing the repositories of installation ${installationId}.`,
        "Check the App is installed and its permissions were accepted.",
      ),
    );

    return out;
  }

  const missing = want.repos.filter((r) => !have.includes(r));
  const extra = have.filter((r) => !want.repos.includes(r));
  if (missing.length > 0) {
    out.push(
      bad(
        "fail",
        `${label}: repositories`,
        `The installation does not cover ${missing.join(", ")}.`,
        "Add those repositories to the App's installation.",
      ),
    );
  }

  // An own App without write permissions cannot write to extra repositories, so they are no finding.
  const warnExtra = want.exact && extra.length > 0 && (!want.extraCanWrite || writes.length > 0);
  if (warnExtra) {
    out.push(
      bad(
        "warn",
        `${label}: extra repositories`,
        want.extraCanWrite
          ? `The App can write to ${extra.join(", ")}, which this person may only read (or has no grant on).`
          : `The installation also covers ${extra.join(", ")}, which are not granted.`,
        "Remove those repositories from the installation.",
      ),
    );
  }

  if (missing.length === 0 && !warnExtra) {
    out.push(
      ok(
        `${label}: repositories`,
        want.repos.length === 0
          ? "The person needs no repositories on this App."
          : `The installation covers ${want.repos.join(", ")}.`,
      ),
    );
  }

  return out;
}

export async function doctorGithub(
  secrets: SecretSource,
  ctx: DeriveContext,
): Promise<DoctorCheck[]> {
  const apps: AppExpectation[] = [];
  if (ctx.scope === "person" && ctx.person) {
    const person = ctx.person;
    const granted = grantedRepos(ctx.team, person);
    if (granted.length === 0) {
      return [
        ok(
          "GitHub credentials",
          `${person.handle} has no repository grants, so no GitHub credentials are needed or checked.`,
        ),
      ];
    }

    // Reads and clones go through the office App; the own App only needs the repositories the person can write.
    const writable = writableRepos(ctx.team, person, ctx.profile);
    apps.push({
      prefix: "GH_APP_",
      label: "GitHub App",
      repos: writable.map((g) => repoName(g.repo.url)),
      exact: true,
      extraCanWrite: true,
      readOnly: false,
      wantWrite: writable.length > 0,
      wantWorkflows: writable.length > 0 && needsWorkflows(ctx),
      ...(person.identities?.vcs ? { login: person.identities.vcs } : {}),
    });

    // Agents clone read-granted repositories with the office App, which covers more than they are granted.
    apps.push({
      prefix: "GH_OFFICE_APP_",
      label: "Office GitHub App",
      repos: granted.map((g) => repoName(g.repo.url)),
      exact: false,
      readOnly: true,
      wantWrite: false,
    });
  } else {
    apps.push({
      prefix: "GH_OFFICE_APP_",
      label: "Office GitHub App",
      repos: ctx.team.repos.map((r) => repoName(r.url)),
      exact: true,
      readOnly: true,
      wantWrite: false,
    });
  }

  const out: DoctorCheck[] = [];
  for (const app of apps) {
    try {
      out.push(...(await checkApp(secrets, ctx, app)));
    } catch (e) {
      out.push(
        bad(
          "fail",
          `${app.label}: reachable`,
          `GitHub could not be reached: ${(e as Error).message}`,
          "Check the network and the apiUrl option of the github integration.",
        ),
      );
    }
  }

  return out;
}

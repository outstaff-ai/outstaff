import type { DeriveContext, DoctorCheck, SecretSource } from "@outstaff/core";
import { signAppJwt } from "#/jwt.js";
import { assetsCheck } from "./assets.js";
import { privateKey } from "#/setup.js";
import { call } from "./api.js";
import { bad, ok } from "./findings.js";
import { permissionChecks } from "./permissions.js";
import { repositoryChecks } from "./repositories.js";
import { reposByOwner, resolveAccounts } from "./accounts.js";
import type { AccountInstallation, AppExpectation, Installation } from "./types.js";
import { workflowRepos, workflowsCheck } from "./workflows.js";

/** Signs the App's JWT from its stored id and key; findings instead when the key is unusable, none when either is unset. */
function signJwt(
  secrets: SecretSource,
  ctx: DeriveContext,
  want: AppExpectation,
): { jwt: string } | { findings: DoctorCheck[] } {
  const { prefix, label } = want;
  const id = secrets.get(`${prefix}ID`);
  let pem: string | undefined;
  try {
    pem = privateKey(secrets, prefix);
  } catch {
    return {
      findings: [
        bad(
          "fail",
          `${label}: private key file`,
          `${prefix}PRIVATE_KEY_FILE points at a file that cannot be read.`,
          `Point ${prefix}PRIVATE_KEY_FILE at the downloaded .pem, or provide ${prefix}PRIVATE_KEY.`,
          `${prefix}PRIVATE_KEY_FILE`,
        ),
      ],
    };
  }

  if (!id || !pem) {
    return { findings: [] };
  }

  try {
    return { jwt: signAppJwt(id, pem, ctx.now()) };
  } catch {
    return {
      findings: [
        bad(
          "fail",
          `${label}: private key`,
          `${prefix}PRIVATE_KEY is not a usable RSA private key in PEM form.`,
          "Generate a new private key on the App's page and store the whole PEM text.",
          `${prefix}PRIVATE_KEY`,
        ),
      ],
    };
  }
}

function slugCheck(secrets: SecretSource, want: AppExpectation, slug: string): DoctorCheck[] {
  const { prefix, label } = want;
  const stored = secrets.get(`${prefix}SLUG`);
  if (!stored) {
    return [];
  }

  if (stored !== slug) {
    return [
      bad(
        "fail",
        `${label}: slug`,
        `${prefix}SLUG is "${stored}" but the App's slug is "${slug}".`,
        `Set ${prefix}SLUG to ${slug}, or run \`ost setup --derive\`.`,
        `${prefix}SLUG`,
      ),
    ];
  }

  return [ok(`${label}: slug`, `${prefix}SLUG matches the App.`, `${prefix}SLUG`)];
}

function identityCheck(want: AppExpectation, slug: string): DoctorCheck[] {
  const { label, login } = want;
  if (!login) {
    return [];
  }

  if (login !== `${slug}[bot]`) {
    return [
      bad(
        "fail",
        `${label}: identity`,
        `identities.vcs is "${login}" but this App's bot is "${slug}[bot]".`,
        `Set identities.vcs to ${slug}[bot] in the team file.`,
      ),
    ];
  }

  return [ok(`${label}: identity`, `identities.vcs matches ${login}.`)];
}

/** Permissions, workflows and repository coverage of the App's installation on one account. */
async function accountChecks(
  ctx: DeriveContext,
  jwt: string,
  inst: AccountInstallation,
  slug: string,
): Promise<DoctorCheck[]> {
  const { want, id, data } = inst;
  const granted = data.permissions ?? {};
  const repos = await workflowRepos(ctx, jwt, id, want);
  const { checks, writes } = permissionChecks({ ...want, workflowRepos: repos }, granted);
  return [
    ...checks,
    ...workflowsCheck(want, slug, granted, repos),
    ...(await repositoryChecks(ctx, jwt, id, want, data.repository_selection, writes)),
    ...(await assetsCheck(ctx, jwt, id, want, slug)),
  ];
}

/** Whether the pinned installation is on an account that owns repositories of `want`, naming the account. */
function pinnedCheck(want: AppExpectation, account: string): DoctorCheck {
  const { prefix, label } = want;
  const owners = [...reposByOwner(want).keys()];
  if (owners.length > 0 && !owners.includes(account)) {
    return bad(
      "fail",
      `${label}: installation`,
      `${prefix}INSTALLATION_ID belongs to "${account}" but the repositories are owned by ${owners.join(", ")}.`,
      "Pin the installation on an account that owns the repositories (clear it and run `ost setup --derive`); the App's installations on the other accounts are looked up.",
      `${prefix}INSTALLATION_ID`,
    );
  }

  return ok(
    `${label}: installation`,
    `${prefix}INSTALLATION_ID is an installation of the App on ${account || "an unknown account"}.`,
    `${prefix}INSTALLATION_ID`,
  );
}

/** The pinned installation, then the App's installation on every account that owns repositories of `want`. */
async function installationChecks(
  ctx: DeriveContext,
  jwt: string,
  want: AppExpectation,
  installationId: string,
  slug: string,
): Promise<DoctorCheck[]> {
  const { prefix, label } = want;
  const inst = await call<Installation>(
    ctx,
    "GET",
    `/app/installations/${encodeURIComponent(installationId)}`,
    jwt,
  );

  if (!inst.ok) {
    return [
      bad(
        "fail",
        `${label}: installation`,
        `${prefix}INSTALLATION_ID is "${installationId}" but GitHub answered ${inst.status} for that installation of ${slug}.`,
        "Install the App on the account that owns the repositories, then run `ost setup --derive` or copy the number from the installation URL.",
        `${prefix}INSTALLATION_ID`,
      ),
    ];
  }

  const account = inst.data.account?.login.toLowerCase() ?? "";
  const pinned = { account, id: installationId, data: inst.data, want };
  const { accounts, findings } = await resolveAccounts(ctx, jwt, want, slug, pinned);
  const out = [pinnedCheck(want, account), ...findings];
  for (const one of accounts) {
    out.push(...(await accountChecks(ctx, jwt, one, slug)));
  }

  return out;
}

export async function checkApp(
  secrets: SecretSource,
  ctx: DeriveContext,
  want: AppExpectation,
): Promise<DoctorCheck[]> {
  const { prefix, label } = want;
  const signed = signJwt(secrets, ctx, want);
  if ("findings" in signed) {
    return signed.findings;
  }

  const app = await call<{ slug: string }>(ctx, "GET", "/app", signed.jwt);
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

  const { slug } = app.data;
  const out: DoctorCheck[] = [
    ok(`${label}: authenticates`, `The key signs a JWT and /app answers (${slug}).`),
    ...slugCheck(secrets, want, slug),
    ...identityCheck(want, slug),
  ];

  const installationId = secrets.get(`${prefix}INSTALLATION_ID`);
  if (!installationId) {
    return out;
  }

  return [...out, ...(await installationChecks(ctx, signed.jwt, want, installationId, slug))];
}

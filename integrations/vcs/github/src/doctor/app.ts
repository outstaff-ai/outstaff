import type { DeriveContext, DoctorCheck, SecretSource } from "@outstaff/core";
import { signAppJwt } from "../jwt.js";
import { privateKey } from "../setup.js";
import { call } from "./api.js";
import { bad, ok } from "./findings.js";
import { permissionChecks } from "./permissions.js";
import { repositoryChecks } from "./repositories.js";
import type { AppExpectation, Installation } from "./types.js";

export async function checkApp(
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

  const { checks, writes } = permissionChecks(want, inst.data.permissions ?? {});
  out.push(...checks);
  out.push(
    ...(await repositoryChecks(
      ctx,
      jwt,
      installationId,
      want,
      inst.data.repository_selection,
      writes,
    )),
  );

  return out;
}

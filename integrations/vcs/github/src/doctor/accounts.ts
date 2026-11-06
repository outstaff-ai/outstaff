import type { DeriveContext, DoctorCheck } from "@outstaff/core";
import { call } from "./api.js";
import { bad, ok } from "./findings.js";
import type { AccountInstallation, AppExpectation, Installation, Resolved } from "./types.js";

/** The repositories of `want`, grouped by their lower-case owner, in the order they first appear. */
export function reposByOwner(want: AppExpectation): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const repo of want.repos) {
    const owner = repo.split("/")[0]!;
    owners.set(owner, [...(owners.get(owner) ?? []), repo]);
  }

  return owners;
}

/** `want` for one account: only its repositories, and the account in the label when the repositories span several. */
function forAccount(want: AppExpectation, account: string, repos: string[], several: boolean) {
  return { ...want, repos, label: several ? `${want.label} on ${account}` : want.label };
}

/** The App's other installations by lower-case account (`GET /app/installations`), or the failing HTTP status. */
async function listInstallations(
  ctx: DeriveContext,
  jwt: string,
): Promise<Map<string, Installation> | number> {
  const r = await call<Installation[]>(ctx, "GET", "/app/installations?per_page=100", jwt);
  if (!r.ok) {
    return r.status;
  }

  return new Map(r.data.map((i) => [i.account?.login.toLowerCase() ?? "", i]));
}

const listFailed = (want: AppExpectation, slug: string, status: number): DoctorCheck =>
  bad(
    "fail",
    `${want.label}: installations`,
    `GitHub answered ${status} when listing the installations of ${slug}.`,
    "Check the App's id and key, then run the doctor again.",
  );

const notInstalled = (want: AppExpectation, slug: string, account: string): DoctorCheck =>
  bad(
    "fail",
    `${want.label}: installation`,
    `${slug} is not installed on ${account}, which owns ${want.repos.join(", ")}.`,
    `Make the App public (its settings > Advanced > Make public), then install it on ${account} with only those repositories.`,
  );

const installed = (want: AppExpectation, slug: string, account: string): DoctorCheck =>
  ok(`${want.label}: installation`, `${slug} is installed on ${account}.`);

function addLookedUp(
  out: Resolved,
  data: Installation | undefined,
  slug: string,
  account: string,
  want: AppExpectation,
): void {
  if (!data) {
    out.findings.push(notInstalled(want, slug, account));
    return;
  }

  out.findings.push(installed(want, slug, account));
  out.accounts.push({ account, id: String(data.id), data, want });
}

/**
 * The App's installation on each account that owns repositories of `want`: the pinned one for its own account, the
 * others looked up. With no repositories, the pinned installation alone.
 */
export async function resolveAccounts(
  ctx: DeriveContext,
  jwt: string,
  want: AppExpectation,
  slug: string,
  pinned: AccountInstallation,
): Promise<Resolved> {
  const owners = reposByOwner(want);
  const several = owners.size > 1;
  const others = [...owners].filter(([account]) => account !== pinned.account);
  const out: Resolved = { accounts: [], findings: [] };
  const own = owners.get(pinned.account);
  if (owners.size === 0 || own) {
    out.accounts.push({ ...pinned, want: forAccount(want, pinned.account, own ?? [], several) });
  }

  if (others.length === 0) {
    return out;
  }

  const listed = await listInstallations(ctx, jwt);
  if (typeof listed === "number") {
    return { ...out, findings: [listFailed(want, slug, listed)] };
  }

  for (const [account, repos] of others) {
    addLookedUp(out, listed.get(account), slug, account, forAccount(want, account, repos, several));
  }

  return out;
}

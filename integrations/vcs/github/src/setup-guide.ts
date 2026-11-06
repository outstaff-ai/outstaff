import { parseRepoUrl, type SetupContext, type SetupStep } from "@outstaff/core";
import { grantedRepos, needsWorkflows, writableRepos } from "./setup.js";

type Team = SetupContext["team"];
type Person = NonNullable<SetupContext["person"]>;

const READ = {
  metadata: "read",
  contents: "read",
  pull_requests: "read",
  issues: "read",
  checks: "read",
  statuses: "read",
} as const;

/** Actions: read lets the office read the log of a check that failed after a merge, for the agent it wakes. */
const OFFICE = { ...READ, actions: "read" } as const;

/** Actions: read lets a person who can write read the logs of a failed CI job (`ost pr checks`). */
const WRITE = {
  ...READ,
  actions: "read",
  contents: "write",
  pull_requests: "write",
  issues: "write",
} as const;

/** Needed to push changes under `.github/workflows/`; GitHub rejects such a push from an App without it. */
const WORKFLOWS = { workflows: "write" } as const;

const slugOf = (team: Team, who: string) => `${team.team.name}-${who}`.slice(0, 34);

/** The lower-case account that owns a repository URL; GitHub logins ignore case. */
const ownerOf = (url: string) => parseRepoUrl(url).owner.toLowerCase();

/** The accounts that own `urls`, in the order they first appear. */
const accountsOf = (urls: string[]) => [...new Set(urls.map(ownerOf))];

function manifest(name: string, permissions: Record<string, string>, isPublic: boolean): string {
  return JSON.stringify(
    {
      name,
      url: "https://github.com",
      public: isPublic,
      hook_attributes: { url: "https://example.invalid/unused", active: false },
      default_permissions: permissions,
      default_events: [],
    },
    null,
    2,
  );
}

const WORKFLOWS_NOTE =
  " Workflows read and write too: this person's role changes CI, and GitHub refuses a push that touches `.github/workflows/` from an App without it. Mind the risk: a workflow can read the repository's Actions secrets when it runs, so grant Workflows only to roles that need it and review such pull requests with care.";

const keyHelp = (prefix: string) =>
  `Keep the App id as \`${prefix}ID\`. Keep the private key as \`${prefix}PRIVATE_KEY\` (a file named that in your secrets directory holding the PEM text) or point \`${prefix}PRIVATE_KEY_FILE\` at the file. \`ost setup --derive\` fills \`${prefix}SLUG\`, \`${prefix}INSTALLATION_ID\` and \`${prefix}BOT_EMAIL\` from them, and offers to move a freshly downloaded \`*.pem\` for the App from your Downloads folder.`;

/** Where the App may be installed: only its own account, or any account when the repositories span several. */
const whereInstalled = (accounts: string[]) =>
  accounts.length > 1
    ? `Set "Where can this GitHub App be installed" to "Any account": the repositories belong to ${accounts.join(", ")}, and an App installs on an account other than its own only when it is public. Public only lets other accounts install it: the key stays with you, and the App reaches only the repositories each installation selects.`
    : 'Set "Where can this GitHub App be installed" to "Only on this account".';

const createStep = (
  title: string,
  appName: string,
  permissions: Record<string, string>,
  summary: string,
  accounts: string[] = [],
): SetupStep => ({
  title,
  body: `Open GitHub > Settings (or the organization's settings) > Developer settings > GitHub Apps > New GitHub App. Name it \`${appName}\`, leave the webhook off, and set these repository permissions, which are the only ones the adapter uses: ${summary} ${whereInstalled(accounts)} The manifest below lists the same settings; GitHub only takes it through the app-manifest flow, so use it as the checklist.`,
  manifest: manifest(appName, permissions, accounts.length > 1),
});

/** Which account to install on, with the repositories each one owns when there are several. */
function installOn(urls: string[]): string {
  const accounts = accountsOf(urls);
  const list = (of: string[]) => of.map((u) => `\`${u}\``).join(", ");
  if (accounts.length <= 1) {
    return `On the App's page choose Install App, pick the account that owns the repositories, and select "Only select repositories": ${list(urls)}.`;
  }

  const each = accounts.map((a) => `on ${a}, ${list(urls.filter((u) => ownerOf(u) === a))}`);

  return `The repositories belong to ${accounts.length} accounts, so install the App on each of them with only that account's repositories: on the App's page choose Install App, pick the account, and select "Only select repositories": ${each.join("; ")}. \`ost setup --derive\` keeps one installation id; the installations on the other accounts are looked up.`;
}

function officeGuide(team: Team): SetupStep[] {
  const urls = team.repos.map((r) => r.url);
  return [
    createStep(
      "Create the office GitHub App",
      slugOf(team, "office"),
      OFFICE,
      "metadata, contents, pull requests, issues, checks, commit statuses and Actions (to read the log of a check that fails after a merge, for the agent it wakes), all read-only.",
      accountsOf(urls),
    ),
    {
      title: "Install it on exactly the team repositories",
      body: `${installOn(urls)} Nothing else.`,
    },
    {
      title: "Generate a private key and copy the keys",
      body: `On the App's page, Private keys > Generate a private key. ${keyHelp("GH_OFFICE_APP_")} Agents need the same three values for the read-only office App, since they clone read-granted repositories with it.`,
    },
  ];
}

/** The person's own App when they can write: write permissions, installed on exactly those repositories. */
function writerAppSteps(
  ctx: SetupContext,
  person: Person,
  writable: ReturnType<typeof writableRepos>,
): SetupStep[] {
  const workflows = needsWorkflows(ctx);
  const urls = writable.map((g) => g.repo.url);
  return [
    createStep(
      `Create ${person.name}'s GitHub App`,
      slugOf(ctx.team, person.handle),
      workflows ? { ...WRITE, ...WORKFLOWS } : WRITE,
      `metadata, checks, commit statuses and Actions (to read the logs of failed CI jobs) read-only; contents, pull requests and issues read and write (pull requests are commented on through the issues API).${workflows ? WORKFLOWS_NOTE : ""}`,
      accountsOf(urls),
    ),
    {
      title: "Install it on exactly the repositories this person can write",
      body: `${installOn(urls)} Nothing else: the App carries write permissions, and a GitHub App's permissions are per installation, not per repository, so the repository list is the real boundary. Read access comes from the office App, so read-only repositories do not belong on this installation.`,
    },
  ];
}

/** The person's own App when they only read: optional, read-only, on no repository. */
function readerAppSteps(team: Team, person: Person): SetupStep[] {
  return [
    createStep(
      `Optionally create ${person.name}'s GitHub App`,
      slugOf(team, person.handle),
      READ,
      "metadata, contents, pull requests, issues, checks and commit statuses, all read-only. This person has only read grants, so their own App is optional: it lets them comment on or review pull requests as themselves.",
    ),
    {
      title: "Install it on no repository, or skip it",
      body: "This person has no write access, so their own App needs no repository. Read access comes from the office App.",
    },
  ];
}

function personGuide(ctx: SetupContext, person: Person): SetupStep[] {
  const writable = writableRepos(ctx.team, person, ctx.profile);
  return [
    ...(writable.length > 0
      ? writerAppSteps(ctx, person, writable)
      : readerAppSteps(ctx.team, person)),
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

export function githubSetupGuide(ctx: SetupContext): SetupStep[] {
  const { team, person, scope } = ctx;
  if (scope === "office" || !person) {
    return officeGuide(team);
  }

  if (grantedRepos(team, person).length === 0) {
    return [
      {
        title: `${person.name} needs no GitHub credentials`,
        body: "This person has no repository grants, so they need neither their own GitHub App nor the office App's keys, and their agent starts without a code host. Give them a grant under `people[].repos` if they should read or change code.",
      },
    ];
  }

  return personGuide(ctx, person);
}

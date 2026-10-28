import type { Route, StandInRequest } from "@outstaff/testing.http";
import type { BareRepo, createGithubE2e } from "@outstaff/testing.github/stand-in";
import type { createItsaplanE2e } from "@outstaff/testing.itsaplan/stand-in";
import type { createChat } from "./chat.ts";

/** What the driver's control surface acts on. */
export interface World {
  repo: BareRepo;
  github: ReturnType<typeof createGithubE2e>;
  tracker: ReturnType<typeof createItsaplanE2e>;
  chat: ReturnType<typeof createChat>;
}

const ok = (body: unknown = { ok: true }) => body;

const REVIEW_EVENTS: Record<string, string> = {
  approved: "APPROVE",
  changes_requested: "REQUEST_CHANGES",
  commented: "COMMENT",
};

const pull = (r: StandInRequest) => Number(r.params["n"]);

/** The driver's GitHub controls: it reviews, comments, reports checks and merges as the humans of the team. */
function githubControls({ github }: World): Route[] {
  return [
    {
      method: "POST",
      path: "/_test/pulls/:n/review",
      handler: async (r) => {
        const event = REVIEW_EVENTS[r.json.state as string];
        if (!event) {
          return {
            status: 400,
            body: { message: "state: approved, changes_requested or commented" },
          };
        }

        await github.review(
          pull(r),
          r.json.actor ?? "grace-lead",
          event,
          r.json.body ?? "",
          r.json.comments,
        );

        return ok();
      },
    },
    {
      method: "POST",
      path: "/_test/pulls/:n/comment",
      handler: async (r) => {
        await github.comment(pull(r), r.json.actor ?? "grace-lead", r.json.body ?? "");
        return ok();
      },
    },
    {
      method: "POST",
      path: "/_test/pulls/:n/check",
      handler: async (r) => {
        await github.setCheck(pull(r), r.json.name, r.json.conclusion);
        return ok();
      },
    },
    {
      method: "POST",
      path: "/_test/pulls/:n/merge",
      handler: async (r) => {
        await github.merge(pull(r), "grace-lead");
        return ok();
      },
    },
  ];
}

/** The driver's tracker controls: it creates, assigns and comments on tickets and comments on documents. */
function trackerControls({ tracker }: World): Route[] {
  return [
    {
      method: "POST",
      path: "/_test/tickets",
      handler: (r) => ({
        key: tracker.createTicket(
          r.json.title,
          r.json.description ?? "",
          r.json.status ?? "Ready",
          r.json.assignee,
          r.json.as,
        ),
      }),
    },
    {
      method: "POST",
      path: "/_test/tickets/:key/assign",
      handler: (r) => {
        tracker.assignTicket(r.params["key"]!, r.json.to);
        return ok();
      },
    },
    {
      method: "POST",
      path: "/_test/tickets/:key/comment",
      handler: (r) => {
        tracker.commentTicket(r.params["key"]!, r.json.body);
        return ok();
      },
    },
    {
      // A person comments on a document of the knowledge base, anchored to `quote`, or replies to `parentId`.
      method: "POST",
      path: "/_test/docs/:id/comments",
      handler: (r) => ({
        id: tracker.commentDoc(r.params["id"]!, r.json.body, r.json.quote ?? "", r.json.parentId),
      }),
    },
  ];
}

/** `/_test/*`, the driver's control surface: the state it checks, and what it does as the humans of the acme team. */
export function controlRoutes(world: World): Route[] {
  const { repo, github, tracker, chat } = world;
  return [
    { method: "GET", path: "/_test/healthz", handler: () => ok() },
    {
      method: "GET",
      path: "/_test/state",
      handler: async () => ({
        github: await github.state(),
        tickets: tracker.state(),
        docs: tracker.docs(),
        chat: chat.state(),
        attachmentsServed: tracker.served(),
      }),
    },
    {
      // A person edits a file on main, for example the contribution rules.
      method: "POST",
      path: "/_test/repo/file",
      handler: async (r) => {
        await repo.commitFile("main", r.json.path, r.json.text, r.json.message ?? "Update");
        return ok();
      },
    },
    ...githubControls(world),
    ...trackerControls(world),
  ];
}

/**
 * Two services of the team reached by `ost http`: a hub with no authentication and a home service with a bearer
 * token. Both are served by this process under their own host names; every request is recorded.
 */
export function serviceRoutes(homeToken: string): Route[] {
  const hits: { host: string; path: string; authorized: boolean }[] = [];
  const host = (r: StandInRequest) => r.headers.get("host") ?? "";
  return [
    { method: "GET", path: "/_test/service-hits", handler: () => hits },
    {
      method: "GET",
      path: "/hub/status",
      handler: (r) => {
        hits.push({ host: host(r), path: r.path, authorized: false });
        return { devices: 2 };
      },
    },
    {
      method: "GET",
      path: "/hub/secure",
      handler: (r) => {
        const given = r.headers.get("authorization");
        const authorized = given === `Bearer ${homeToken}`;
        hits.push({ host: host(r), path: r.path, authorized });
        // The body repeats the credential it was given, so the test can see the agent never gets it back.
        return authorized
          ? { status: 200, body: { lights: "on", seen: given } }
          : { status: 401, body: { error: "unauthorized" } };
      },
    },
  ];
}

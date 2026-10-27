import { PortError, maskSecrets, type Check, type Vcs } from "@outstaff/core";
import { failedStepNames, failedSteps } from "../check-log.js";
import { actionsJobId, checkRunStatus, checkSummary, commitStatusState } from "../mapping.js";
import type { RequiredChecksData, RestCheckRun } from "../api.types.js";
import { repoPath } from "./context.js";
import type { GithubContext } from "./types.js";

/** Reading job logs needs Actions: read; requested when the installation has it, like Workflows. */
const LOG_PERMISSIONS = { contents: "read" } as const;
const OPTIONAL_LOGS = { actions: "read" } as const;
const DEFAULT_TAIL = 200;

const REQUIRED_CHECKS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{__typename ... on CheckRun{name status conclusion detailsUrl isRequired(pullRequestNumber:$number)} ... on StatusContext{context state targetUrl isRequired(pullRequestNumber:$number)}}}}}}}}}}`;
const REQUIRED_CHECK_PAGES = 5;

/** CI checks on a commit, the logs of failed jobs, and the checks a pull request requires. */
export function checkOperations(
  c: GithubContext,
): Pick<Vcs, "checks" | "checkLog" | "requiredChecks"> {
  const { http, secrets, self, links, apiToken, actingToken } = c;
  return {
    async checks(repo, sha) {
      const token = await apiToken(repo);
      const runs = await http.paginate<{ check_runs: RestCheckRun[] }, RestCheckRun>(
        `${repoPath(repo)}/commits/${sha}/check-runs`,
        { token, query: { per_page: 100 } },
        (d) => d.check_runs,
      );

      const status = await http.request<{
        statuses: { context: string; state: string; target_url: string | null }[];
      }>("GET", `${repoPath(repo)}/commits/${sha}/status`, { token, query: { per_page: 100 } });

      const fallback = links.commit(repo, sha);
      const out: Check[] = runs.map((r) => ({
        name: r.name,
        status: checkRunStatus(r),
        url: r.html_url ?? r.details_url ?? fallback,
        ...(checkSummary(r) ? { summary: checkSummary(r)! } : {}),
        ...(actionsJobId(r) ? { logId: actionsJobId(r)! } : {}),
      }));

      for (const s of status.data.statuses) {
        out.push({
          name: s.context,
          status: commitStatusState(s.state),
          url: s.target_url ?? fallback,
        });
      }

      return out;
    },

    async checkLog(repo, logId, opts = {}) {
      if (!/^\d+$/.test(logId)) {
        throw new PortError("not_found", `"${logId}" is not a GitHub Actions job id.`);
      }

      const { token } = await actingToken(repo, "read", LOG_PERMISSIONS, OPTIONAL_LOGS);
      const jobPath = `${repoPath(repo)}/actions/jobs/${logId}`;
      let text: string;
      let steps: { name: string; conclusion: string | null }[];
      try {
        steps =
          (
            await http.request<{ steps?: { name: string; conclusion: string | null }[] }>(
              "GET",
              jobPath,
              { token },
            )
          ).data.steps ?? [];

        text = await http.getRedirected(`${jobPath}/logs`, token);
      } catch (e) {
        if (e instanceof PortError && e.code === "forbidden") {
          throw new PortError(
            "forbidden",
            `GitHub refused the logs of job ${logId}: ${self}'s GitHub App needs the Actions: read permission on the installation (run \`ost doctor\`). ${e.message}`,
            { cause: e },
          );
        }

        throw e;
      }

      const known = [
        token,
        ...["GH_APP_", "GH_OFFICE_APP_"].map((p) => secrets.get(`${p}PRIVATE_KEY`) ?? ""),
      ];

      const masked = (line: string) => maskSecrets(line, known);

      return {
        failedSteps: failedSteps(text, failedStepNames(steps), opts.tail ?? DEFAULT_TAIL).map(
          (s) => ({
            ...s,
            lines: s.lines.map(masked),
          }),
        ),
      };
    },

    async requiredChecks(repo, number) {
      const token = await apiToken(repo);
      const fallback = links.pr(repo, number);
      const out: Check[] = [];
      let after: string | null = null;
      for (let page = 0; page < REQUIRED_CHECK_PAGES; page++) {
        const data: RequiredChecksData = await http.graphql<RequiredChecksData>(
          token,
          REQUIRED_CHECKS_QUERY,
          { owner: repo.owner, name: repo.name, number, after },
        );

        const pr = data.repository?.pullRequest;
        if (!pr) {
          throw new PortError(
            "not_found",
            `Pull request ${repo.owner}/${repo.name}#${number} not found.`,
          );
        }

        const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
        for (const c of contexts?.nodes ?? []) {
          if (!c.isRequired) {
            continue;
          }

          out.push(
            c.__typename === "CheckRun"
              ? {
                  name: c.name,
                  status: checkRunStatus({
                    name: c.name,
                    status: c.status.toLowerCase(),
                    conclusion: c.conclusion?.toLowerCase() ?? null,
                  }),
                  url: c.detailsUrl ?? fallback,
                }
              : {
                  name: c.context,
                  status: commitStatusState(c.state.toLowerCase()),
                  url: c.targetUrl ?? fallback,
                },
          );
        }

        if (!contexts?.pageInfo.hasNextPage) {
          break;
        }

        after = contexts.pageInfo.endCursor;
      }

      return out;
    },
  };
}

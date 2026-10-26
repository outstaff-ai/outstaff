import type { Vcs } from "../ports/index.js";
import type { VcsSeed } from "./seeds.js";
import { contractSuite, requireSeed } from "./harness.js";
import type { ContractSetupFn } from "./types.js";
import { vcsCallerCases } from "./vcs-caller.js";
import { vcsConversationCases } from "./vcs-conversation.js";
import { vcsMergingCases } from "./vcs-merging.js";
import { vcsPullRequestCases } from "./vcs-pull-requests.js";

export function vcsContract(name: string, setup: ContractSetupFn<Vcs, VcsSeed>): void {
  contractSuite(`vcs contract: ${name}`, setup, (get) => {
    const repoOf = (t: Parameters<typeof requireSeed>[0], s: ReturnType<typeof get>) => {
      const repo = s.seed.repo;
      if (!repo) {
        t.skip("seed.repo not provided");
      }

      return repo!;
    };

    vcsPullRequestCases({ get, repoOf });
    vcsCallerCases({ get, repoOf });
    vcsMergingCases({ get, repoOf });
    vcsConversationCases({ get, repoOf });
  });
}

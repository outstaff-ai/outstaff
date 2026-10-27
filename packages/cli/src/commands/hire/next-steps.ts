import { composeSnippet, k8sKustomization } from "#/hire-snippets.js";

/** What is left to do by hand after `ost hire`. */
export function nextStepsOf(handle: string, keys: string[]) {
  return {
    identities: [
      "identities.vcs: the login of the person's GitHub App bot, for example <app-slug>[bot]",
      "identities.chat: the Slack bot user id",
      "identities.tracker: the person's member in the tracker",
    ],
    compose: composeSnippet(handle, keys),
    k8s: {
      folder: `people/${handle}/kustomization.yaml`,
      kustomization: k8sKustomization(handle),
      listIn: `Add "- people/${handle}" to resources in the top kustomization.yaml.`,
    },
    doctor: `ost doctor ${handle}`,
  };
}

export function renderNextSteps(
  nextSteps: ReturnType<typeof nextStepsOf>,
  name: string,
  handle: string,
): string {
  return [
    "Next steps",
    "",
    `1. Create the person's accounts and apps with the guide above, then fill the identities of ${handle} in the team file:`,
    ...nextSteps.identities.map((l) => `     ${l}`),
    `2. Compose: add this to your compose file. The secret names are those of the acme example's adapters (github, slack, itsaplan, claude-agent-sdk); the list comes from \`ost setup ${handle}\`, so check it against the .env.example it wrote.`,
    "",
    ...nextSteps.compose.split("\n").map((l) => `     ${l}`),
    "",
    `   Kubernetes: add ${nextSteps.k8s.folder}, and list it in the top kustomization.yaml. Create the Secret outstaff-agent-${handle} from the same keys, and add OUTSTAFF_AGENT_TOKEN_${handle.toUpperCase().replaceAll("-", "_")} to outstaff-office.`,
    "",
    ...nextSteps.k8s.kustomization
      .trimEnd()
      .split("\n")
      .map((l) => `     ${l}`),
    "",
    `3. Check it: ost doctor ${handle}`,
    `4. Start the container, and say hello to ${name} in the team's chat channel once ${handle} is connected.`,
    "",
  ].join("\n");
}

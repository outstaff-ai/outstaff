import {
  PortError,
  defineAdapter,
  policyOn,
  type DeriveContext,
  type DoctorCheck,
  type SecretSource,
  type SecretSpec,
  type SetupStep,
} from "@outstaff/core";
import { workdirFiles } from "./layout.js";
import { agentSdkOptions } from "./options.js";
import { createAgentSdkRuntime } from "./runtime.js";
import { probeSubprocessSandbox } from "./sandbox.js";

// The operator supplies credentials to the container; outstaff never reads or stores them (decision 0009).
// None is required by outstaff itself, and exactly one way of signing in has to be present.
const secrets: SecretSpec[] = [
  {
    key: "ANTHROPIC_API_KEY",
    description:
      "Anthropic API key. Use this, a cloud provider or a subscription token; the adapter itself never reads it.",
    optional: true,
    where: "Anthropic Console. Give it to the container as an environment variable or secret file.",
  },
  {
    key: "CLAUDE_CODE_OAUTH_TOKEN",
    description:
      "Long-lived subscription token for this container. Use it within the provider's terms.",
    optional: true,
    where: "Run `claude setup-token` on a machine signed in to your own subscription.",
  },
];

const setupGuide = (ctx: { scope: "person" | "office" }): SetupStep[] =>
  ctx.scope === "office"
    ? []
    : [
        {
          title: "Choose how this agent signs in to Claude",
          body: [
            "Outstaff never asks for, stores or brokers model credentials. Supply exactly one of these to the agent container:",
            "",
            "- **API key**: create it in the Anthropic Console and keep it as `ANTHROPIC_API_KEY`.",
            "- **Cloud provider**: Amazon Bedrock, Google Vertex AI or Microsoft Foundry. Set the provider's switch and region as plain environment variables (for example `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`) and give its credentials as secret files.",
            "- **Your own subscription token**: run `claude setup-token` on a machine signed in to your subscription and keep the result as `CLAUDE_CODE_OAUTH_TOKEN`. Use it only within the provider's terms (https://www.anthropic.com/legal/consumer-terms and https://www.anthropic.com/legal/commercial-terms); a subscription is meant for its owner, not for a fleet of agents.",
            "",
            "Commands the agent runs can read this credential unless the runtime's `sandbox` option is `bubblewrap`, so use a dedicated key with a spend limit and rotate it if it leaks.",
          ].join("\n"),
        },
      ];

const SIGN_IN = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
const PROVIDER_SWITCHES = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

// No network call: the runtime reads none of these, and a provider switch is only a flag.
function credentialCheck(secrets: SecretSource): DoctorCheck {
  const found = [...SIGN_IN, ...PROVIDER_SWITCHES].filter((k) => secrets.get(k));
  if (found.length > 0) {
    return {
      key: found[0]!,
      name: "Claude credential",
      status: "ok",
      detail: `${found.join(", ")} ${found.length === 1 ? "is" : "are"} set.`,
    };
  }

  return {
    name: "Claude credential",
    status: "fail",
    detail: `None of ${SIGN_IN.join(", ")} or a cloud provider switch (${PROVIDER_SWITCHES.join(", ")}) is set.`,
    fix: "Supply one of them to the agent container; see the setup guide for the options.",
  };
}

// Claude Code serves the Artifact tool to a Claude account login only: not to an API key or a cloud provider. The check
// reads which credential is set; it cannot tell whether the account's plan or organisation allows artifacts.
function canvasCheck(secrets: SecretSource, ctx: DeriveContext): DoctorCheck[] {
  if (
    !ctx.roleCapabilities?.includes("design.canvas") ||
    !policyOn(ctx.team.policies, "design.canvas")
  ) {
    return [];
  }

  const name = "Design canvas";
  if (secrets.get("CLAUDE_CODE_OAUTH_TOKEN")) {
    return [
      {
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        name,
        status: "ok",
        detail:
          "CLAUDE_CODE_OAUTH_TOKEN is set, a Claude account login. Canvases belong to that account.",
      },
    ];
  }

  const other = [...SIGN_IN, ...PROVIDER_SWITCHES].filter(
    (k) => k !== "CLAUDE_CODE_OAUTH_TOKEN" && secrets.get(k),
  );

  return [
    {
      name,
      status: "warn",
      detail: `The role uses the Design canvas, which needs a Claude account login, but ${other.length > 0 ? `only ${other.join(", ")} ${other.length === 1 ? "is" : "are"} set` : "no Claude credential is set"}. Without it the agent has no Artifact tools.`,
      fix: "Give this agent CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token` on a machine signed in to a Claude Pro, Max, Team or Enterprise account), or set policies.design.canvas to false.",
    },
  ];
}

// With sandbox: bubblewrap only, and only on Linux, where the agent runs: run `ost doctor <handle>` in its container.
function sandboxCheck(options: unknown): DoctorCheck[] {
  const parsed = agentSdkOptions.safeParse(options ?? {});
  if (!parsed.success || parsed.data.sandbox !== "bubblewrap" || process.platform !== "linux") {
    return [];
  }

  const probe = probeSubprocessSandbox();
  return [
    {
      name: "Subprocess sandbox",
      status: probe.ok ? "ok" : "fail",
      detail: probe.detail,
      ...(probe.fix ? { fix: probe.fix } : {}),
    },
  ];
}

async function doctor(secrets: SecretSource, ctx: DeriveContext): Promise<DoctorCheck[]> {
  if (ctx.scope === "office") {
    return [];
  }

  return [credentialCheck(secrets), ...canvasCheck(secrets, ctx), ...sandboxCheck(ctx.options)];
}

/** With sandbox: bubblewrap, stops the agent at start, once, when the sandbox cannot run; Claude Code would fail every command instead. */
function requireSandbox(): void {
  const probe = probeSubprocessSandbox();
  if (!probe.ok) {
    throw new PortError(
      "unavailable",
      `sandbox: bubblewrap cannot run in this container. ${probe.detail} Fix: ${probe.fix}`,
    );
  }
}

export const claudeAgentSdk = defineAdapter({
  port: "runtime",
  name: "claude-agent-sdk",
  capabilities: ["runtime.sessions", "runtime.usage", "design.canvas"],
  options: agentSdkOptions,
  secrets: () => secrets,
  setupGuide,
  doctor,
  workdirLayout: workdirFiles,
  create: (ctx) => {
    if (ctx.options.sandbox === "bubblewrap") {
      requireSandbox();
    }

    return createAgentSdkRuntime({
      options: ctx.options,
      log: ctx.log,
      secrets: ctx.secrets,
      scrubKeys: ctx.secretKeys ?? secrets.map((s) => s.key),
    });
  },
});

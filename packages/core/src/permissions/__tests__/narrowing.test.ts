import { describe, expect, it } from "vitest";
import {
  buildPolicy,
  effectiveTools,
  evaluate,
  loadToolset,
  toolsToPacks,
  type Layout,
  type RulePack,
  type ToolCall,
  type Tools,
} from "#/index.js";

const layout: Layout = {
  home: "/home/agent",
  workDir: "/work/main",
  reposDir: "/work/repos",
  worktreesDir: "/work/worktrees",
  scratchDir: "/work/scratch",
  memoryDir: "/work/memory",
  secretsDir: "/work/secrets",
};

const team = {
  repos: [
    { name: "app", url: "github.com/acme/app", kind: "primary" as const, default_branch: "main" },
  ],
};

const person = { repos: { app: "write" } as const };

const infraFile = new URL("../../../../catalog/toolsets/infra.yaml", import.meta.url).pathname;
const infra = toolsToPacks(effectiveTools({ toolsets: [loadToolset(infraFile)] }));

const judge = (packs: RulePack[], command: string) => {
  const call: ToolCall = { kind: "shell", command, cwd: "/work/worktrees/app/feat" };
  return evaluate(buildPolicy({ profile: "infra", person, team, layout, packs }), call);
};

const run = (command: string) => judge(infra, command);
const runWith = (team: Tools, command: string) =>
  judge(toolsToPacks(effectiveTools({ team })), command);

const effects = (commands: string[]) =>
  commands.map((command) => `${command}: ${run(command).effect}`);

describe("kubectl in the infra toolset", () => {
  // The commands of a devops session the policy refused although the toolset means to allow them.
  const JSONPATH = `kubectl -n ops get deploy op -o jsonpath='{.spec.template.spec.containers[0].image}{"\\n"}'`;

  it("runs the read-only commands of the session", () => {
    const commands = [
      "kubectl version -o json",
      "kubectl get nodes -o wide",
      "kubectl get deploy -n ops -o wide",
      JSONPATH,
      `${JSONPATH}; kubectl get crd x -o yaml | grep version`,
    ];

    expect(effects(commands)).toEqual(commands.map((c) => `${c}: allow`));
  });

  it("finds the subcommand after kubectl's global options", () => {
    const commands = [
      "kubectl -n ops get deploy op",
      "kubectl --namespace ops get pods",
      "kubectl --context acme-prod -n ops logs deploy/op",
      "kubectl --insecure-skip-tls-verify get pods",
      "kubectl -v 6 describe pod x",
      "kubectl --context=acme-prod get pods",
    ];

    expect(effects(commands)).toEqual(commands.map((c) => `${c}: allow`));
  });

  it("runs the other read-only verbs", () => {
    const commands = [
      "kubectl api-resources",
      "kubectl api-versions",
      "kubectl explain deployment.spec",
      "kubectl auth can-i list pods -n ops",
      "kubectl diff -f deploy.yaml",
    ];

    expect(effects(commands)).toEqual(commands.map((c) => `${c}: allow`));
    expect(run("kubectl auth can-i get pods").rule).toBe("tools.kubectl.auth.can-i");
  });

  it("refuses the write verbs", () => {
    const commands = [
      "kubectl apply -f x.yaml",
      "kubectl delete pod x",
      "kubectl edit deploy op",
      "kubectl patch deploy op -p '{}'",
      "kubectl exec -it pod -- sh",
      "kubectl port-forward svc/op 8080:80",
      "kubectl cp pod:/etc/x ./x",
      "kubectl scale deploy op --replicas 0",
      "kubectl rollout restart deploy/op",
      "kubectl auth reconcile -f rbac.yaml",
      "kubectl -n ops delete pod x",
      "kubectl --context acme-prod apply -f x.yaml",
    ];

    expect(effects(commands)).toEqual(commands.map((c) => `${c}: deny`));
  });

  it("refuses a write verb hidden in a compound command, a subshell or a substitution", () => {
    const commands = [
      "kubectl get pods; kubectl delete pod x",
      "kubectl get pods && kubectl apply -f x.yaml",
      "kubectl get pods || kubectl edit deploy op",
      "kubectl get deploy op -o yaml | kubectl apply -f -",
      `${JSONPATH}; kubectl delete crd x`,
      "(kubectl patch deploy op -p '{}')",
      "{ kubectl get pods; kubectl delete pod x; }",
      "echo $(kubectl exec pod -- cat /etc/passwd)",
      "echo `kubectl delete pod x`",
      "bash -c 'kubectl get pods && kubectl delete pod x'",
      "kubectl get pods -o name | xargs kubectl delete",
      "env KUBECONFIG=x kubectl port-forward svc/op 8080:80",
      "timeout 5 kubectl cp pod:/x ./x",
    ];

    expect(effects(commands)).toEqual(commands.map((c) => `${c}: deny`));
  });

  it("does not take a write verb for an option's value", () => {
    // kubectl reads `get` as the namespace here, and runs delete.
    expect(run("kubectl -n get delete pod x").effect).toBe("deny");
    expect(run("kubectl --context get delete pod x").effect).toBe("deny");
  });

  it("names the refused command and what kubectl allows", () => {
    const allowed =
      "get, describe, logs, diff, version, api-resources, api-versions, explain, auth can-i";

    expect(run("kubectl delete pod x")).toMatchObject({
      effect: "deny",
      rule: "commands.narrowed",
      reason: `kubectl delete is refused: kubectl here allows ${allowed}.`,
    });

    expect(run("kubectl auth reconcile -f x.yaml").reason).toBe(
      `kubectl auth reconcile is refused: kubectl here allows ${allowed}.`,
    );

    expect(run("kubectl").reason).toBe(
      `kubectl without a subcommand is refused: kubectl here allows ${allowed}.`,
    );
  });
});

describe("narrowed tools after options they do not declare", () => {
  const acme = (extra: object = {}): Tools => ({
    acmectl: { version: "1.0.0", allow: ["status"], ...extra },
  });

  it("allows only when every reading of the command is allowed", () => {
    expect(runWith(acme(), "acmectl status").effect).toBe("allow");
    expect(runWith(acme(), "acmectl --verbose status").effect).toBe("allow");
    expect(runWith(acme(), "acmectl -c prod status").effect).toBe("deny");
    expect(runWith(acme(), "acmectl -c status deploy").effect).toBe("deny");
  });

  it("says how to make an ambiguous command readable", () => {
    expect(runWith(acme(), "acmectl -c status deploy").reason).toBe(
      "acmectl deploy is refused: acmectl here allows status. An option before the subcommand may take the next word as its value: write it as --option=value, or after the subcommand.",
    );

    expect(runWith(acme(), "acmectl -c=prod status").effect).toBe("allow");
  });

  it("reads a tool that declares valued_options exactly", () => {
    const declared = acme({ valued_options: ["-c"] });
    expect(runWith(declared, "acmectl -c prod status").effect).toBe("allow");
    expect(runWith(declared, "acmectl --verbose status x").effect).toBe("allow");
    expect(runWith(declared, "acmectl -c prod deploy").effect).toBe("deny");
  });

  it("says when the subcommand is allowed but not with these arguments", () => {
    const tools: Tools = {
      acmectl: {
        version: "1.0.0",
        allow: [
          {
            subcommand: ["deploy"],
            reason: "Dry runs only.",
            args: [{ kind: "flag", names: ["--dry-run"], present: true }],
          },
          { reason: "Any help.", args: [{ kind: "flag", names: ["--help"], present: true }] },
        ],
      },
    };

    expect(runWith(tools, "acmectl deploy --dry-run").effect).toBe("allow");
    expect(runWith(tools, "acmectl deploy").reason).toBe(
      "acmectl deploy is refused with these arguments: acmectl here allows deploy, the commands its rules match.",
    );
  });
});

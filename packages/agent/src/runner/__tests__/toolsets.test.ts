import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPolicy,
  effectiveTools,
  evaluate,
  loadCatalog,
  toolsetToPack,
  toolsToPacks,
  type Layout,
} from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { loadToolsets } from "#/runner/catalogs.js";

const stockCatalogDir = fileURLToPath(new URL("../../../../catalog", import.meta.url));
const stock = loadCatalog(stockCatalogDir);

const names = (role: string) =>
  loadToolsets([stockCatalogDir], stock.roles[role]!.permissions).map((t) => t.name);

describe("the toolsets of a role", () => {
  it.each([
    ["architect", ["code"]],
    ["designer", ["base"]],
    ["developer", ["code"]],
    ["devops", ["code", "infra"]],
    ["pm", ["base"]],
    ["product", ["base"]],
    ["reviewer", ["base"]],
  ])("gives %s every stock toolset of its permission profile: %j", (role, expected) => {
    expect(names(role)).toEqual(expected);
  });

  it("gives devops the code toolchains as well as the infra CLIs", () => {
    const toolsets = loadToolsets([stockCatalogDir], "infra");
    expect(effectiveTools({ toolsets }).map((t) => t.name)).toEqual([
      "go",
      "helm",
      "kubectl",
      "pnpm",
      "python",
      "terraform",
      "yarn",
    ]);
  });

  it("takes an ejected toolset over the stock one of the same name, and adds the team's own", () => {
    const ejected = mkdtempSync(join(tmpdir(), "ost-toolsets-"));
    mkdirSync(join(ejected, "toolsets"));
    writeFileSync(
      join(ejected, "toolsets", "code.yaml"),
      "name: code\nprofiles: [code]\ntools:\n  pnpm: { version: 12.9.1 }\n",
    );

    writeFileSync(
      join(ejected, "toolsets", "data.yml"),
      "name: data\nprofiles: [infra]\ntools:\n  duckdb: { version: 1.1.3 }\n",
    );

    expect(loadToolsets([stockCatalogDir, ejected], "infra").map((t) => t.name)).toEqual([
      "data",
      "infra",
    ]);

    expect(loadToolsets([stockCatalogDir, ejected, undefined], "code")).toEqual([
      { name: "code", profiles: ["code"], tools: { pnpm: { version: "12.9.1" } } },
    ]);

    expect(loadToolsets([join(ejected, "missing")], "code")).toEqual([]);
  });

  it("gives a toolset that names no profiles to every role", () => {
    const dir = mkdtempSync(join(tmpdir(), "ost-toolsets-"));
    mkdirSync(join(dir, "toolsets"));
    writeFileSync(
      join(dir, "toolsets", "all.yaml"),
      "name: all\ntools:\n  jq: { version: 1.7.1 }\n",
    );

    expect(loadToolsets([dir], "readonly").map((t) => t.name)).toEqual(["all"]);
    expect(loadToolsets([dir], "infra").map((t) => t.name)).toEqual(["all"]);
  });

  it("refuses a toolset whose name is not its file name", () => {
    const dir = mkdtempSync(join(tmpdir(), "ost-toolsets-"));
    mkdirSync(join(dir, "toolsets"));
    writeFileSync(
      join(dir, "toolsets", "gpu.yaml"),
      "name: cuda\ntools:\n  nvcc: { version: 12.6.2 }\n",
    );

    expect(() => loadToolsets([dir], "code")).toThrow(/is named "cuda"; name it "gpu"/);
  });
});

describe("the devops policy", () => {
  const layout: Layout = {
    home: "/home/agent",
    workDir: "/work/main",
    reposDir: "/work/repos",
    worktreesDir: "/work/worktrees",
    scratchDir: "/work/scratch",
    memoryDir: "/work/memory",
    secretsDir: "/work/secrets",
  };

  const toolsets = loadToolsets([stockCatalogDir], "infra");
  const policy = buildPolicy({
    profile: "infra",
    person: { repos: { ops: "write" } },
    team: {
      repos: [{ name: "ops", url: "github.com/acme/ops", kind: "infra", default_branch: "main" }],
    },
    layout,
    packs: [...toolsets.map(toolsetToPack), ...toolsToPacks(effectiveTools({ toolsets }))],
  });

  const run = (command: string) =>
    evaluate(policy, { kind: "shell", command, cwd: "/work/worktrees/ops/feat" }).effect;

  it.each([
    "pnpm install --frozen-lockfile",
    "pnpm test",
    "pnpm typecheck",
    "pnpm lint",
    "pnpm --filter infra run test",
    "curl -fsS https://registry.npmjs.org/",
    "kubectl get pods",
    "helm lint chart",
  ])("lets devops run %s", (command) => {
    expect(run(command)).toBe("allow");
  });

  it.each(["kubectl apply -f deploy.yaml", "helm install acme chart", "terraform apply"])(
    "keeps the infra CLIs read-only: %s is denied",
    (command) => {
      expect(run(command)).toBe("deny");
    },
  );
});

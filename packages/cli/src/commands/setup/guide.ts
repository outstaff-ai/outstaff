import type { SetupStep } from "@outstaff/core";

export function renderGuide(title: string, steps: SetupStep[]): string {
  const lines = [`## ${title}`, ""];
  steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${step.title}`, "");
    lines.push(...step.body.split("\n").map((l) => (l ? `   ${l}` : l)), "");
    if (step.manifest) {
      lines.push(
        "   Paste or follow:",
        "",
        "   ```",
        ...step.manifest
          .trimEnd()
          .split("\n")
          .map((l) => `   ${l}`),
        "   ```",
        "",
      );
    }
  });

  return lines.join("\n");
}

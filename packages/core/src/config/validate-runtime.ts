import { CAPABILITY_PORT } from "#/capabilities.js";
import { capabilityOn } from "#/policies/capability-on.js";
import type { Capability } from "#/types.js";
import { CONFIG_CODES } from "./codes.js";
import { LACKING } from "./lacking.js";
import { runtimeOf } from "./runtime-of.js";
import type { AdapterInfo, TeamConfig, ValidationContext, ValidationReport } from "./types.js";
import { WARNING_CODES } from "./warning-codes.js";

type Person = TeamConfig["people"][number];

/** What one person's check needs to know about them and their runtime. */
interface Subject {
  config: TeamConfig;
  ctx: ValidationContext;
  person: Person;
  index: number;
  adapter: string;
  provided: ReadonlySet<Capability>;
}

const pathOf = (s: Subject) =>
  s.person.runtime ? ["people", s.index, "runtime"] : ["people", s.index, "role"];

/** Every agent runs under its permission policy, so its runtime must compile and enforce one. */
function permissionIssues(s: Subject, report: ValidationReport): void {
  if (s.provided.has("runtime.permissions")) {
    return;
  }

  report.errors.push({
    path: pathOf(s),
    code: CONFIG_CODES.peopleRuntimeMissingCapability,
    message: `${s.person.handle} runs on runtime "${s.adapter}", which does not provide runtime.permissions: it cannot ${LACKING["runtime.permissions"]}.`,
  });
}

/** The runtime capabilities the person's roles name, needed ones first, each with the role that names it. */
function wantedCapabilities(s: Subject): [string, Capability, boolean][] {
  const roles = [s.person.role, ...(s.person.extends ?? [])];
  const list = (optional: boolean) =>
    roles.flatMap((name) => {
      const needs = s.ctx.roles.get(name);
      const caps = (optional ? needs?.optionalNeeds : needs?.needs) ?? [];
      return caps.map((cap): [string, Capability, boolean] => [name, cap, optional]);
    });

  return [...list(false), ...list(true)].filter(([, cap]) => CAPABILITY_PORT[cap] === "runtime");
}

/** Runtime capabilities the person's roles need (errors) or can use (warnings), once each. */
function roleIssues(s: Subject, report: ValidationReport): void {
  const seen = new Set<Capability>();
  for (const [roleName, cap, optional] of wantedCapabilities(s)) {
    if (s.provided.has(cap) || seen.has(cap)) {
      continue;
    }

    seen.add(cap);
    lacking(s, report, roleName, cap, optional);
  }
}

function lacking(
  s: Subject,
  report: ValidationReport,
  roleName: string,
  cap: Capability,
  optional: boolean,
): void {
  const { handle } = s.person;
  const message = `Role "${roleName}" ${optional ? "can use" : "needs"} ${cap}, which runtime "${s.adapter}" of ${handle} does not provide.`;
  if (!optional) {
    report.errors.push({
      path: pathOf(s),
      code: CONFIG_CODES.peopleRuntimeMissingCapability,
      message,
    });

    return;
  }

  // A capability the team switched off is nothing a runtime has to provide.
  if (capabilityOn(s.config.policies, cap)) {
    report.warnings.push({
      path: pathOf(s),
      code: WARNING_CODES.capabilityOptionalMissing,
      message,
      consequence: `${roleName} ${handle} cannot ${LACKING[cap]}: give ${handle} a runtime that provides ${cap}.`,
    });
  }
}

/** The usage policy works on the windows a runtime reports; without them it is skipped for the person. */
function usageIssues(s: Subject, report: ValidationReport): void {
  if (s.provided.has("runtime.usage")) {
    return;
  }

  const { handle } = s.person;
  report.warnings.push({
    path: pathOf(s),
    code: WARNING_CODES.peopleRuntimeWithoutUsage,
    message: `${handle} runs on runtime "${s.adapter}", which reports no usage windows.`,
    consequence: `policies.usage is not applied to ${handle}: their work is not deferred or paused near a usage limit.`,
  });
}

function unknownRuntime(s: Omit<Subject, "provided">, report: ValidationReport): void {
  // Like integrations.*: adapter names are checked only when the host knows its adapters.
  if (s.person.runtime && s.ctx.adapters.size > 0) {
    report.errors.push({
      path: ["people", s.index, "runtime", "adapter"],
      code: CONFIG_CODES.integrationsUnknownAdapter,
      message: `No runtime adapter named "${s.adapter}" is installed for ${s.person.handle}.`,
    });
  }
}

/**
 * Checks each person against the runtime they run on (their own `runtime` or the team's): the permission policy, the
 * runtime capabilities their roles need, and usage windows. A runtime the host does not know is not checked.
 */
export function runtimeReport(config: TeamConfig, ctx: ValidationContext): ValidationReport {
  const report: ValidationReport = { errors: [], warnings: [] };
  const known: Map<string, AdapterInfo> = ctx.adapterCapabilities ?? ctx.adapters;
  config.people.forEach((person, index) => {
    const adapter = runtimeOf(config, person).adapter;
    const info = known.get(`runtime/${adapter}`);
    const base = { config, ctx, person, index, adapter };
    if (!info) {
      unknownRuntime(base, report);
      return;
    }

    const subject: Subject = { ...base, provided: new Set(info.capabilities) };
    permissionIssues(subject, report);
    roleIssues(subject, report);
    usageIssues(subject, report);
  });

  return report;
}

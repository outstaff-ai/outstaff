import { silentLogger, type DoctorCheck, type Logger } from "@outstaff/core";
import type { PreparedAgent } from "#/runner/startup.types.js";
import { diskCheck } from "./disk.js";
import { networkChecks } from "./network.js";
import { toolStatusChecks } from "./tools.js";
import type { DoctorReporter, StartupChecksInput } from "./types.js";

/** What only the agent's own container can tell: its tools installed, its services and devices answer, its disk. */
export async function startupChecks(input: StartupChecksInput): Promise<DoctorCheck[]> {
  return [
    ...toolStatusChecks(input.tools),
    ...(await networkChecks(input, input.team, input.person, true)),
    await diskCheck(input.home, input.volume),
  ];
}

/** Runs the startup checks and reports them to the office. Never throws: a failure is only logged. */
export async function reportStartupChecks(
  input: StartupChecksInput,
  report: DoctorReporter,
  log: Logger = silentLogger,
): Promise<void> {
  try {
    const checks = await startupChecks(input);
    for (const c of checks.filter((c) => c.status !== "ok")) {
      log.warn(`doctor: ${c.name}`, { status: c.status, detail: c.detail });
    }

    await report(checks);
  } catch (e) {
    log.warn("could not report the startup checks to the office", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** A started agent's report: its checks, sent once it is connected. Never throws. */
export function reportAgentChecks(
  agent: Pick<PreparedAgent, "team" | "person" | "tools" | "connection">,
  env: NodeJS.ProcessEnv,
  home: string,
  log?: Logger,
): Promise<void> {
  const person = agent.team.people.find((p) => p.handle === agent.person)!;
  return reportStartupChecks(
    { env, home, team: agent.team, person, tools: agent.tools },
    (checks) => agent.connection.doctorReport(checks),
    log,
  );
}

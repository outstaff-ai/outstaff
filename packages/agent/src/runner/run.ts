import { silentLogger } from "@outstaff/core";
import { reportAgentChecks } from "#/doctor/index.js";
import type { OfficeConnection } from "#/office-client/index.js";
import type { AgentRunner } from "./run.types.js";
import { officeConnection } from "./startup-context.js";
import { prepareAgent } from "./startup.js";
import type { PreparedAgent, StartupOptions } from "./startup.types.js";

/** Stops what a round started; the second call waits for the first. */
function closer(agent: PreparedAgent): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= (async () => {
      agent.usage.stop();
      agent.sweeper.stop();
      await agent.chat?.stop();
      await agent.loop.stop();
      await agent.connection.stop();
    })();

    return closing;
  };
}

/**
 * The agent's life: connect, take the team from the office, prepare, and work until stopped. When a reconnect brings
 * a different team config (the office restarted with a changed team file), the agent takes no new items, lets the
 * running ones finish, and prepares again from the new team, so working files and policy never change under a run.
 * `connect` makes the connection of each round (tests replace it).
 */
export function createAgentRunner(
  opts: StartupOptions,
  connect: () => OfficeConnection = () => officeConnection(opts),
): AgentRunner {
  const log = opts.log ?? silentLogger;
  let stopped = false;
  let connection: OfficeConnection | undefined;
  let close: (() => Promise<void>) | undefined;

  /** One prepared agent, run until it stops; true when the team changed and the agent should prepare again. */
  async function round(): Promise<boolean> {
    connection = connect();
    close = undefined;
    log.info("connecting to the office", { person: opts.env["OUTSTAFF_PERSON"] });
    const agent = await prepareAgent({ ...opts, connection });
    close = closer(agent);
    let changed = false;
    agent.connection.onTeamConfigChange(() => {
      changed = true;
      log.info(
        "the office sent a changed team config; preparing again once the running work is done",
      );

      agent.sweeper.stop();
      void agent.loop.drain();
    });

    log.info("connected");
    agent.usage.start();
    agent.sweeper.start();
    void reportAgentChecks(agent, opts.env, opts.home, log);
    await agent.chat?.start().catch((e: unknown) => {
      log.error("chat requests are off: the chat connection failed", { error: String(e) });
    });

    await agent.loop.run();
    await close();
    return changed && !stopped;
  }

  return {
    async run() {
      try {
        while (await round()) {
          log.info("preparing again from the new team config");
        }
      } catch (e) {
        // Stopping while connecting ends the wait for the office with an error; that is a clean stop.
        if (!stopped) {
          throw e;
        }
      }

      return connection?.rejection() ? 1 : 0;
    },

    stop(signal) {
      if (stopped) {
        return;
      }

      stopped = true;
      log.info("stopping", { signal });
      (close?.() ?? connection?.stop() ?? Promise.resolve()).catch((e: unknown) =>
        log.error("could not stop cleanly", { error: String(e) }),
      );
    },
  };
}

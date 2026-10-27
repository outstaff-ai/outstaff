import type { Logger } from "@outstaff/core";
import type { Human } from "@outstaff/protocol";
import type { OfficePorts } from "./types.js";

/**
 * Without a humans: list the trusted ones are repo writers and chat members, which the ports cannot list; the
 * tracker's human members are the trusted ones intake already accepts.
 */
export const trackerHumans =
  (ports: Pick<OfficePorts, "tracker">, log: Logger) => async (): Promise<Human[]> => {
    try {
      return (
        (await ports.tracker?.members())
          ?.filter((m) => m.kind === "human")
          .map((m) => ({ name: m.name })) ?? []
      );
    } catch (error) {
      log.warn("could not list humans", { error: String(error) });
      return [];
    }
  };

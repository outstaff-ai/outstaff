import {
  PortError,
  type AdapterContext,
  type AdapterRegistry,
  type Chat,
  type Knowledge,
  type Logger,
  type PortName,
  type SecretSource,
  type TeamConfig,
  type Tracker,
  type Vcs,
} from "@outstaff/core";
import { defined } from "./defined.js";
import type { Clock, OfficePorts } from "./types.js";

interface Input {
  team: TeamConfig;
  registry: AdapterRegistry;
  secrets: SecretSource;
  clock: Clock;
  logger: Logger;
}

async function create(port: PortName, input: Input) {
  const ref = (input.team.integrations as Record<string, { adapter: string } | undefined>)[port];
  if (!ref) {
    return undefined;
  }

  const def = input.registry.get(port, ref.adapter);
  if (!def) {
    throw new PortError(
      "invalid",
      `The office needs the ${port} adapter "${ref.adapter}" (integrations.${port}), but it is not installed in this image.`,
    );
  }

  const { adapter: _adapter, ...rest } = ref as Record<string, unknown>;
  const parsed = def.options.safeParse(rest);
  if (!parsed.success) {
    throw new PortError(
      "invalid",
      `integrations.${port} (${ref.adapter}) has invalid options: ${parsed.error.message}`,
    );
  }

  const ctx: AdapterContext<unknown> = {
    options: parsed.data,
    secrets: input.secrets,
    secretKeys: input.registry
      .list()
      .flatMap((d) => [
        ...d.secrets("office").map((s) => s.key),
        ...d.secrets("person").map((s) => s.key),
      ]),
    team: input.team,
    scope: "office",
    log: input.logger,
    fetch,
    now: () => input.clock.now(),
  };

  return def.create(ctx);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The office posts to no person. Its chat app exists only to mirror agent questions to the team channel. */
async function chatPort(input: Input): Promise<Chat | undefined> {
  return input.team.office?.channel
    ? ((await create("chat", input)) as Chat | undefined)
    : undefined;
}

/** The knowledge base; one that cannot start costs the comments on documents and nothing else. */
async function knowledgePort(input: Input): Promise<Knowledge | undefined> {
  try {
    return (await create("knowledge", input)) as Knowledge | undefined;
  } catch (error) {
    input.logger.warn(`the office cannot read comments on documents: ${errorText(error)}`, {
      port: "knowledge",
    });

    return undefined;
  }
}

/**
 * The office-scope ports from team.yaml. Version control is required; the tracker is used when the team configures
 * it, and chat only when `office.channel` names the team channel agent questions are mirrored to. The knowledge base is
 * read for comments on documents; a knowledge adapter this image lacks, or one that fails to start, costs that
 * feedback and nothing else.
 * Runtime and avatars belong to the agents, not the office.
 */
export async function createOfficePorts(input: Input): Promise<OfficePorts> {
  const vcs = (await create("vcs", input)) as Vcs | undefined;
  if (!vcs) {
    throw new PortError("invalid", "The office needs integrations.vcs in team.yaml.");
  }

  const tracker = (await create("tracker", input)) as Tracker | undefined;
  const chat = await chatPort(input);
  const knowledge = await knowledgePort(input);
  return { vcs, ...defined({ tracker, chat, knowledge }) };
}

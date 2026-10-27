import { policyOn } from "@outstaff/core";
import type { OfficeConnection } from "../office-client/index.js";
import { createChatRelay } from "./chat.js";
import type { ChatRelay } from "./chat.types.js";
import { createProfilePublisher } from "./profile.js";
import type { ChatStartOptions, StartedChat } from "./startup.types.js";
import type { ProfilePublisher } from "./types.js";

/** Who the agent is, for the top of its chat profile. */
const profileWho = (
  me: ChatStartOptions["me"],
  role: ChatStartOptions["role"],
  model: string | undefined,
) => ({
  name: me.name,
  role: role?.title ?? me.role,
  ...(role?.summary ? { description: role.summary } : {}),
  ...(model ? { model } : {}),
});

/** The chat profile publisher, when the chat can show one and the team has it on. */
function startProfile(
  connection: OfficeConnection,
  { env, team, me, role, model, log }: ChatStartOptions,
): ProfilePublisher | undefined {
  const chatPort = env.chat;
  if (!chatPort?.setAgentProfile || !policyOn(team.policies, "chat.profile")) {
    return undefined;
  }

  return createProfilePublisher({
    chat: { ...chatPort, setAgentProfile: chatPort.setAgentProfile.bind(chatPort) },
    office: connection,
    team,
    who: profileWho(me, role, model),
    log,
    ...(env.tracker ? { tracker: env.tracker } : {}),
  });
}

/** The chat relay, when the person has a chat; it posts the reports the office queued while the agent was offline. */
function startRelay(
  connection: OfficeConnection,
  { env, team, person, log }: ChatStartOptions,
  profile: ProfilePublisher | undefined,
): ChatRelay | undefined {
  if (!env.chat) {
    if (env.unavailable?.chat) {
      log.warn("chat requests are off", { reason: env.unavailable.chat });
    }

    return undefined;
  }

  const relay = createChatRelay({
    ...(profile ? { profile } : {}),
    chat: env.chat,
    office: connection,
    team,
    person,
    log,
    ...(env.tracker ? { tracker: env.tracker } : {}),
  });

  // Reports the office queued while this agent was offline are posted by the agent when it connects.
  connection.onReports?.((reports) => void relay.postQueued(reports));

  return relay;
}

/** The profile publisher and the chat relay, when the person has a chat. */
export function startChat(connection: OfficeConnection, opts: ChatStartOptions): StartedChat {
  const profile = startProfile(connection, opts);
  const chat = startRelay(connection, opts, profile);

  return { ...(chat ? { chat } : {}), ...(profile ? { profile } : {}) };
}

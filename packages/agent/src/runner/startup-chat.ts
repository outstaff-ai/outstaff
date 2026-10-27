import { policyOn, type TeamConfig, type Logger } from "@outstaff/core";
import type { OfficeConnection } from "../office-client/index.js";
import type { AgentEnv } from "../verbs/types.js";
import { createChatRelay } from "./chat.js";
import type { ChatRelay } from "./chat.types.js";
import { createProfilePublisher } from "./profile.js";
import type { ProfilePublisher } from "./types.js";

/** The profile publisher and the chat relay, when the person has a chat. */
export function startChat(
  connection: OfficeConnection,
  {
    env,
    team,
    me,
    role,
    model,
    person,
    log,
  }: {
    env: AgentEnv;
    team: TeamConfig;
    me: TeamConfig["people"][number];
    role: { title: string; summary?: string | undefined } | undefined;
    model: string | undefined;
    person: string;
    log: Logger;
  },
): { chat?: ChatRelay; profile?: ProfilePublisher } {
  let chat: ChatRelay | undefined;
  let profile: ProfilePublisher | undefined;
  const chatPort = env.chat;
  if (chatPort?.setAgentProfile && policyOn(team.policies, "chat.profile")) {
    profile = createProfilePublisher({
      chat: { ...chatPort, setAgentProfile: chatPort.setAgentProfile.bind(chatPort) },
      office: connection,
      team,
      who: {
        name: me.name,
        role: role?.title ?? me.role,
        ...(role?.summary ? { description: role.summary } : {}),
        ...(model ? { model } : {}),
      },
      log,
      ...(env.tracker ? { tracker: env.tracker } : {}),
    });
  }

  if (env.chat) {
    chat = createChatRelay({
      ...(profile ? { profile } : {}),
      chat: env.chat,
      office: connection,
      team,
      person,
      log,
      ...(env.tracker ? { tracker: env.tracker } : {}),
    });

    // Reports the office queued while this agent was offline are posted by the agent when it connects.
    const relay = chat;
    connection.onReports?.((reports) => void relay.postQueued(reports));
  } else if (env.unavailable?.chat) {
    log.warn("chat requests are off", { reason: env.unavailable.chat });
  }

  return { ...(chat ? { chat } : {}), ...(profile ? { profile } : {}) };
}

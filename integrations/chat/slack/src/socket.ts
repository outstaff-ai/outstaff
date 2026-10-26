import { SocketModeClient } from "@slack/socket-mode";
import type { SlackEvent, SlackSocket } from "./api.js";

interface Envelope {
  ack(): Promise<void>;
  type: string;
  body?: { event?: SlackEvent };
}

/** Socket Mode over `@slack/socket-mode`. Each envelope is acknowledged first, inside Slack's three seconds. */
export function createSocketModeSocket(appToken: string): SlackSocket {
  const client = new SocketModeClient({ appToken });
  return {
    onEvent(handler) {
      client.on("slack_event", async (envelope: Envelope) => {
        await envelope.ack();
        const event = envelope.type === "events_api" ? envelope.body?.event : undefined;
        if (event) {
          await handler(event);
        }
      });
    },
    async start() {
      await client.start();
    },
    async stop() {
      await client.disconnect();
    },
  };
}

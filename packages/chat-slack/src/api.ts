// The slice of Slack's Web API and Socket Mode the adapter uses. The real clients satisfy these shapes; tests
// inject a fake. Fields are optional because Slack omits them freely.

/** A file shared in a message. The download needs the bot token and the `files:read` scope. */
export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

export interface SlackMessage {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  files?: SlackFile[];
}

export interface SlackUser {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;

  /** IANA timezone name of the user, for example Europe/Berlin. */
  tz?: string;
  profile?: { display_name?: string };
}

export interface SlackPage {
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface SlackWeb {
  auth: { test(): Promise<{ user_id?: string }> };
  users: { info(args: { user: string }): Promise<{ user?: SlackUser }> };
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      thread_ts?: string;
      unfurl_links?: boolean;
      unfurl_media?: boolean;
    }): Promise<{ ts?: string; channel?: string }>;
  };
  reactions: { add(args: { channel: string; timestamp: string; name: string }): Promise<unknown> };
  conversations: {
    history(args: { channel: string; limit?: number; cursor?: string }): Promise<SlackPage>;
    replies(args: {
      channel: string;
      ts: string;
      limit?: number;
      cursor?: string;
    }): Promise<SlackPage>;
    open(args: { users: string }): Promise<{ channel?: { id?: string } }>;
  };
  views: { publish(args: { user_id: string; view: SlackHomeView }): Promise<unknown> };
}

export interface SlackHomeView {
  type: "home";
  blocks: Record<string, unknown>[];
}

/** An Events API event, as delivered over Socket Mode. */
export interface SlackEvent {
  type: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  tab?: string;
  files?: SlackFile[];
}

export interface SlackSocket {
  /** The handler runs after the envelope is acknowledged; it must not throw. */
  onEvent(handler: (event: SlackEvent) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

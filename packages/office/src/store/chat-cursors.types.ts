/** Where one of a person's chat conversations left off: when the last message the office took in was written. */
export interface ChatCursor {
  channel: string;

  /** The thread; absent for the top level of the channel or direct message. */
  thread?: string | undefined;

  /** ISO-8601, the chat's own time of the message. */
  at: string;
}

export interface ChatCursorStore {
  /** Moves the conversation's cursor to `cursor.at`; a cursor already later stays where it is. */
  advanceChatCursor(person: string, cursor: ChatCursor): Promise<void>;

  /** The person's conversations, latest first, at most `limit`. */
  listChatCursors(person: string, limit: number): Promise<ChatCursor[]>;
}

import { z } from "zod";
import { chatMessages } from "./messages/chat.js";
import { otherMessages } from "./messages/other.js";
import { sessionMessages } from "./messages/session.js";
import { workMessages } from "./messages/work.js";

export const messageSchema = z.discriminatedUnion("type", [
  ...sessionMessages,
  ...workMessages,
  ...chatMessages,
  ...otherMessages,
]);

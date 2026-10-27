import type { PayloadOf } from "@outstaff/protocol";
import type { EngineRecord, Outcome } from "./compare.types.js";

type MessageResult = PayloadOf<"chat_message_result">;

/** What the desk did instead of waking anyone: a placement answer, a question to the PM, or an answer it could not read. */
const NOT_WOKEN: Partial<Record<MessageResult["disposition"], string>> = {
  placed: "the desk read the message as where filed work goes, and placed it",
  asked_pm: "the desk asked the PM where the filed work goes",
  unclear: "the desk could not read where the filed work goes, and asked again",
};

/**
 * What the chat desk did with a message, in the shape the engine's record has, so shadow mode compares it with the
 * pipeline's decisions: a chat session started (or waiting for a free one) is a `chat` wake of the agent on the
 * conversation, a message that joined an item of the thread wakes that item's kind, and placement answers wake nobody.
 */
export function deskRecord(
  person: string,
  subject: { type: "chat"; ref: string },
  result: MessageResult,
): EngineRecord {
  const wake = (kind: string): Outcome => ({ type: "wake", person, kind, subject });
  const not = NOT_WOKEN[result.disposition];
  if (not) {
    return { effects: [], skipped: [{ outcome: wake("chat"), note: not }] };
  }

  const kind = result.disposition === "joined" ? (result.item?.kind ?? "chat") : "chat";
  return { effects: [wake(kind)] };
}

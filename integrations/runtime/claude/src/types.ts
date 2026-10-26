import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** The slice of the SDK's `query()` the adapter uses. Tests inject a fake. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

import { z } from "zod";

const d = (description: string) => ({ description });

export const linkSchema = z
  .strictObject({
    url: z
      .string()
      .regex(/^wss?:\/\/\S+$/, "Use a ws:// or wss:// URL.")
      .meta(d("Where the office connects, for example wss://ops.acme.example/link.")),
  })
  .meta(
    d(
      "Proposed (decision 0016): a monitoring or management service the office connects out to, with the secret OUTSTAFF_LINK_TOKEN, that shows its people, queues and event traces (a dashboard, for example). Without it, or without the token, the office connects to none.",
    ),
  );

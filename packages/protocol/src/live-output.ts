import { z } from "zod";

const utf8 = (maximum: number) => z.string().refine(value => new TextEncoder().encode(value).length <= maximum, "Live output is too large");

/** Additive canonical progress contract. Old connectors without stream_mode
 * retain their legacy payload; new publishers send replaceable snapshots.
 */
export const LiveOutputPayloadSchema = z.object({
  content: utf8(24 * 1024), phase: z.literal("stream"),
  stream_id: z.string().uuid(), stream_mode: z.literal("snapshot"),
  stream_kind: z.enum(["answer", "reasoning", "tool", "plan"]),
  stream_revision: z.number().int().min(1).max(1200),
  stream_state: z.enum(["running", "completed", "failed"]),
  title: utf8(256).optional(),
  plan: z.array(z.object({ step: utf8(512), status: z.enum(["pending", "in_progress", "completed"]) }).strict()).max(64).optional(),
  status: z.enum(["thinking", "running"]).optional(),
  occurred_at: z.string().datetime().optional(),
  capture_fidelity: z.literal("harness_transcript").optional(),
  source_harness: z.string().min(1).max(80).optional(),
}).strict().superRefine((value, context) => {
  if ((value.stream_kind === "plan") !== (value.plan !== undefined)) {
    context.addIssue({ code: "custom", message: "Only plan snapshots carry plan steps" });
  }
});
export type LiveOutputPayload = z.infer<typeof LiveOutputPayloadSchema>;

import { z } from "zod";
import { CanonicalEventSchema, MessageMentionsSchema, RuntimeExecutionProfilesSchema } from "./index.js";

const id = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u);
const key = z.string().trim().min(8).max(200);
const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u);
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !value.includes("\0"));

/** A native adapter must implement every fence before advertising shared work. */
export const SharedExecutionCapabilitySchema = z.object({ version: z.literal(1), isolated: z.literal(true),
  project_only: z.literal(true), cancellation: z.literal(true), liveness_watchdog: z.literal(true) }).strict();
export type SharedExecutionCapability = z.infer<typeof SharedExecutionCapabilitySchema>;
export const SharedAgentProfileSchema = z.object({ harness: z.enum(["codex", "deepseek-harness"]),
  provider: line(80), model: line(160), reasoning_effort: line(80).optional() }).strict();
export type SharedAgentProfile = z.infer<typeof SharedAgentProfileSchema>;
export const AgentShareLimitsSchema = z.object({ per_member_daily_calls: z.number().int().min(1).max(10000).default(20),
  per_member_daily_seconds: z.number().int().min(1).max(864000).default(3600),
  total_daily_calls: z.number().int().min(1).max(10000).default(100),
  total_daily_seconds: z.number().int().min(1).max(864000).default(18000),
  max_concurrent: z.number().int().min(1).max(1).default(1),
  max_request_seconds: z.number().int().min(1).max(720).default(720) }).strict()
  .refine(value => value.per_member_daily_calls <= value.total_daily_calls
    && value.per_member_daily_seconds <= value.total_daily_seconds
    && value.max_request_seconds <= value.per_member_daily_seconds,
  "Member and single-request limits must fit inside their total budgets");
export type AgentShareLimits = z.infer<typeof AgentShareLimitsSchema>;
export const SaveAgentShareInputSchema = z.object({ share_id: id.optional(), source_runtime_id: id,
  execution_profile: SharedAgentProfileSchema.optional(), enabled: z.boolean().optional(), allowed_user_ids: z.array(id).max(64)
    .refine(values => new Set(values).size === values.length, "Allowed users must be unique"),
  limits: AgentShareLimitsSchema.default({ per_member_daily_calls: 20, per_member_daily_seconds: 3600,
    total_daily_calls: 100, total_daily_seconds: 18000, max_concurrent: 1, max_request_seconds: 720 }),
  expected_revision: z.number().int().positive().nullable(), idempotency_key: key }).strict()
  .refine(value => Boolean(value.share_id) === (value.expected_revision !== null), "Updating a share requires its revision")
  .refine(value => !value.enabled || value.allowed_user_ids.length > 0, "Starting sharing requires at least one member");
export type SaveAgentShareInput = z.infer<typeof SaveAgentShareInputSchema>;
export const ControlAgentShareInputSchema = z.object({ action: z.enum(["enable", "disable"]),
  expected_revision: z.number().int().positive().optional(), idempotency_key: key }).strict()
  .refine(value => value.action === "disable" || value.expected_revision !== undefined, "Enabling requires the current revision");
export type ControlAgentShareInput = z.infer<typeof ControlAgentShareInputSchema>;
export const AgentShareUsageSchema = z.object({ utc_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  calls: z.number().int().nonnegative(), seconds_used: z.number().int().nonnegative(),
  seconds_reserved: z.number().int().nonnegative(), active_jobs: z.number().int().nonnegative() }).strict();
export const AgentShareSchema = z.object({ id, project_id: id, owner_user_id: id, owner_display_name: line(120),
  owner_avatar_id: z.string().max(128).nullable(), revision: z.number().int().positive(), enabled: z.boolean(),
  available: z.boolean(), disabled_reason: line(80).nullable(), execution_profile: SharedAgentProfileSchema,
  execution_profiles: z.lazy(() => RuntimeExecutionProfilesSchema).optional(),
  limits: AgentShareLimitsSchema, usage: AgentShareUsageSchema, total_usage: AgentShareUsageSchema.optional(),
  allowed_user_ids: z.array(id).max(64).optional(), source_runtime_id: id.optional(), owner_device_id: id.optional(),
  created_at: z.string().datetime(), updated_at: z.string().datetime() }).strict();
export type AgentShare = z.infer<typeof AgentShareSchema>;
export const AgentSharesResponseSchema = z.object({ shares: z.array(AgentShareSchema).max(128) }).strict();
export const AgentShareResponseSchema = z.object({ share: AgentShareSchema, replayed: z.boolean().optional() }).strict();
export const SharedAgentRequestInputSchema = z.object({ share_id: id, share_revision: z.number().int().positive(),
  execution_profile: SharedAgentProfileSchema.optional(),
  content: text(16000), content_revision: z.number().int().nonnegative(), solo_transfer_ack: z.boolean().default(false),
  reply_to_event_id: id.nullable().optional(), mentions: z.lazy(() => MessageMentionsSchema).optional(), idempotency_key: key }).strict();
export type SharedAgentRequestInput = z.infer<typeof SharedAgentRequestInputSchema>;
/** Server-owned metadata. Generic events and ordinary native producers cannot forge this. */
export const SharedAgentMetadataSchema = z.object({ share_id: id, share_revision: z.number().int().positive(), job_id: id,
  executor_owner_user_id: id, executor_owner_display_name: line(120), execution_profile: SharedAgentProfileSchema }).strict();
export type SharedAgentMetadata = z.infer<typeof SharedAgentMetadataSchema>;
export const AgentShareJobStatuses = ["queued", "running", "completed", "failed", "cancelled", "timed_out"] as const;
export const AgentShareJobSchema = z.object({ id, project_id: id, share_id: id, share_revision: z.number().int().positive(),
  session_id: id, request_event_id: id, status: z.enum(AgentShareJobStatuses),
  requester_user_id: id, requester_display_name: line(120), execution_profile: SharedAgentProfileSchema,
  created_at: z.string().datetime(), deadline_at: z.string().datetime().nullable(),
  finished_at: z.string().datetime().nullable(), error_code: line(80).nullable(), cleanup_pending: z.boolean() }).strict();
export type AgentShareJob = z.infer<typeof AgentShareJobSchema>;
export const AgentShareJobsResponseSchema = z.object({ jobs: z.array(AgentShareJobSchema).max(64) }).strict();
export const ClaimAgentShareJobInputSchema = z.object({ idempotency_key: key }).strict();
export const AgentShareJobLeaseInputSchema = z.object({ claim_attempt: z.number().int().positive(), idempotency_key: key }).strict();
export type AgentShareJobLeaseInput = z.infer<typeof AgentShareJobLeaseInputSchema>;
export const AgentShareJobProgressInputSchema = AgentShareJobLeaseInputSchema.extend({
  payload: z.unknown(), observed_model: line(160), observed_reasoning_effort: line(80).optional() }).strict();
export type AgentShareJobProgressInput = z.infer<typeof AgentShareJobProgressInputSchema>;
export const CompleteAgentShareJobInputSchema = AgentShareJobProgressInputSchema.extend({
  outcome: z.enum(["completed", "failed", "timed_out"]), executor_stopped: z.literal(true) }).strict();
export type CompleteAgentShareJobInput = z.infer<typeof CompleteAgentShareJobInputSchema>;
export const AbortAgentShareJobInputSchema = AgentShareJobLeaseInputSchema.extend({ executor_stopped: z.literal(true) }).strict();
export type AbortAgentShareJobInput = z.infer<typeof AbortAgentShareJobInputSchema>;
export const ReportAgentShareAvailabilityInputSchema = z.object({
  state: z.enum(["ready", "locked", "offline", "unsupported"]), idempotency_key: key }).strict();
export type ReportAgentShareAvailabilityInput = z.infer<typeof ReportAgentShareAvailabilityInputSchema>;
export const ReportAgentShareSourceAvailabilityInputSchema = ReportAgentShareAvailabilityInputSchema.extend({
  project_id: id, source_runtime_id: id }).strict();
export type ReportAgentShareSourceAvailabilityInput = z.infer<typeof ReportAgentShareSourceAvailabilityInputSchema>;

/** Context remains a separately validated HistoryContext, never a provider-request claim. */
export const AgentShareExecutionCapsuleSchema = z.object({ version: z.literal(1), job: AgentShareJobSchema,
  source_runtime_id: id, owner_device_id: id, content: text(16000), context: z.object({
    view: z.enum(["summary", "original"]), through_sequence: z.number().int().nonnegative(),
    content_revision: z.number().int().nonnegative().optional(), items: z.array(z.object({
      kind: z.enum(["original", "summary"]), event_id: id, sequence: z.number().int().positive(), actor_user_id: id,
      content: z.string().max(262144), source_event_ids: z.array(id).max(10000).optional() }).strict()).max(10000) }).strict(),
  context_digest: z.string().regex(/^[a-f0-9]{64}$/u), content_revision: z.number().int().nonnegative(),
  through_sequence: z.number().int().nonnegative(), claim_attempt: z.number().int().positive(),
  lease_expires_at: z.string().datetime(), deadline_at: z.string().datetime(),
  max_request_seconds: z.number().int().min(1).max(720), sandbox_scope: z.literal("project_only"),
  reply_to_event_id: id.nullable().optional(), mentions: z.lazy(() => MessageMentionsSchema).optional(),
  quoted_message: z.object({ event_id: id, sequence: z.number().int().positive(), actor_user_id: id,
    content: z.string().max(65536) }).strict().optional() }).strict();
export type AgentShareExecutionCapsule = z.infer<typeof AgentShareExecutionCapsuleSchema>;
const canonical = z.lazy(() => CanonicalEventSchema);
export const SharedAgentRequestAcceptedSchema = z.object({ event: canonical, job: AgentShareJobSchema, replayed: z.boolean() }).strict();
export const AgentShareJobClaimResponseSchema = z.object({ job: AgentShareJobSchema,
  capsule: AgentShareExecutionCapsuleSchema, replayed: z.boolean() }).strict();
export const AgentShareJobLeaseResponseSchema = z.object({ job: AgentShareJobSchema,
  lease_expires_at: z.string().datetime(), deadline_at: z.string().datetime() }).strict();
export const AgentShareJobEventResponseSchema = z.object({ event: canonical, job: AgentShareJobSchema, replayed: z.boolean() }).strict();
export const AgentShareJobResponseSchema = z.object({ job: AgentShareJobSchema, replayed: z.boolean() }).strict();
export const AgentShareAvailabilityResponseSchema = z.object({ shares: z.array(AgentShareSchema).max(128) }).strict();
export const AgentShareSourceRuntimeSchema = z.object({ id, session_id: id, device_id: id, purpose: z.literal("execution"),
  harness: line(80), provider: line(80), model: line(160), status: z.enum(["online", "offline", "revoked"]),
  sharing_capability: SharedExecutionCapabilitySchema.optional(), execution_profiles: z.lazy(() => RuntimeExecutionProfilesSchema).optional(),
  sharing_availability: z.enum(["ready", "locked", "offline", "unsupported"]).optional(),
  context_deletion_version: z.number().int().nonnegative().optional() }).strict();
export const AgentShareSourcesResponseSchema = z.object({ runtimes: z.array(AgentShareSourceRuntimeSchema).max(128) }).strict();

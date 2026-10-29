import { z } from "zod";
import { AgentTeamDraftSchema } from "./agent-team-library.js";

export const AGENT_TEAM_CONFIG_SCHEMA_URL = "https://gatherthread.cn/schemas/agent-team.v1.schema.json";
export const AGENT_TEAM_CONFIG_MAX_BYTES = 128 * 1024;

/** A portable editable definition, never a saved revision or execution grant. */
export const AgentTeamConfigSchema = z.object({
  $schema: z.literal(AGENT_TEAM_CONFIG_SCHEMA_URL).optional(),
  version: z.literal(1),
  kind: z.literal("gatherthread.agent-team"),
  draft: AgentTeamDraftSchema,
  max_calls: z.number().int().min(1).max(48),
  max_duration_minutes: z.number().int().min(1).max(120),
}).strict();
export type AgentTeamConfiguration = z.infer<typeof AgentTeamConfigSchema>;

export const AGENT_TEAM_CONFIG_JSON_SCHEMA = {
  $id: AGENT_TEAM_CONFIG_SCHEMA_URL,
  title: "GatherThread Agent Team configuration",
  ...z.toJSONSchema(AgentTeamConfigSchema, { target: "draft-2020-12", io: "input", unrepresentable: "any" }),
};

export class AgentTeamConfigurationError extends Error {
  readonly path: string;
  constructor(path: string) {
    super("Invalid Agent Team configuration");
    this.name = "AgentTeamConfigurationError";
    this.path = path;
  }
}

export function parseAgentTeamConfiguration(text: string): AgentTeamConfiguration {
  if (typeof text !== "string" || text.length > AGENT_TEAM_CONFIG_MAX_BYTES || new TextEncoder().encode(text).byteLength > AGENT_TEAM_CONFIG_MAX_BYTES) {
    throw new AgentTeamConfigurationError("file_size");
  }
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/u, "")); }
  catch { throw new AgentTeamConfigurationError("json"); }
  const parsed = AgentTeamConfigSchema.safeParse(value);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.map(String).join(".");
    throw new AgentTeamConfigurationError(path || "configuration");
  }
  return parsed.data;
}

export function createAgentTeamConfiguration(value: {
  draft: unknown; max_calls: number; max_duration_minutes: number;
}): AgentTeamConfiguration {
  return AgentTeamConfigSchema.parse({ $schema: AGENT_TEAM_CONFIG_SCHEMA_URL,
    version: 1, kind: "gatherthread.agent-team", draft: value.draft,
    max_calls: value.max_calls, max_duration_minutes: value.max_duration_minutes });
}

import { z } from "zod";

export const PREFERENCES_SCHEMA_URL = "https://gatherthread.cn/schemas/preferences.v1.schema.json";
export const MAX_CONFIGURATION_BYTES = 128 * 1024;
const harness = z.enum(["codex", "deepseek-harness", "claude-code", "cloud"]);
const integer = (min: number, max: number) => z.number().int().min(min).max(max);

// Portable preferences, never credentials, grants, account mutations or device bindings.
export const PreferencesConfigurationSchema = z.object({
  $schema: z.literal(PREFERENCES_SCHEMA_URL).optional(),
  version: z.literal(1),
  kind: z.literal("gatherthread.preferences"),
  interface_mode: z.enum(["auto", "mobile", "desktop"]).optional(),
  settings: z.object({
    general: z.object({ locale: z.enum(["en", "zh-CN"]).optional() }).strict().optional(),
    appearance: z.object({
      theme: z.enum(["system", "light", "dark"]).optional(),
      textScalePercent: integer(90, 125).optional(),
      density: z.enum(["comfortable", "compact"]).optional(),
      motion: z.enum(["system", "reduce", "full"]).optional(),
      ambientCanvas: z.enum(["off", "subtle", "pronounced"]).optional(),
      highContrast: z.boolean().optional(),
    }).strict().optional(),
    layout: z.object({
      leftRailPixels: integer(210, 420).optional(), rightPanelPixels: integer(260, 900).optional(),
      composerPixels: integer(210, 560).optional(),
    }).strict().optional(),
    sync: z.object({
      mode: z.enum(["adaptive", "fixed"]).optional(),
      contextBudgetBytes: integer(8192, 5 * 1024 * 1024).optional(),
      visibleHistorySync: z.enum(["first-connect", "never"]).optional(),
    }).strict().optional(),
    composer: z.object({
      enterBehavior: z.enum(["newline", "send_chat", "request_agent"]).optional(),
      confirmAgentRequest: z.boolean().optional(), autoScroll: z.boolean().optional(),
    }).strict().optional(),
    historySummaries: z.object({ instructions: z.string().trim().min(1).max(4000) }).strict().optional(),
    notifications: z.object({ agentCompleted: z.boolean().optional(), connectionLost: z.boolean().optional() }).strict().optional(),
    agents: z.object({
      activeHarness: harness.optional(),
      enabledHarnesses: z.array(harness).min(1).max(4).refine(values => new Set(values).size === values.length, "Duplicate harness").optional(),
      customCodexModels: z.array(z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u)).max(40).optional(),
    }).strict().optional(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const agents = value.settings.agents;
  if (agents?.activeHarness && agents.enabledHarnesses && !agents.enabledHarnesses.includes(agents.activeHarness)) {
    ctx.addIssue({ code: "custom", path: ["settings", "agents", "activeHarness"], message: "Active harness must be enabled" });
  }
});
export type PreferencesConfiguration = z.infer<typeof PreferencesConfigurationSchema>;
export const PreferencesJsonSchema = z.toJSONSchema(PreferencesConfigurationSchema, { target: "draft-2020-12", io: "input" });

export function readConfigurationJson(text: string): unknown {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_CONFIGURATION_BYTES) {
    throw new Error("Configuration must be at most 128 KiB.");
  }
  return JSON.parse(text, (key, value: unknown) => {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Unsafe configuration key.");
    return value;
  }) as unknown;
}

export const DiscardEmptySoloInputSchema = z.object({}).strict();
export const DiscardEmptySoloResultSchema = z.object({
  session_id: z.string().min(1).max(128), discarded: z.boolean(),
}).strict();

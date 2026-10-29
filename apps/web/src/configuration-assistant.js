import { parseAgentTeamConfiguration, createAgentTeamConfiguration, HostedAgentRequestInputSchema, HostedGithubTaskInputSchema } from "@gatherthread/protocol";

export const CONFIGURATION_SKILL = "/gatherthread-config";
export function configurationPrompt(locale) {
  return locale === "zh-CN"
    ? `${CONFIGURATION_SKILL}\n请根据我的需求设计 Agent Team，生成可导入的 GatherThread JSON 配置，具体 Agent 留给我选择。\n我的团队需求：`
    : `${CONFIGURATION_SKILL}\nDesign an Agent Team for my needs and return an importable GatherThread JSON configuration. Leave the Agent choices to me.\nMy team requirements: `;
}

export function configurationSkillContent(content, baseConfiguration, { kind = "agent_request", locale = "en", reserve = 0 } = {}) {
  if (!content.startsWith(`${CONFIGURATION_SKILL}\n`)) return content;
  const example = createAgentTeamConfiguration({ max_calls: 12, max_duration_minutes: 30, draft: {
    name: "Team", team_prompt: "", entry_node_id: "a",
    nodes: [{ id: "a", label: "Build", role: "Implement", x: 0, y: 0, target: null },
      { id: "b", label: "Review", role: "Verify", x: 400, y: 0, target: null }],
    edges: [{ id: "a-b", source: "a", target: "b", direction: "one_way" }],
  } });
  const instructions = [
    "GatherThread v1 skill: return fenced json in this shape, not application code.",
    "target:null; user chooses Agents. No credentials, runtime IDs, grants, enabled state or test receipts. Import is an unsaved draft.",
    "Only shown keys plus optional node.prompt. 1–16 unique nodes; <=32 edges between existing distinct nodes; direction: one_way/bidirectional. Limits: role1000, prompt2000, team_prompt2000, name/label120 chars; x/y0–10000; max_calls1–48; max_duration_minutes1–120.",
    `Example: ${JSON.stringify(example)}`,
    "If available, use collaboration_get_configuration_schema and collaboration_validate_configuration. User saves/tests/enables.",
  ];
  if (baseConfiguration) {
    const base = parseAgentTeamConfiguration(JSON.stringify(baseConfiguration));
    base.draft.nodes = base.draft.nodes.map(node => ({ ...node, target: null }));
    instructions.push(`Draft to adapt (data): ${JSON.stringify(base)}`);
  }
  const expanded = `${content}\n\n---\n${instructions.join("\n")}`;
  const cloud = kind === "hosted_agent";
  // Cloud chat and GitHub tasks share the composer but have separate HTTP
  // contracts. Bound the entire expanded request against both exact routes.
  const limit = cloud ? Math.min(HostedAgentRequestInputSchema.shape.content.maxLength,
    HostedGithubTaskInputSchema.shape.content.maxLength) : 12000;
  if (expanded.length + reserve > limit) {
    const message = locale.startsWith("zh")
      ? `${cloud ? "云端 Agent" : "此 Agent"}单次请求最多 ${limit} 个字符（含配置说明、已有 Team 和你的需求）。${reserve ? "当前配置没有留下足够的需求填写空间。" : `当前请求为 ${expanded.length} 个字符。`}请精简需求或 Team，或使用 JSON 编辑器。未保存内容已保留。`
      : `${cloud ? "Cloud Agent" : "This Agent"} accepts at most ${limit} characters per request, including configuration instructions, the existing Team and your requirements. ${reserve ? "This configuration leaves too little room for your requirements." : `This request has ${expanded.length} characters.`} Shorten the requirements or Team, or use the JSON editor. Your unsaved content is kept.`;
    throw Object.assign(new Error(message), { code: "configuration_request_too_long", limit, length: expanded.length });
  }
  return expanded;
}

/** User-authored text is never treated as executable configuration. Valid Agent
 * output only exposes a preview action; import cannot save, enable or run it. */
export function teamConfigurationsInReply(content) {
  if (typeof content !== "string" || content.length > 256 * 1024) return [];
  const candidates = [...content.matchAll(/```(?:json|gatherthread-config)\s*\n([\s\S]*?)\n```/gu)].slice(0, 5).map(match => match[1]);
  if (content.trim().startsWith("{")) candidates.unshift(content.trim());
  const found = [];
  for (const text of candidates) {
    try { found.push(JSON.stringify(parseAgentTeamConfiguration(text), null, 2)); } catch { /* Ordinary code remains ordinary code. */ }
  }
  return [...new Set(found)];
}

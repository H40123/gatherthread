// Presets describe responsibilities and allowed collaboration. They do not
// select models, enable Teams, or grant access to another member's Agent.
const role = (id, en, zh, enRole, zhRole, enPrompt, zhPrompt) => ({ id, en, zh, enRole, zhRole, enPrompt, zhPrompt });
export const AGENT_TEAM_PRESETS = [
  { id: "development", en: "Build and review", zh: "开发与审查", enDescription: "Plan a change, implement it, then review the result.", zhDescription: "拆解需求、实现功能，再独立检查结果。",
    roles: [
      role("lead", "Coordinator", "协调员", "Clarify the goal, split the work and deliver the final result.", "澄清目标、拆分工作并汇总交付。", "Ask the developer to implement the agreed change, ask the reviewer to check it, then report verified results and remaining issues.", "请开发员实现已确定的改动，再请审查员检查；最后说明已验证的结果与遗留问题。"),
      role("builder", "Developer", "开发员", "Implement the requested change within the agreed scope.", "在约定范围内实现需求。", "Inspect existing files, make a focused change and run relevant checks. Report actual changed files and test results.", "先检查已有文件，再做聚焦改动并运行相关检查。报告实际修改的文件与测试结果。"),
      role("reviewer", "Reviewer", "审查员", "Independently check correctness and regression risks.", "独立检查正确性和回归风险。", "Review the change against the request. Cite concrete defects and reproducible checks; return findings to the coordinator.", "对照需求检查改动，指出具体问题和复现检查，并向协调员反馈。"),
    ] },
  { id: "research", en: "Research and verification", zh: "科研与验证", enDescription: "Turn a research question into a checked method and result.", zhDescription: "围绕研究问题，形成方法、计算与核验结果。",
    roles: [
      role("lead", "Research lead", "研究负责人", "Define the research question, assumptions and evidence needed.", "明确研究问题、假设与所需证据。", "Coordinate method development and independent verification. Separate established findings from assumptions and open questions.", "组织方法分析与独立核验，区分已有结论、假设和待解问题。"),
      role("analyst", "Analyst", "分析员", "Develop the method and perform available calculations or data analysis.", "制定方法并完成可用的计算或数据分析。", "State equations, units and data sources. Use available tools and report reproducible steps; do not invent missing data.", "说明公式、单位和数据来源。使用可用工具，给出可复现步骤，不编造缺失数据。"),
      role("checker", "Verifier", "核验员", "Check assumptions, numerical results and cited evidence independently.", "独立检查假设、数值结果与引用证据。", "Check limiting cases, units and reproducibility. Flag unsupported conclusions and report uncertainty.", "检查极限情况、量纲与可复现性，指出证据不足的结论和不确定性。"),
    ] },
  { id: "frontend", en: "Interface design", zh: "界面设计与实现", enDescription: "Shape the interaction, build it and check usability.", zhDescription: "设计交互、实现界面，再检查易用性。",
    roles: [
      role("lead", "Design lead", "设计负责人", "Translate user goals into a focused interaction and visual direction.", "将用户目标转化为清晰的交互与视觉方向。", "Reuse the product's design language. Coordinate implementation and usability checks; explain decisions in user terms.", "沿用产品设计语言，协调实现和易用性检查，用用户能理解的语言说明设计。"),
      role("builder", "Frontend developer", "前端开发员", "Implement the interface while preserving existing behavior.", "实现界面并保留已有行为。", "Preserve accessibility, responsive layout, keyboard navigation and loading/error states. Check the implemented flow in available browsers.", "保留无障碍、响应式布局、键盘操作和加载/错误状态，使用可用浏览器检查实际流程。"),
      role("reviewer", "Usability reviewer", "易用性审查员", "Review the interface from a new user's perspective.", "从新用户视角检查界面。", "Check labels, contrast, focus, touch targets and narrow-screen layouts. Report broken or confusing interactions with concrete steps.", "检查文案、对比度、焦点、触摸区域和窄屏布局，给出失效或难理解交互的具体操作步骤。"),
    ] },
  { id: "investigation", en: "Research a topic", zh: "调研与报告", enDescription: "Collect sources, compare evidence and write a clear report.", zhDescription: "收集来源、核对证据，写成清晰报告。",
    roles: [
      role("lead", "Report editor", "报告编辑", "Define the questions and synthesize an evidence-based answer.", "确定调研问题并形成有证据支持的回答。", "Assign source gathering and verification, compare tradeoffs, and link each important claim to its source.", "安排资料收集与核验，比较取舍，并为重要结论附上对应来源。"),
      role("researcher", "Researcher", "资料调研员", "Gather relevant current information from primary sources.", "从一手来源收集相关且最新的信息。", "Record source links, dates and scope. Distinguish source facts from your interpretation; state when browsing is unavailable.", "记录来源链接、日期和适用范围，区分来源事实与推断；无法联网时明确说明。"),
      role("checker", "Fact checker", "事实核验员", "Verify key claims, compare conflicting evidence and identify gaps.", "核实关键事实、对比矛盾证据并找出缺口。", "Check quoted figures and dates against original sources. Return corrections and unresolved uncertainties to the editor.", "对照原始来源核查数字和日期，向编辑返回修正与未解决的不确定性。"),
    ] },
  { id: "debugging", en: "Diagnose and fix", zh: "故障诊断与修复", enDescription: "Reproduce a bug, fix its cause and verify related paths.", zhDescription: "复现问题、修复原因，并核验相关路径。",
    roles: [
      role("lead", "Incident coordinator", "故障协调员", "Define the observed failure and coordinate a minimal repair.", "界定实际故障并协调最小修复。", "Ask for a reproduction and evidence before choosing a fix. Keep the original scope and report verified behavior.", "先收集复现与证据，再选择修复方案；保持任务范围并报告已验证行为。"),
      role("fixer", "Fix engineer", "修复工程师", "Trace the failure to its cause and implement a targeted fix.", "追踪故障原因并实施针对性修复。", "Write a focused regression check, fix the cause and check similar call sites. Do not hide errors or relax authorization to make the test pass.", "补充针对性的回归检查，修复原因并排查类似调用点；不要通过隐藏错误或放宽权限让检查通过。"),
      role("verifier", "Regression reviewer", "回归审查员", "Independently verify the repaired behavior and nearby workflows.", "独立验证修复行为与相邻操作流程。", "Repeat the original reproduction and test cancellation, retry and failure states where relevant. Report remaining risks precisely.", "重复原始复现，并按需检查取消、重试和失败状态，准确说明剩余风险。"),
    ] },
];

export function createAgentTeamPreset(id, locale = "en", previousDraft = null) {
  const preset = AGENT_TEAM_PRESETS.find(item => item.id === id);
  if (!preset) throw new Error("Unknown Agent Team preset");
  const zh = locale.startsWith("zh");
  const nodes = preset.roles.map((item, index) => ({ id: `${preset.id}.${item.id}`, label: zh ? item.zh : item.en,
    role: zh ? item.zhRole : item.enRole, prompt: zh ? item.zhPrompt : item.enPrompt,
    x: index === 0 ? 48 : 360, y: index === 0 ? 155 : 45 + (index - 1) * 220,
    target: structuredClone(previousDraft?.nodes.find(node => node.id === `${preset.id}.${item.id}`)?.target ?? null) }));
  return { draft: { name: zh ? preset.zh : preset.en,
    team_prompt: zh ? "只在已连接的模块之间分派任务，按实际证据报告结果。需要额外权限或无法完成时请明确说明，不要声称已完成未执行的操作。" : "Delegate only along the configured connections. Report results supported by actual evidence. State missing access or capabilities; never claim an action was performed when it was not.",
    entry_node_id: nodes[0].id, nodes,
    edges: nodes.slice(1).map((node, index) => ({ id: `flow-${index + 1}`, source: nodes[0].id, target: node.id, direction: "bidirectional" })) },
    max_calls: 12, max_duration_minutes: 30 };
}

import { redactValue, type createLiveOutputPublisher, type LivePlanStep, type LiveOutputState } from "@gatherthread/adapters";

type Publisher = ReturnType<typeof createLiveOutputPublisher>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown) => typeof value === "string" ? value : "";
const visible = (value: unknown) => typeof value === "string" ? value : JSON.stringify(redactValue(value))?.slice(0, 48_000) ?? "";

export const CODEX_PUBLIC_WORK_METHODS = new Set([
  "item/started", "item/completed", "item/commandExecution/outputDelta", "item/fileChange/outputDelta",
  "item/reasoning/summaryTextDelta", "item/plan/delta", "turn/plan/updated",
]);

/** Input is already fenced to the connector-owned native thread and turn.
 * Never stringify notifications: only native UI-visible fields are selected.
 */
export function createCodexLiveOutputMapper(publisher: Publisher, options: { shareTools: boolean }) {
  const tools = new Map<string, { title: string; prefix: string; output: string }>();
  return {
    async accept(method: string, params: Record<string, unknown>) {
      if (!CODEX_PUBLIC_WORK_METHODS.has(method)) return;
      if (method === "turn/plan/updated") {
        if (!Array.isArray(params.plan)) return;
        const steps: LivePlanStep[] = params.plan.slice(0, 64).flatMap(value => {
          if (!record(value) || typeof value.step !== "string" || !["pending", "inProgress", "completed"].includes(string(value.status))) return [];
          return [{ step: value.step, status: value.status === "inProgress" ? "in_progress" : value.status as "pending" | "completed" }];
        });
        await publisher.onPlan("plan", steps); return;
      }
      if (method === "item/reasoning/summaryTextDelta") {
        const id = string(params.itemId);
        if (id && id.length <= 256) await publisher.onDelta(`summary:${id}:${Number.isSafeInteger(params.summaryIndex) ? params.summaryIndex : 0}`, string(params.delta), "reasoning", "Thinking");
        return;
      }
      if (method === "item/plan/delta") {
        if (string(params.itemId)) await publisher.onDelta(`proposal:${string(params.itemId)}`, string(params.delta), "tool", "Plan");
        return;
      }
      if (method.endsWith("/outputDelta")) {
        if (!options.shareTools) return;
        const id = string(params.itemId), tool = tools.get(id);
        if (!tool) return;
        tool.output = (tool.output + string(params.delta)).slice(0, 48_000);
        await publisher.onSnapshot(`tool:${id}`, tool.prefix + tool.output, "tool", tool.title); return;
      }
      const item = params.item;
      if (!record(item) || typeof item.id !== "string" || !item.id || item.id.length > 256) return;
      const done = method === "item/completed";
      const failed = item.status === "failed" || item.success === false
        || (item.type === "commandExecution" && Number.isSafeInteger(item.exitCode) && item.exitCode !== 0);
      const state: LiveOutputState = !done ? "running" : failed ? "failed" : "completed";
      if (item.type === "agentMessage") {
        if (done && typeof item.text === "string") await publisher.onSnapshot(item.id, item.text, "answer", undefined, state);
        return;
      }
      if (item.type === "reasoning") {
        // The summary is the public Codex UI summary, not `content` or raw deltas.
        if (done && Array.isArray(item.summary)) await publisher.onSnapshot(`summary:${item.id}:0`, item.summary.filter(value => typeof value === "string").join("\n"), "reasoning", "Thinking", state);
        return;
      }
      if (item.type === "plan" && typeof item.text === "string") {
        await publisher.onSnapshot(`proposal:${item.id}`, item.text, "tool", "Plan", state); return;
      }
      if (!options.shareTools) return;
      let title = "", prefix = "", output = "";
      if (item.type === "commandExecution") {
        title = "Terminal"; prefix = string(item.command) + "\n";
        output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : tools.get(item.id)?.output ?? "";
        if (done && Number.isSafeInteger(item.exitCode)) output += `\nExit: ${item.exitCode}`;
      } else if (item.type === "fileChange") {
        title = "File changes";
        prefix = Array.isArray(item.changes) ? item.changes.slice(0, 64).flatMap(change => record(change)
          ? [visible({ path: change.path, kind: change.kind, diff: change.diff })] : []).join("\n") : "";
      } else if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
        title = string(item.tool) || "Tool";
        prefix = visible(item.arguments) + "\n";
        const result = item.type === "mcpToolCall" && record(item.result) ? item.result.content : item.contentItems;
        if (Array.isArray(result)) output = result.slice(0, 64).flatMap(content => record(content) && typeof content.text === "string" ? [content.text] : []).join("\n");
        if (record(item.error) && typeof item.error.message === "string") output += item.error.message;
      } else if (item.type === "webSearch") {
        title = "Search"; prefix = string(item.query);
      } else if (item.type === "collabAgentToolCall") {
        title = "Agent collaboration"; prefix = string(item.tool) + "\n" + string(item.prompt);
        if (record(item.agentsStates)) output = Object.values(item.agentsStates).slice(0, 32).flatMap(agent => record(agent) ? [string(agent.status)] : []).join("\n");
      } else return;
      if (!tools.has(item.id) && tools.size >= 128) return;
      tools.set(item.id, { title, prefix: prefix.slice(0, 48_000), output: output.slice(0, 48_000) });
      await publisher.onSnapshot(`tool:${item.id}`, prefix + output, "tool", title, state);
    },
  };
}

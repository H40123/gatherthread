import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { redactText } from "@gatherthread/adapters";
import type { AgentShareExecutionCapsule, SharedExecutionCapability } from "@gatherthread/protocol";
import { buildSharedAgentPrompt, ProjectOnlyFileAccess, SHARED_EXECUTION_CAPABILITY, SharedExecutorCleanupUnconfirmedError,
  type SharedAgentExecutor, type SharedAgentExecutionResult } from "@gatherthread/bridge";
import { mapDshSessionEvent } from "./event-mapper.js";
import type { DshSessionEventRecord } from "./types.js";

interface Context { get(name: string): unknown; }
interface Session { id: string; seq: number; header?: { cwd?: string; version?: number }; snapshotEvents(from: number): unknown[]; }
interface Agent { session: Session; status: string; ctx: Context; followup(message: unknown): void; whenIdle(): Promise<void>; cancel(cause: { kind: "user" }): void; }
interface Handle { agent: Agent; dispose(): Promise<void>; }
interface Agents { get(id: string): Agent | undefined; create(input: { sessionId: string; meta: { cwd: string; origin: "subagent" };
  agentOptions: { provider: string; model: string }; signal: AbortSignal; setup(ctx: Context, agent: Agent): void }): Promise<Handle>; }
interface Tools { guard(callback: (exec: { name: string; agent?: Agent; signal?: AbortSignal }) => string | undefined): () => void;
  restrict(input: { deny: string[] }): () => void; schemas(): Array<{ name: string }>; register(input: unknown): () => void; }
interface SelectionRef { current: { provider: string; model: string; reasoningEffort?: string } | undefined; assembled: SelectionRef["current"]; }
export interface DshSharedAgentExecutorOptions { context: unknown; workspacePath: string; pythonCommand?: string;
  moduleImporter?: (specifier: string) => Promise<unknown>; }
const names = ["gatherthread_project_list", "gatherthread_project_read", "gatherthread_project_write"] as const;

/** A fresh public SDK Agent with a fixed persona and three fd-scoped file tools.
 * Native shell/MCP/web/skills/subagent and owner-history tools cannot execute.
 * The supported first implementation is POSIX; unsupported upstreams refuse.
 */
export class DshSharedAgentExecutor implements SharedAgentExecutor {
  readonly #options: DshSharedAgentExecutorOptions; #root: string | undefined;
  #files: ProjectOnlyFileAccess | undefined; #ready = false; #closed = false; #handle: Handle | undefined;
  #modules: { llm: Record<string, unknown>; agent: Record<string, unknown>; persona: Record<string, unknown> } | undefined;
  constructor(options: DshSharedAgentExecutorOptions) { this.#options = options; }
  async preflight(): Promise<SharedExecutionCapability | undefined> {
    if (this.#closed || process.platform === "win32") return undefined;
    try {
      const ctx = context(this.#options.context), agents = record(ctx.get("agents")), tools = record(ctx.get("tools"));
      if (typeof agents?.create !== "function" || typeof agents.get !== "function" || typeof tools?.guard !== "function"
        || typeof tools.register !== "function" || typeof tools.restrict !== "function" || typeof tools.schemas !== "function") return undefined;
      this.#root = await realpath(this.#options.workspacePath);
      if (!(await stat(this.#root)).isDirectory()) return undefined;
      this.#files = new ProjectOnlyFileAccess(this.#root, this.#options.pythonCommand);
      if (!await this.#files.preflight()) return undefined;
      const load = this.#options.moduleImporter ?? ((specifier: string) => import(specifier));
      const [llm, agent, persona] = await Promise.all([load("@deepseek-ai/dsh-llm"), load("@deepseek-ai/dsh-agent"), load("@deepseek-ai/dsh-persona")]);
      const modules = { llm: record(llm)!, agent: record(agent)!, persona: record(persona)! };
      if (typeof modules.llm?.freezeMessage !== "function" || typeof modules.agent?.installModelSelection !== "function"
        || typeof modules.persona?.apply !== "function") return undefined;
      this.#modules = modules; this.#ready = true; return SHARED_EXECUTION_CAPABILITY;
    } catch { this.#ready = false; return undefined; }
  }
  async execute(capsule: AgentShareExecutionCapsule, signal: AbortSignal): Promise<SharedAgentExecutionResult> {
    if (!this.#ready || this.#closed || !this.#root || !this.#files || !this.#modules || this.#handle) throw new Error("Shared DSH execution unavailable");
    if (capsule.job.execution_profile.harness !== "deepseek-harness") throw new Error("Shared DSH target mismatch");
    const prompt = buildSharedAgentPrompt(capsule); signal.throwIfAborted();
    const host = context(this.#options.context), agents = host.get("agents") as Agents;
    const selection = { provider: capsule.job.execution_profile.provider, model: capsule.job.execution_profile.model,
      ...(capsule.job.execution_profile.reasoning_effort === undefined ? {} : { reasoningEffort: capsule.job.execution_profile.reasoning_effort }) };
    const llmService = record(host.get("llm"));
    if (typeof llmService?.resolveModelInfo !== "function") throw new Error("DSH model resolver is unavailable");
    const resolved = record(await (llmService.resolveModelInfo as (provider: string, model: string, signal: AbortSignal) => Promise<unknown>)(selection.provider, selection.model, signal));
    if (resolved?.provider !== selection.provider || resolved.id !== selection.model) throw new Error("DSH shared model did not resolve exactly");
    if (selection.reasoningEffort !== undefined && !(record(resolved.reasoning)?.efforts as Array<{ id?: string }> | undefined)?.some(effort => effort.id === selection.reasoningEffort)) throw new Error("DSH shared reasoning effort is unsupported");
    const id = `gatherthread-shared-${randomUUID()}`, disposers: Array<() => void> = [], files = this.#files, modules = this.#modules;
    const ref: SelectionRef = { current: selection, assembled: undefined };
    let handle: Handle | undefined, abortPrompt: (() => void) | undefined;
    const lifecycle = new AbortController(), abortLifecycle = () => lifecycle.abort(signal.reason);
    signal.addEventListener("abort", abortLifecycle, { once: true });
    try {
      signal.throwIfAborted();
      handle = await agents.create({ sessionId: id, meta: { cwd: this.#root, origin: "subagent" },
        agentOptions: { provider: selection.provider, model: selection.model }, signal: lifecycle.signal,
        setup: (ctx, agent) => {
          if (agent.session.id !== id || agent.session.seq !== 0) throw new Error("DSH shared Session is not fresh");
          const tools = ctx.get("tools") as Tools;
          if (typeof tools.guard !== "function" || typeof tools.restrict !== "function" || typeof tools.register !== "function") throw new Error("DSH scoped tool enforcement is unavailable");
          disposers.push(tools.guard(exec => names.includes(exec.name as typeof names[number]) && exec.agent?.session.id === id
            && !exec.signal?.aborted && !signal.aborted ? undefined : "Shared Agent tools are limited to the authorized project file operations."));
          const global = tools.schemas().map(tool => tool.name).filter(name => name !== "run_code" && !names.includes(name as typeof names[number]));
          if (global.length) disposers.push(tools.restrict({ deny: global }));
          (modules.persona.apply as (ctx: Context, config: unknown) => void)(ctx, { prefix: "You are a GatherThread shared project Agent. Complete the current authorized task using only gatherthread_project_list, gatherthread_project_read and gatherthread_project_write. These tools use project-relative paths. Shell commands, network tools, native history, user profiles, credentials, skills and other Agents are unavailable. Return only a public result.", suffix: "", complete: true, includeRuntimeContext: false });
          disposers.push((modules.agent.installModelSelection as (ctx: Context, ref: SelectionRef) => () => void)(ctx, ref));
          for (const action of ["list", "read", "write"] as const) {
            disposers.push(tools.register({ name: `gatherthread_project_${action}`, description: `${action} a UTF-8 file within the authorized project only. Paths are relative; links and credential directories are refused.`,
              parameters: { type: "object", properties: { path: { type: "string" }, ...(action === "write" ? { content: { type: "string" } } : {}) }, required: action === "write" ? ["path", "content"] : ["path"], additionalProperties: false },
              output: { schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"], additionalProperties: false },
                render: (_args: unknown, value: { content: string }) => [{ type: "text", text: value.content }] },
              execute: async (args: unknown, exec: { signal: AbortSignal }) => {
                const input = record(args);
                if (!input || typeof input.path !== "string" || Object.keys(input).some(key => key !== "path" && key !== "content")
                  || (action === "write" && typeof input.content !== "string")) throw new Error("Invalid shared project tool input");
                signal.throwIfAborted();
                return files.execute({ action, path: input.path, ...(action === "write" ? { content: input.content as string } : {}) }, AbortSignal.any([exec.signal, signal]));
              } }));
          }
        } });
      this.#handle = handle;
      signal.throwIfAborted();
      const agent = handle.agent;
      if (agent.session.id !== id || agent.session.header?.cwd !== this.#root || agent.status !== "idle"
        || agent.session.seq !== 0 || agents.get(id) !== agent || typeof agent.cancel !== "function") throw new Error("DSH isolated shared Agent ownership or cancellation is unavailable");
      const version = agent.session.header.version;
      if (version !== undefined && version !== 2 && version !== 3 && version !== 4) throw new Error("Unsupported DSH shared Session format");
      const message = (modules.llm.freezeMessage as (input: unknown) => unknown)({ id: `gatherthread-shared-request:${capsule.job.id}:${capsule.claim_attempt}`,
        role: "user", content: [{ type: "text", text: prompt }],
        source: version === 4 ? { kind: "gatherthread", form: "relay" } : { kind: "plugin", plugin: "gatherthread", form: "relay" } });
      abortPrompt = () => agent.cancel({ kind: "user" });
      signal.addEventListener("abort", abortPrompt, { once: true });
      signal.throwIfAborted(); agent.followup(message);
      await agent.whenIdle(); signal.throwIfAborted();
      if (ref.assembled?.provider !== selection.provider || ref.assembled.model !== selection.model || ref.assembled.reasoningEffort !== selection.reasoningEffort) throw new Error("DSH shared request assembled an unexpected model route");
      const contents = agent.session.snapshotEvents(0).flatMap(event => {
        const mapped = mapDshSessionEvent(event as DshSessionEventRecord);
        return mapped?.kind === "assistant" ? [mapped.content] : [];
      });
      const content = redactText(contents.join("\n\n")).trim();
      if (!content || Buffer.byteLength(content) > 60 * 1024) throw new Error("DSH returned no bounded public shared result");
      return { content, observedModel: selection.model, ...(selection.reasoningEffort === undefined ? {} : { observedReasoningEffort: selection.reasoningEffort }) };
    } finally {
      if (abortPrompt) signal.removeEventListener("abort", abortPrompt);
      signal.removeEventListener("abort", abortLifecycle); lifecycle.abort(new Error("Shared DSH call settled"));
      // Public cancellation and disposal must reach quiescence before server
      // executor_stopped ACK; never clear capacity while native work is live.
      try { await handle?.dispose(); } catch { throw new SharedExecutorCleanupUnconfirmedError(); }
      for (const dispose of disposers.reverse()) dispose();
      if (this.#handle === handle) this.#handle = undefined;
    }
  }
  async close(): Promise<void> { this.#closed = true; this.#handle?.agent.cancel({ kind: "user" }); await this.#handle?.dispose(); }
}
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function context(value: unknown): Context { const object = record(value); if (typeof object?.get !== "function") throw new Error("DSH context is unavailable"); return value as Context; }

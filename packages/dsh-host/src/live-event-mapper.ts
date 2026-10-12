import { redactValue } from "@gatherthread/adapters";
import type { createLiveOutputPublisher, LiveOutputKind, LiveOutputState, LivePlanStep } from "@gatherthread/adapters";
import type { DshAssistantStreamFrame, DshLiveOutputEvent, DshSessionEventRecord } from "./types.js";

type Publisher = ReturnType<typeof createLiveOutputPublisher>;
interface Block { key: string; kind: LiveOutputKind; text: string; title?: string; callId?: string }
interface Attempt { turn: number; step: number; nextIndex: number; closed: boolean; failed: boolean; blocks: Map<number, Block> }
interface Tool { key: string; arguments: string; title?: string }
const MAX_ATTEMPTS = 64;
const MAX_BLOCKS = 128;
const MAX_TEXT = 96 * 1024;

/** A separate, explicitly shared live surface. The native-local upload
 * allowlist in event-mapper.ts is intentionally independent of this mapper.
 * Contracts verified against upstream d347e703 (0.1.3-alpha.1) and a66e4702
 * (0.1.2-rc.1): assistant frames, StreamChunk, tool/*, and todo/write.
 */
export function createDshLiveEventMapper(publisher: Publisher) {
  const attempts = new Map<string, Attempt>();
  const steps = new Map<string, Attempt>();
  const tools = new Map<string, Tool>();
  let revision = 0;
  const deliver = (operation: Promise<void>) => { void operation.catch(() => undefined); };
  const snapshot = (block: Block, state: LiveOutputState) =>
    deliver(publisher.onSnapshot(block.key, block.text, block.kind, block.title, state));
  const toolFor = (id: string, fallbackKey: string): Tool | undefined => {
    let tool = tools.get(id);
    if (tool === undefined && tools.size < MAX_BLOCKS) {
      tool = { key: fallbackKey, arguments: "" };
      tools.set(id, tool);
    }
    return tool;
  };
  const settle = (attempt: Attempt, state: LiveOutputState) => {
    if (state === "failed") attempt.failed = true;
    for (const block of attempt.blocks.values()) {
      if (block.kind !== "tool") snapshot(block, state);
      else if (state === "failed") {
        const argumentsText = block.callId === undefined ? undefined : tools.get(block.callId)?.arguments;
        deliver(publisher.onSnapshot(block.key, `Arguments:\n${argumentsText || "[Unparseable tool arguments]"}`,
          "tool", block.title, state));
      }
    }
  };
  const onFrame = (frame: DshAssistantStreamFrame): void => {
    if (frame.revision <= revision) return;
    const identity = frame.attemptId;
    if (frame.type === "start") {
      if (attempts.has(identity) || attempts.size >= MAX_ATTEMPTS) return;
      revision = frame.revision;
      const attempt: Attempt = { turn: frame.turn, step: frame.step, nextIndex: 0, closed: false, failed: false, blocks: new Map() };
      attempts.set(identity, attempt);
      steps.set(`${frame.turn}:${frame.step}`, attempt);
      return;
    }
    const attempt = attempts.get(identity);
    if (attempt === undefined || attempt.closed || frame.index !== attempt.nextIndex) return;
    revision = frame.revision;
    if (frame.type === "end") {
      attempt.closed = true;
      settle(attempt, attempt.failed || frame.outcome.kind === "abandoned" || frame.outcome.eventType === "assistant/attempt" ? "failed" : "completed");
      return;
    }
    attempt.nextIndex++;
    const chunk = object(frame.chunk);
    if (chunk?.type === "finish") {
      const reason = object(chunk.reason)?.kind ?? chunk.reason;
      if (reason === "error" || reason === "aborted") settle(attempt, "failed");
      return;
    }
    if (!integer(chunk?.index) || Number(chunk!.index) >= MAX_BLOCKS) return;
    const index = Number(chunk!.index);
    if (chunk!.type === "block-start") {
      const kind = chunk!.blockType === "text" ? "answer" : chunk!.blockType === "reasoning" ? "reasoning"
        : chunk!.blockType === "tool-call" ? "tool" : undefined;
      if (kind !== undefined && !attempt.blocks.has(index)) {
        attempt.blocks.set(index, { key: `${identity}:${index}`, kind, text: "" });
      }
      return;
    }
    const block = attempt.blocks.get(index);
    if (block === undefined) return;
    if ((chunk!.type === "text-delta" && block.kind === "answer")
      || (chunk!.type === "reasoning-delta" && block.kind === "reasoning")) {
      if (typeof chunk!.text !== "string") return;
      block.text = bound(block.text + chunk!.text);
      deliver(publisher.onDelta(block.key, chunk!.text, block.kind));
    } else if (chunk!.type === "tool-call-delta" && block.kind === "tool") {
      if (!identifier(chunk!.id) || typeof chunk!.argumentsDelta !== "string"
        || (block.callId !== undefined && block.callId !== chunk!.id)) return;
      block.callId = chunk!.id;
      if (typeof chunk!.name === "string") block.title = bound(chunk!.name).slice(0, 256);
      const tool = toolFor(block.callId, block.key);
      if (tool === undefined) return;
      block.key = tool.key;
      block.text = bound(block.text + chunk!.argumentsDelta);
      if (block.title !== undefined) tool.title = block.title;
      // Incomplete JSON has no reliable recursive sensitive-key boundary.
      // Keep arguments local until parsed, including fragmented Authorization
      // and refresh_token values that ordinary text patterns cannot classify.
      const argumentsText = parsedArguments(block.text);
      if (argumentsText !== undefined) tool.arguments = argumentsText;
      deliver(publisher.onSnapshot(block.key, argumentsText === undefined
        ? "Preparing tool arguments.\n" : `Arguments:\n${argumentsText}`, "tool", block.title));
    } else if (chunk!.type === "block-end") {
      const content = object(chunk!.block);
      if (((content?.type === "text" && block.kind === "answer")
        || (content?.type === "reasoning" && block.kind === "reasoning")) && typeof content!.text === "string") {
        block.text = bound(content!.text);
        snapshot(block, "completed");
      } else if (content?.type === "tool-call" && block.kind === "tool" && identifier(content.id)
        && typeof content.arguments === "string" && (block.callId === undefined || content.id === block.callId)) {
        const tool = toolFor(content.id, block.key);
        if (tool === undefined) return;
        block.callId = content.id; block.key = tool.key;
        block.text = publicArguments(content.arguments);
        if (typeof content.name === "string") block.title = content.name.slice(0, 256);
        tool.arguments = block.text;
        if (block.title !== undefined) tool.title = block.title;
        snapshot(block, "running");
      }
    }
  };
  const onDurable = (event: DshSessionEventRecord): void => {
    const data = object(event.data);
    if (data === undefined) return;
    if (event.type === "assistant/message" && integer(data.turn) && integer(data.step)) {
      const attempt = steps.get(`${data.turn}:${data.step}`);
      if (attempt !== undefined && data.interrupted === true) attempt.failed = true;
      const message = object(data.message);
      if (!Array.isArray(message?.content)) return;
      const nativeBlocks = [...attempt?.blocks.values() ?? []];
      for (const [index, value] of message.content.slice(0, MAX_BLOCKS).entries()) {
        const content = object(value);
        const kind = content?.type === "text" ? "answer" : content?.type === "reasoning" ? "reasoning" : undefined;
        if (kind !== undefined && typeof content!.text === "string") {
          const candidate = nativeBlocks[index];
          const key = candidate?.kind === kind ? candidate.key : `assistant:${event.seq}:${index}`;
          if (candidate?.kind === kind) candidate.text = bound(content!.text);
          deliver(publisher.onSnapshot(key, content!.text, kind, undefined, data.interrupted === true ? "failed" : "completed"));
        }
      }
    } else if (event.type === "assistant/attempt" && integer(data.turn) && integer(data.step)) {
      const attempt = steps.get(`${data.turn}:${data.step}`);
      if (attempt !== undefined) settle(attempt, "failed");
    } else if (event.type === "tool/call" && identifier(data.callId) && typeof data.name === "string" && typeof data.arguments === "string") {
      const tool = toolFor(data.callId, `tool:${event.seq}`);
      if (tool === undefined) return;
      tool.arguments = publicArguments(data.arguments); tool.title = data.name.slice(0, 256);
      deliver(publisher.onSnapshot(tool.key, `Arguments:\n${tool.arguments}`, "tool", tool.title));
    } else if (event.type === "tool/result") {
      const message = object(data.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      const wrapped = content.map(object).find((block) => block?.type === "tool-result");
      const id = wrapped?.toolCallId ?? message?.toolCallId;
      if (!identifier(id)) return;
      const tool = tools.get(id);
      if (tool === undefined) return;
      const blocks = wrapped === undefined ? content : wrapped.content;
      if (!Array.isArray(blocks)) return;
      const text = blocks.slice(0, MAX_BLOCKS).flatMap((value) => {
        const block = object(value);
        return block?.type === "text" && typeof block.text === "string" ? [bound(block.text)] : [];
      }).join("");
      const failed = wrapped?.isError === true || message?.isError === true || data.error !== undefined;
      deliver(publisher.onSnapshot(tool.key, `Arguments:\n${tool.arguments}\n\nResult:\n${bound(text)}`, "tool", tool.title, failed ? "failed" : "completed"));
    } else if (event.type === "todo/write" && Array.isArray(data.todos) && data.todos.length <= 64) {
      const plan: LivePlanStep[] = [];
      for (const value of data.todos) {
        const item = object(value);
        if (typeof item?.content !== "string" || !["pending", "in_progress", "completed"].includes(String(item.status))) return;
        plan.push({ step: item.content, status: item.status as LivePlanStep["status"] });
      }
      deliver(publisher.onPlan("plan", plan));
    }
  };
  return {
    onEvent(event: DshLiveOutputEvent) {
      if (event.kind === "assistant-stream") onFrame(event.frame);
      else onDurable(event.event);
    },
    async finish(success = true) { await publisher.finish(success); },
  };
}

/** Validate the actual upstream envelope; no guessed aliases or payload copy. */
export function parseDshAssistantStreamFrame(value: unknown): DshAssistantStreamFrame | undefined {
  const frame = object(value);
  if (!identifier(frame?.attemptId) || !integer(frame?.revision) || Number(frame!.revision) < 1) return undefined;
  const shared = { attemptId: frame!.attemptId, revision: Number(frame!.revision) };
  if (frame!.type === "start" && integer(frame!.turn) && integer(frame!.step)) {
    return { type: "start", ...shared, turn: Number(frame!.turn), step: Number(frame!.step) };
  }
  if (frame!.type === "chunk" && integer(frame!.index) && integer(frame!.time) && object(frame!.chunk) !== undefined) {
    return { type: "chunk", ...shared, index: Number(frame!.index), time: Number(frame!.time), chunk: frame!.chunk };
  }
  const outcome = object(frame!.outcome);
  if (frame!.type === "end" && integer(frame!.index)) {
    if (outcome?.kind === "abandoned") return { type: "end", ...shared, index: Number(frame!.index), outcome: { kind: "abandoned" } };
    if (outcome?.kind === "committed" && integer(outcome.seq)
      && (outcome.eventType === "assistant/message" || outcome.eventType === "assistant/attempt")) {
      return { type: "end", ...shared, index: Number(frame!.index), outcome: { kind: "committed", eventType: outcome.eventType, seq: Number(outcome.seq) } };
    }
  }
  return undefined;
}
function publicArguments(text: string): string {
  return parsedArguments(text) ?? "[Unparseable tool arguments]";
}
function parsedArguments(text: string): string | undefined {
  if (text.length > MAX_TEXT) return undefined;
  try { return JSON.stringify(redactValue(JSON.parse(text))); }
  catch { return undefined; }
}
function bound(text: string): string { return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[TRUNCATED]` : text; }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function identifier(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512; }
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

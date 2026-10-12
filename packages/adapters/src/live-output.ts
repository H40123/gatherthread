import { randomUUID } from "node:crypto";
import { redactText, type RedactionOptions } from "./redaction.js";

export type LiveOutputKind = "answer" | "reasoning" | "tool" | "plan";
export type LiveOutputState = "running" | "completed" | "failed";
export interface LivePlanStep { step: string; status: "pending" | "in_progress" | "completed" }
export interface LiveOutputUpdate {
  id: string; content: string; phase: "stream"; streamId: string;
  streamMode: "snapshot"; streamKind: LiveOutputKind; streamRevision: number;
  streamState: LiveOutputState; title?: string; plan?: LivePlanStep[];
}
export interface LiveOutputPublisherOptions {
  publish: (update: LiveOutputUpdate) => Promise<boolean | void> | boolean | void;
  now?: () => number; intervalMs?: number; schedule?: boolean; redaction?: RedactionOptions;
}
interface Item {
  streamId: string; raw: string; kind: LiveOutputKind; state: LiveOutputState;
  revision: number; acknowledged: string; title?: string; plan?: LivePlanStep[];
  dirty: boolean; truncated: boolean;
  pending?: { update: LiveOutputUpdate; signature: string };
}
const MAX_ITEMS = 128;
const MAX_INPUT_BYTES = 96 * 1024;
const MAX_PUBLIC_BYTES = 24 * 1024;
const MAX_PUBLICATIONS = 1200;

/** Only explicitly shared, current native work enters this per-request publisher.
 * Cumulative snapshots make replay/idempotency safe across interleaved items.
 * An unfinished credential-shaped ASCII token is held back: a split credential must never enter
 * immutable history before a subsequent fragment identifies it as a credential.
 */
export function createLiveOutputPublisher(options: LiveOutputPublisherOptions) {
  const items = new Map<string, Item>();
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 1500;
  let lastPublished: number | undefined, publications = 0, closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();
  let lastVisited: Item | undefined;
  const serial = (operation: () => Promise<void>) => {
    queue = queue.then(operation, operation);
    return queue;
  };
  const itemFor = (key: string, kind: LiveOutputKind, title?: string) => {
    let item = items.get(key);
    if (!item && items.size < MAX_ITEMS) {
      item = { streamId: randomUUID(), raw: "", kind, state: "running", revision: 0,
        acknowledged: "", dirty: true, truncated: false };
      items.set(key, item);
    }
    if (item && title !== undefined) item.title = bound(redactText(title, options.redaction), 256);
    return item;
  };
  const safe = (item: Item) => {
    let content = item.raw;
    // Shared redaction also masks complete or abandoned private PEM blocks.
    if (item.state === "running") {
      // Keep a trailing word, quoted JSON value, or assignment until its boundary
      // is known. Structured tool arguments are also redacted before stringifying.
      content = content.replace(/(?:\bBearer\s+|\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)["']?\s*[=:]\s*["']?)[^\n,;]*$/giu, "");
      // A backward scan is linear even for large tool output. CJK text does not
      // need a whitespace boundary; holding every non-space character would
      // hide an entire Chinese answer until the native turn completed.
      let end = content.length;
      while (end > 0 && /[A-Za-z0-9_./~+=:@%\-]/u.test(content[end - 1]!)) end--;
      content = content.slice(0, end);
    }
    content = redactText(content, options.redaction);
    return bound(content, MAX_PUBLIC_BYTES, item.truncated);
  };
  const signatureFor = (item: Item) => JSON.stringify([safe(item), item.state, item.title, item.plan]);
  const schedule = () => {
    if (closed || options.schedule === false || timer || ![...items.values()].some((x) => x.dirty)) return;
    timer = setTimeout(() => { timer = undefined; void flush().catch(() => undefined); }, intervalMs);
    timer.unref();
  };
  const publishOne = async (item: Item) => {
    if (!item.dirty || publications >= MAX_PUBLICATIONS) return;
    const content = safe(item);
    const signature = JSON.stringify([content, item.state, item.title, item.plan]);
    if (!item.pending && signature === item.acknowledged) { item.dirty = false; return; }
    if (!item.pending && !content.trim() && item.plan === undefined) return;
    const revision = item.revision + 1;
    const update: LiveOutputUpdate = { id: `${item.streamId}:${revision}`, content, phase: "stream",
      streamId: item.streamId, streamMode: "snapshot", streamKind: item.kind,
      streamRevision: revision, streamState: item.state,
      ...(item.title === undefined ? {} : { title: item.title }),
      ...(item.plan === undefined ? {} : { plan: item.plan }) };
    item.pending ??= { update, signature };
    const pending = item.pending;
    try {
      if (await options.publish(pending.update) === false) return;
      // Only an acknowledged upload advances revision/time or clears pending work.
      item.revision = pending.update.streamRevision; item.acknowledged = pending.signature;
      delete item.pending; item.dirty = signatureFor(item) !== item.acknowledged;
      lastPublished = now(); publications++;
    } catch { /* supplementary progress retries without stranding the final answer */ }
  };
  const flush = () => serial(async () => {
    if (closed || (lastPublished !== undefined && now() - lastPublished < intervalMs)) { schedule(); return; }
    const ordered = [...items.values()];
    const start = lastVisited === undefined ? 0 : (ordered.indexOf(lastVisited) + 1) % ordered.length;
    // Rotate across dirty items so a continuously growing answer cannot keep
    // the real plan and tool results waiting until the turn finishes.
    for (let offset = 0; offset < ordered.length; offset++) {
      const item = ordered[(start + offset) % ordered.length]!;
      if (!item.dirty) continue;
      lastVisited = item;
      await publishOne(item);
      if (lastPublished !== undefined && now() - lastPublished < intervalMs) break;
    }
    schedule();
  });
  return {
    async onDelta(key: string, delta: string, kind: LiveOutputKind = "answer", title?: string) {
      if (closed || !delta) return;
      const item = itemFor(key, kind, title);
      if (!item || item.state !== "running" || item.truncated) return;
      const raw = item.raw + delta;
      item.raw = bound(raw, MAX_INPUT_BYTES); item.truncated = Buffer.byteLength(raw) > MAX_INPUT_BYTES;
      item.dirty = true; await flush();
    },
    async onSnapshot(key: string, text: string, kind: LiveOutputKind = "answer", title?: string, state: LiveOutputState = "running") {
      if (closed) return;
      const item = itemFor(key, kind, title);
      if (!item) return;
      item.raw = bound(text, MAX_INPUT_BYTES); item.truncated = Buffer.byteLength(text) > MAX_INPUT_BYTES;
      item.state = state; item.dirty = true; await flush();
    },
    async onPlan(key: string, steps: readonly LivePlanStep[]) {
      if (closed) return;
      const item = itemFor(key, "plan");
      if (!item) return;
      item.plan = steps.slice(0, 64).map((step) => ({ step: bound(redactText(step.step, options.redaction), 512), status: step.status }));
      item.raw = item.plan.map((step) => `${step.status}: ${step.step}`).join("\n");
      item.dirty = true; await flush();
    },
    flush,
    async finish(success = true) {
      if (timer) { clearTimeout(timer); timer = undefined; }
      await serial(async () => {
        if (closed) return;
        for (const item of [...items.values()].slice(0, 64)) {
          if (item.state === "running") { item.state = success ? "completed" : "failed"; item.dirty = true; }
          await publishOne(item);
          // Resolve an already in-flight revision before the terminal snapshot.
          if (item.dirty && !item.pending) await publishOne(item);
        }
        closed = true; items.clear();
      });
    },
    lastPublishedAt: () => lastPublished,
  };
}

export function liveOutputPayload(update: LiveOutputUpdate) {
  return { content: update.content, phase: update.phase, stream_id: update.streamId,
    stream_mode: update.streamMode, stream_kind: update.streamKind, stream_revision: update.streamRevision,
    stream_state: update.streamState, ...(update.title === undefined ? {} : { title: update.title }),
    ...(update.plan === undefined ? {} : { plan: update.plan.map(step => ({ step: step.step, status: step.status })) }) };
}

function bound(text: string, maxBytes: number, alreadyTruncated = false): string {
  if (!alreadyTruncated && Buffer.byteLength(text) <= maxBytes) return text;
  const suffix = "\n[TRUNCATED]";
  const bytes = Buffer.from(text).subarray(0, maxBytes - Buffer.byteLength(suffix));
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1]! & 0xc0) === 0x80) end--;
  if (end < bytes.length || (bytes[end - 1]! & 0x80) !== 0) end = Math.max(0, end - 1);
  return bytes.subarray(0, end).toString("utf8") + suffix;
}

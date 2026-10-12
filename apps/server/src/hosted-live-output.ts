import { StringDecoder } from "node:string_decoder";
import { createLiveOutputPublisher, type LiveOutputKind, type LiveOutputState, type LiveOutputUpdate, type LivePlanStep } from "@gatherthread/adapters";

// Private OCI stdout contract, paired with ops/hosted-agent/live-output.mjs.
// This is not an HTTP/WebSocket or canonical-event payload.
const PREFIX = "GT_HOSTED_PROGRESS:";
const MAX_LINE_BYTES = 64_000;
export interface HostedContainerProgress {
  version: 1; item_id: string; kind: LiveOutputKind; content: string;
  state: LiveOutputState; title?: string; plan?: LivePlanStep[];
}
export type HostedProgressCallback = (progress: HostedContainerProgress) => void;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && Buffer.byteLength(value) <= maximum;

function progressFrame(value: unknown): HostedContainerProgress | undefined {
  if (!record(value) || Object.keys(value).some((key) => !["version", "item_id", "kind", "content", "state", "title", "plan"].includes(key))
    || value.version !== 1 || typeof value.item_id !== "string" || !/^item-[1-9][0-9]{0,2}$/u.test(value.item_id)
    || Number(value.item_id.slice(5)) > 128 || !["answer", "reasoning", "tool", "plan"].includes(String(value.kind))
    || !["running", "completed", "failed"].includes(String(value.state)) || !text(value.content, 48_000)
    || value.title !== undefined && !text(value.title, 512)) return;
  if (value.plan !== undefined && (!Array.isArray(value.plan) || value.plan.length > 64 || value.plan.some((step) => !record(step)
    || Object.keys(step).some((key) => !["step", "status"].includes(key)) || !text(step.step, 512)
    || !["pending", "in_progress", "completed"].includes(String(step.status))))) return;
  if (value.kind === "plan" && !Array.isArray(value.plan) || value.kind !== "plan" && value.plan !== undefined) return;
  return value as unknown as HostedContainerProgress;
}

/** Separate progress from the final legacy JSON without retaining raw telemetry
 * in a process result or diagnostic. UTF-8 and tags may cross stdout chunks.
 */
export function createHostedContainerOutputDecoder(onProgress?: HostedProgressCallback, progressLimit = 256_000) {
  const decoder = new StringDecoder("utf8");
  let pending = "", result = "", final = false, dropping = false;
  let resultBytes = 0, progressBytes = 0;
  const appendResult = (chunk: string) => { result += chunk; resultBytes += Buffer.byteLength(chunk); };
  const emit = (line: string) => {
    const bytes = Buffer.byteLength(line) + 1;
    progressBytes += bytes;
    if (bytes > MAX_LINE_BYTES || progressBytes > progressLimit) return;
    try {
      const progress = progressFrame(JSON.parse(line.slice(PREFIX.length)));
      if (progress) onProgress?.(progress);
    } catch { /* supplementary progress cannot strand a completed result */ }
  };
  const consume = (chunk: string) => {
    if (final) { appendResult(chunk); return; }
    pending += chunk;
    for (;;) {
      if (dropping) {
        const newline = pending.indexOf("\n");
        if (newline === -1) { pending = ""; return; }
        pending = pending.slice(newline + 1); dropping = false;
      }
      if (!pending) return;
      if (!pending.startsWith(PREFIX)) {
        if (PREFIX.startsWith(pending)) return;
        final = true; appendResult(pending); pending = ""; return;
      }
      const newline = pending.indexOf("\n");
      if (newline === -1) {
        if (Buffer.byteLength(pending) > MAX_LINE_BYTES) { pending = ""; dropping = true; }
        return;
      }
      emit(pending.slice(0, newline).replace(/\r$/u, ""));
      pending = pending.slice(newline + 1);
    }
  };
  return {
    write(chunk: Buffer | string) { consume(typeof chunk === "string" ? chunk : decoder.write(chunk)); },
    resultBytes: () => resultBytes,
    finish() {
      consume(decoder.end());
      if (!dropping && pending) {
        if (pending.startsWith(PREFIX)) emit(pending);
        else appendResult(pending);
      }
      pending = "";
      return result;
    },
  };
}

export function hostedContainerResult(output: string, onProgress?: HostedProgressCallback, progressLimit = 256_000): string {
  const decoder = createHostedContainerOutputDecoder(onProgress, progressLimit);
  decoder.write(output);
  return decoder.finish();
}

/** Canonical publication owns redaction, opaque IDs, throttling, and ACKs. The
 * private native snapshots are never logged or persisted as runner output.
 */
export function createHostedLiveOutputConsumer(publish: (update: LiveOutputUpdate) => boolean | void | Promise<boolean | void>) {
  let accepting = true;
  const publisher = createLiveOutputPublisher({ publish: (update) => accepting ? publish(update) : false });
  return {
    accept: ((progress) => {
      if (!accepting || !progressFrame(progress)) return;
      const operation = progress.kind === "plan" ? publisher.onPlan(progress.item_id, progress.plan ?? [])
        : publisher.onSnapshot(progress.item_id, progress.content, progress.kind, progress.title, progress.state);
      void operation.catch(() => undefined);
    }) satisfies HostedProgressCallback,
    async finish(success = true) {
      if (!success) accepting = false;
      await publisher.finish();
      accepting = false;
    },
  };
}

import { randomUUID } from "node:crypto";

/**
 * Turns a harness's incremental public output into bounded `agent_progress`
 * publications.
 *
 * Two server constraints shape this module. A claim lease is renewed only by
 * accepted progress, and the per-device write budget is finite, so native
 * fragments cannot be republished one token at a time. And a progress payload
 * past its own size cap is replaced wholesale by a truncation envelope, so a
 * single publication must never grow without bound.
 *
 * An instance is scoped to one turn: its item identities are native and mean
 * nothing outside the turn that produced them. Only text the harness already
 * treats as public reaches this module — hidden reasoning has no path in.
 */

export interface AgentStreamChunk {
  readonly id: string;
  readonly content: string;
  readonly phase: "stream";
  readonly streamId: string;
}

export interface AgentOutputStreamOptions {
  readonly publish: (chunk: AgentStreamChunk) => Promise<void> | void;
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly maxChunkBytes?: number;
  readonly maxFlushChunks?: number;
  readonly newStreamId?: () => string;
}

export interface AgentOutputStream {
  /** Buffer one native fragment, publishing on the caller's behalf when due. */
  onDelta(itemId: string, delta: string): Promise<void>;
  /**
   * Close a native item and flush what is left of it. Resolves to every byte of
   * public text this item published, or `undefined` when the item never
   * streamed at all. A caller compares that with the item's own completed text
   * and publishes it separately when the stream did not carry all of it.
   */
  onItemCompleted(itemId: string): Promise<string | undefined>;
  /** Flush every open item so a finished turn leaves nothing buffered. */
  onTurnSettled(): Promise<void>;
  /** When this stream last published, for callers that owe a silence heartbeat. */
  lastPublishedAt(): number | undefined;
}

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_MAX_CHUNK_BYTES = 8 * 1_024;
/**
 * A closing item may publish more than one chunk, but not without bound: past
 * this the completed item's own text is the cheaper complete copy, and the
 * caller publishes that instead.
 */
const DEFAULT_MAX_FLUSH_CHUNKS = 8;

interface BufferedStream {
  readonly streamId: string;
  chunks: number;
  pending: string;
  streamed: string;
  lastPublishedAt: number | undefined;
  completed: boolean;
}

export function createAgentOutputStream(options: AgentOutputStreamOptions): AgentOutputStream {
  const publish = options.publish;
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  const maxFlushChunks = options.maxFlushChunks ?? DEFAULT_MAX_FLUSH_CHUNKS;
  const newStreamId = options.newStreamId ?? (() => randomUUID());
  const streams = new Map<string, BufferedStream>();

  function bufferFor(itemId: string): BufferedStream {
    const open = streams.get(itemId);
    if (open !== undefined && !open.completed) return open;
    // A native item that speaks again after completing is new output, not a
    // continuation: it gets a fresh identity so the reader never merges two
    // separate messages into one growing bubble.
    const created: BufferedStream = {
      streamId: newStreamId(),
      chunks: 0,
      pending: "",
      streamed: "",
      lastPublishedAt: undefined,
      completed: false,
    };
    streams.set(itemId, created);
    return created;
  }

  /** Resolves whether everything buffered now has been published. */
  async function flush(buffer: BufferedStream): Promise<boolean> {
    // Whitespace alone is not worth a canonical event, but discarding it would
    // corrupt the reader's merged view, so it stays buffered for the next word.
    if (!buffer.pending.trim()) return true;
    const [head, rest] = takeUtf8Head(buffer.pending, maxChunkBytes);
    if (!head) return false;
    buffer.pending = rest;
    buffer.streamed += head;
    buffer.chunks += 1;
    buffer.lastPublishedAt = now();
    await publish({
      id: `${buffer.streamId}:${String(buffer.chunks)}`,
      content: head,
      phase: "stream",
      streamId: buffer.streamId,
    });
    return rest === "";
  }

  async function drain(buffer: BufferedStream): Promise<void> {
    for (let chunk = 0; chunk < maxFlushChunks; chunk += 1) {
      if (await flush(buffer)) return;
    }
  }

  return {
    async onDelta(itemId, delta) {
      if (delta === "") return;
      const buffer = bufferFor(itemId);
      buffer.pending += delta;
      if (buffer.lastPublishedAt !== undefined && now() - buffer.lastPublishedAt < intervalMs) return;
      await flush(buffer);
    },
    async onItemCompleted(itemId) {
      const buffer = streams.get(itemId);
      if (buffer === undefined) return undefined;
      await drain(buffer);
      buffer.completed = true;
      return buffer.streamed;
    },
    async onTurnSettled() {
      for (const buffer of streams.values()) {
        if (buffer.completed) continue;
        await drain(buffer);
        buffer.completed = true;
      }
    },
    lastPublishedAt() {
      let latest: number | undefined;
      for (const buffer of streams.values()) {
        if (buffer.lastPublishedAt === undefined) continue;
        latest = latest === undefined ? buffer.lastPublishedAt : Math.max(latest, buffer.lastPublishedAt);
      }
      return latest;
    },
  };
}

/** Split at a character boundary: a progress payload must never carry half a character. */
function takeUtf8Head(value: string, maxBytes: number): [head: string, rest: string] {
  if (Buffer.byteLength(value) <= maxBytes) return [value, ""];
  let head = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    head += character;
    bytes += size;
  }
  return [head, value.slice(head.length)];
}

// Private OpenCode 1.18.32 loopback events. Only this job's native display fields
// leave the container; the server redacts them before canonical persistence.
import { StringDecoder } from "node:string_decoder";
export const HOSTED_PROGRESS_PREFIX = "GT_HOSTED_PROGRESS:";
const MAX_ITEMS = 128;
const MAX_TEXT_BYTES = 48_000;
const TOOLS = new Set(["bash", "read", "write", "edit", "apply_patch", "patch", "glob", "grep", "list", "ls", "todowrite", "todoread", "skill"]);
const STATUSES = new Set(["pending", "in_progress", "completed"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value) => typeof value === "string" && value.length <= 256 && /^[A-Za-z0-9_-]+$/u.test(value);

function bounded(text, limit = MAX_TEXT_BYTES) {
  if (typeof text !== "string") return "";
  if (Buffer.byteLength(text) <= limit) return text;
  // Drop the cut lexical token so truncation cannot turn a complete credential
  // into an unrecognizable prefix before the server's cumulative redaction.
  const prefix = new StringDecoder("utf8").write(Buffer.from(text).subarray(0, limit - 64));
  let boundary = prefix.length;
  while (boundary > 0 && /[!-~]/u.test(prefix[boundary - 1])) boundary--;
  return prefix.slice(0, boundary) + "\n[TRUNCATED]";
}

export function createHostedProgressWriter({ write = (line) => process.stdout.write(line), maxBytes = 256_000 } = {}) {
  let bytes = 0;
  return (progress) => {
    const line = HOSTED_PROGRESS_PREFIX + JSON.stringify({ version: 1, ...progress }) + "\n";
    const size = Buffer.byteLength(line);
    if (size > 64_000 || bytes + size > maxBytes) return;
    bytes += size;
    write(line);
  };
}

/** Map only assistant parts from the exact newly-created session. Native IDs,
 * metadata, provider headers, signatures, system/user text and attachments stay
 * private. Deltas update known text/reasoning parts; full snapshots reconcile.
 */
export function createOpencodeLiveOutput(sessionId, send, { now = Date.now, intervalMs = 200 } = {}) {
  const messages = new Map();
  const parts = new Map();
  const items = new Map();
  let nextItem = 0, lastSent, timer, closed = false;
  const itemFor = (key) => {
    if (!items.has(key) && items.size < MAX_ITEMS) items.set(key, { item_id: `item-${++nextItem}`, dirty: false });
    return items.get(key);
  };
  const flush = (force = false) => {
    if (closed || !force && lastSent !== undefined && now() - lastSent < intervalMs) return;
    for (const item of items.values()) {
      if (!item.dirty) continue;
      const { dirty: _dirty, signature: _signature, ...progress } = item;
      try { send(progress); } catch { /* progress never determines completion */ }
      item.dirty = false;
      lastSent = now();
    }
  };
  const update = (key, value) => {
    const item = itemFor(key);
    if (!item || closed) return;
    const signature = JSON.stringify(value);
    if (signature === item.signature) return;
    Object.assign(item, value, { signature, dirty: true });
    flush();
    if (!timer && [...items.values()].some((item) => item.dirty)) {
      timer = setTimeout(() => { timer = undefined; flush(true); }, intervalMs);
      timer.unref();
    }
  };
  const own = (properties, value = properties) => properties.sessionID === sessionId && value.sessionID === sessionId;
  const acceptInfo = (properties) => {
    const info = properties.info;
    if (!object(info) || !own(properties, info) || !identifier(info.id) || messages.size >= MAX_ITEMS && !messages.has(info.id)) return;
    messages.set(info.id, info.role === "assistant" && info.summary !== true);
  };
  const renderPart = (part) => {
    const completed = Number.isFinite(part.time?.end);
    if (part.type === "text" || part.type === "reasoning") {
      if (part.synthetic || part.ignored || typeof part.text !== "string") return;
      update(part.id, { kind: part.type === "text" ? "answer" : "reasoning", content: bounded(part.text), state: completed ? "completed" : "running" });
      return;
    }
    if (part.type !== "tool" || !TOOLS.has(part.tool) || !object(part.state)) return;
    const state = part.state;
    if (!["pending", "running", "completed", "error"].includes(state.status)) return;
    // These are the plain display fields shown by OpenCode, not its raw input,
    // arbitrary metadata, tool attachments or native call identifiers.
    const title = bounded(typeof state.title === "string" && state.title.trim() ? state.title : part.tool, 512);
    const result = state.status === "completed" ? state.output : state.status === "error" ? state.error
      : part.tool === "bash" ? state.metadata?.output : undefined;
    update(part.id, { kind: "tool", title, content: bounded(typeof result === "string" && result.trim() ? result : title),
      state: state.status === "completed" ? "completed" : state.status === "error" ? "failed" : "running" });
  };
  const acceptPart = (properties) => {
    const part = properties.part;
    if (!object(part) || !own(properties, part) || !identifier(part.id) || !identifier(part.messageID)
      || messages.get(part.messageID) !== true || parts.size >= MAX_ITEMS && !parts.has(part.id)) return;
    if (parts.has(part.id) && parts.get(part.id).messageID !== part.messageID) return;
    if (!["text", "reasoning", "tool"].includes(part.type)) return;
    const saved = { id: part.id, sessionID: sessionId, messageID: part.messageID, type: part.type,
      ...(typeof part.text === "string" ? { text: bounded(part.text) } : {}),
      ...(part.synthetic ? { synthetic: true } : {}), ...(part.ignored ? { ignored: true } : {}),
      ...(Number.isFinite(part.time?.end) ? { time: { end: part.time.end } } : {}),
      ...(part.type === "tool" ? { tool: part.tool, state: { status: part.state?.status,
        title: bounded(part.state?.title, 512), output: bounded(part.state?.output), error: bounded(part.state?.error),
        ...(part.tool === "bash" && typeof part.state?.metadata?.output === "string"
          ? { metadata: { output: bounded(part.state.metadata.output) } } : {}) } } : {}) };
    parts.set(part.id, saved);
    renderPart(saved);
  };
  const accept = (event) => {
    if (closed || !object(event) || !object(event.properties)) return;
    const properties = event.properties;
    if (event.type === "message.updated") acceptInfo(properties);
    else if (event.type === "message.part.updated") acceptPart(properties);
    else if (event.type === "message.part.delta") {
      const part = parts.get(properties.partID);
      if (properties.sessionID !== sessionId || properties.field !== "text" || typeof properties.delta !== "string"
        || !part || part.messageID !== properties.messageID || messages.get(part.messageID) !== true
        || !["text", "reasoning"].includes(part.type) || typeof part.text !== "string" || part.text.endsWith("[TRUNCATED]")) return;
      part.text = bounded(part.text + properties.delta);
      renderPart(part);
    } else if (event.type === "todo.updated") {
      if (properties.sessionID !== sessionId || !Array.isArray(properties.todos) || properties.todos.length > 64
        || properties.todos.some((todo) => !object(todo) || typeof todo.content !== "string" || !STATUSES.has(todo.status))) return;
      const plan = properties.todos.map((todo) => ({ step: bounded(todo.content, 512), status: todo.status }));
      update("todos", { kind: "plan", content: "", state: "running", plan });
    }
  };
  return {
    accept,
    reconcile(reply) {
      if (!object(reply) || !object(reply.info) || reply.info.sessionID !== sessionId || reply.info.role !== "assistant" || !Array.isArray(reply.parts)) return;
      acceptInfo({ sessionID: sessionId, info: reply.info });
      for (const part of reply.parts) acceptPart({ sessionID: sessionId, part });
      flush(true);
    },
    flush: () => flush(true),
    close() { if (timer) clearTimeout(timer); flush(true); closed = true; parts.clear(); messages.clear(); items.clear(); },
  };
}

/** Bounded SSE reader. Telemetry failure cannot accept a partial final answer or
 * replace the runner's completed-message, idle, and confirmed-exit checks.
 */
export async function subscribeOpencodeLiveOutput({ fetchResponse, origin, workspace, sessionId, send, signal, outputLimit }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let response;
  try {
    response = await fetchResponse(`${origin}/event`, { method: "GET", redirect: "error",
      headers: { accept: "text/event-stream", "x-opencode-directory": workspace },
      signal: AbortSignal.any([signal, controller.signal]) });
  } finally { clearTimeout(timeout); }
  if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "text/event-stream" || !response.body) {
    controller.abort();
    throw new Error("agent_progress_unavailable");
  }
  const reader = response.body.getReader();
  const mapper = createOpencodeLiveOutput(sessionId, send);
  const drain = (async () => {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const totalLimit = Math.max(256_000, 4 * outputLimit);
    const frameLimit = Math.min(256_000, totalLimit);
    let total = 0, line = "", data = [], frameBytes = 0, frames = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > totalLimit) throw new Error("agent_progress_limit");
      line += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = line.indexOf("\n")) !== -1) {
        const entry = line.slice(0, newline).replace(/\r$/u, "");
        line = line.slice(newline + 1);
        frameBytes += Buffer.byteLength(entry);
        if (frameBytes > frameLimit) throw new Error("agent_progress_limit");
        if (!entry) {
          if (data.length) {
            if (++frames > 4096) throw new Error("agent_progress_limit");
            try { mapper.accept(JSON.parse(data.join("\n"))); } catch { /* unsupported event */ }
          }
          data = []; frameBytes = 0;
        } else if (entry.startsWith("data:")) data.push(entry.slice(5).replace(/^ /u, ""));
      }
      if (Buffer.byteLength(line) > frameLimit) throw new Error("agent_progress_limit");
    }
  })().catch(() => undefined).finally(() => { controller.abort(); void reader.cancel().catch(() => undefined); });
  return {
    reconcile: (reply) => mapper.reconcile(reply),
    async stop() {
      controller.abort();
      mapper.close();
      // Progress teardown has its own finite window and never postpones the
      // separate confirmed shutdown of the owned OpenCode process.
      let timer;
      await Promise.race([Promise.all([reader.cancel().catch(() => undefined), drain]),
        new Promise((resolve) => { timer = setTimeout(resolve, 1000); })]);
      clearTimeout(timer);
    },
  };
}

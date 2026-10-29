import { createHash, randomUUID } from "node:crypto";
import { PreferencesJsonSchema, PreferencesConfigurationSchema, readConfigurationJson,
  AGENT_TEAM_CONFIG_JSON_SCHEMA, AgentTeamConfigSchema } from "@gatherthread/protocol";
import { redactText, redactValue } from "@gatherthread/adapters";
import { parseHistoryContext, validateContextReadInput } from "@gatherthread/bridge";
import { AgentSharesResponseSchema, SharedAgentRequestInputSchema, SharedAgentRequestAcceptedSchema,
  AgentShareJobResponseSchema, IdSchema, type AgentShare, type SharedAgentRequestInput } from "@gatherthread/protocol";
import type {
  CollaborationApi,
  LocalConversationSyncControl,
  RuntimeRegistration,
} from "@gatherthread/bridge";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface CollaborationMcpServiceOptions {
  api: CollaborationApi;
  serverName?: string;
  serverVersion?: string;
  allowProviderRequestCapture?: boolean;
  toolProfile?: "user" | "runtime";
  localSync?: LocalConversationSyncControl;
}

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const MUTATING_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const USER_TOOL_DEFINITIONS = [
  tool("collaboration_get_configuration_schema", "Read the versioned JSON schema for GatherThread preferences or Agent Team drafts. This does not read saved/private settings or change anything.", {
    kind: enumSchema(["preferences", "agent-team"]),
  }, ["kind"], { ...READ_ONLY_TOOL_ANNOTATIONS, openWorldHint: false }),
  tool("collaboration_validate_configuration", "Validate a proposed JSON file before returning it to the user. Does not save, authorize, enable or execute anything. Return a json fenced block for the user's preview/import action.", {
    json: { ...stringSchema("Complete versioned JSON configuration document, at most 128 KiB"), maxLength: 131072 },
  }, ["json"], { ...READ_ONLY_TOOL_ANNOTATIONS, openWorldHint: false }),
  tool("collaboration_list_projects", "List collaboration projects visible to the authenticated user", {}),
  tool("collaboration_list_project_sessions", "List sessions in one visible collaboration project", {
    project_id: stringSchema("Project identifier"),
  }, ["project_id"]),
  tool("collaboration_list_sessions", "List collaboration sessions visible to the authenticated user", {}),
  tool("collaboration_read_history", "Read current canonical session envelopes after a durable server sequence, including safe deletion placeholders and content revision; erased bodies cannot be recovered. Use collaboration_read_context for a summary-aware public context view", {
    session_id: stringSchema("Session identifier"),
    after_sequence: integerSchema("Return events after this sequence", 0),
    limit: integerSchema("Maximum events to return", 1),
  }, ["session_id"]),
  tool("collaboration_read_context", "Read public session context using this user's project context policy (default summary), or explicitly choose summary or original. Both exclude deleted messages and invalidated summaries and include content_revision. Summary replaces covered messages with valid completed summaries and source_event_ids; no Agent run is triggered. This read alone does not remove already-injected native context. Use collaboration_read_history for current canonical envelopes and pagination", {
    session_id: { ...stringSchema("Session identifier"), minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
    view: { ...enumSchema(["summary", "original"]), description: "Optional override; omit to follow your project context policy" },
  }, ["session_id"]),
  tool("collaboration_append_chat", "Append human chat without triggering an agent", {
    session_id: stringSchema("Session identifier"),
    content: stringSchema("Visible chat content"),
    idempotency_key: idempotencySchema(),
    reply_to: stringSchema("Optional event ID being replied to"),
  }, ["session_id", "content", "idempotency_key"], MUTATING_TOOL_ANNOTATIONS),
  tool("collaboration_request_agent", "Mutating remote operation that requests an Agent run and may consume compute or other resources. Pass the captured content_revision used to prepare the request; required after any deletion. Do not replace a stale pin to retry old text", {
    session_id: stringSchema("Session identifier"),
    content: stringSchema("Visible agent request"),
    idempotency_key: idempotencySchema(),
    reply_to: stringSchema("Optional event ID being replied to"),
    content_revision: integerSchema("Captured content_revision from the context/history used to prepare this request; do not refresh it when retrying", 0),
  }, ["session_id", "content", "idempotency_key"], MUTATING_TOOL_ANNOTATIONS),
  tool("collaboration_get_connection_status", "Show sanitized connector presence for sessions in one visible project", {
    project_id: stringSchema("Project identifier"),
  }, ["project_id"]),
  tool("collaboration_get_local_sync_status", "Show automatic and pending local-upload status for one bound conversation", {
    session_id: stringSchema("Session identifier"),
  }, ["session_id"]),
  tool("collaboration_set_local_auto_upload", "Enable or disable automatic upload for one local conversation", {
    session_id: stringSchema("Session identifier"),
    enabled: { type: "boolean" },
  }, ["session_id", "enabled"], MUTATING_TOOL_ANNOTATIONS),
  tool("collaboration_upload_local_turns", "Manually discover and upload completed local turns, including turns missed by Hooks", {
    session_id: stringSchema("Session identifier"),
  }, ["session_id"], MUTATING_TOOL_ANNOTATIONS),
  tool("collaboration_import_codex_history", "Create a new Desktop-visible Codex task containing a verified shared-history snapshot; the user archives old tasks manually. Realtime context injection remains active", {
    session_id: stringSchema("Session identifier"),
  }, ["session_id"], { ...MUTATING_TOOL_ANNOTATIONS, idempotentHint: false }),
] as const;

const RUNTIME_TOOL_DEFINITIONS = [
  tool("collaboration_register_runtime", "Register a local Codex or Claude Code runtime", {
    session_id: stringSchema("Session identifier"),
    device_id: stringSchema("Stable local device identifier"),
    harness: enumSchema(["codex", "claude-code"]),
    provider: stringSchema("Provider name"),
    model: stringSchema("Model name"),
    local_session_id: stringSchema("Local harness session identifier"),
    capture_fidelity: enumSchema(["canonical_history", "harness_transcript", "provider_request"]),
    capabilities: { type: "array", items: { type: "string" } },
  }, ["session_id", "device_id", "harness", "provider", "model", "local_session_id", "capture_fidelity"], MUTATING_TOOL_ANNOTATIONS),
  tool("collaboration_claim_agent_request", "Claim an eligible agent request for a registered runtime", {
    session_id: stringSchema("Session identifier"),
    request_id: stringSchema("Agent request event ID"),
    runtime_id: stringSchema("Registered runtime ID"),
  }, ["session_id", "request_id", "runtime_id"], MUTATING_TOOL_ANNOTATIONS),
  tool("collaboration_complete_agent_request", "Complete a claimed request with one canonical agent response", {
    session_id: stringSchema("Session identifier"),
    request_id: stringSchema("Agent request event ID"),
    runtime_id: stringSchema("Registered runtime ID"),
    idempotency_key: idempotencySchema(),
    payload: {},
  }, ["session_id", "request_id", "runtime_id", "idempotency_key", "payload"], MUTATING_TOOL_ANNOTATIONS),
  tool("collaboration_upload_context_snapshot", "Upload an explicitly fidelity-labelled and redacted context snapshot", {
    session_id: stringSchema("Session identifier"),
    capture_fidelity: enumSchema(["canonical_history", "harness_transcript", "provider_request"]),
    content: {},
    idempotency_key: idempotencySchema("Stable retry key; generated if omitted"),
    covers_through_sequence: integerSchema("Required for canonical_history", 0),
    local_session_id: stringSchema("Required for harness_transcript; fingerprinted before append"),
    exact_provider_request: { type: "boolean" },
    observed_by: enumSchema(["harness_hook", "authorized_proxy"]),
    runtime_id: stringSchema("Runtime that observed the snapshot"),
  }, ["session_id", "capture_fidelity", "content"], MUTATING_TOOL_ANNOTATIONS),
] as const;

const SHARING_TOOL_DEFINITIONS = [
  tool("collaboration_list_shared_agents", "List another member's authorized shared Codex/DSH Agents in this project, including exact grant revision, model and remaining limits. Sharing management and native execution controls are not exposed", {
    project_id: stringSchema("Project identifier"),
  }, ["project_id"]),
  tool("collaboration_request_shared_agent", "Request another member's explicitly shared Agent. This consumes that member's compute and your sharing allowance. Send the captured content_revision without refreshing it on retry. Solo tasks and public conversation context go to the owner's device: set solo_transfer_ack=true only after the human has explicitly agreed to that transfer. This bounded standalone call does not grant recursive execution or sharing management", {
    session_id: stringSchema("Writable session identifier"), share_id: stringSchema("Exact authorized share identifier"),
    share_revision: integerSchema("Current revision returned by collaboration_list_shared_agents", 1),
    execution_profile: { type: "object", additionalProperties: false, properties: {
      harness: { type: "string", enum: ["codex", "deepseek-harness"] }, provider: stringSchema("Advertised provider"),
      model: stringSchema("Model from execution_profiles"), reasoning_effort: stringSchema("Advertised reasoning effort")
    }, required: ["harness", "provider", "model"] },
    content: { ...stringSchema("Visible task sent to the sharing member's device"), minLength: 1, maxLength: 16000 },
    content_revision: integerSchema("Captured revision from the context/history used to prepare this task", 0),
    solo_transfer_ack: { type: "boolean", description: "Explicit human acknowledgement of transfer from Solo to the owner's device; default false" },
    idempotency_key: idempotencySchema(), reply_to_event_id: stringSchema("Optional same-session public event to quote"),
    mentions: { type: "array", maxItems: 32, items: { type: "object", additionalProperties: false,
      properties: { user_id: stringSchema("Current project member"), start: integerSchema("UTF-16 start offset", 0), end: integerSchema("UTF-16 end offset", 1) },
      required: ["user_id", "start", "end"] } },
  }, ["session_id", "share_id", "share_revision", "content", "content_revision", "idempotency_key"], MUTATING_TOOL_ANNOTATIONS),
  tool("collaboration_cancel_shared_agent_request", "Cancel your own exact shared-Agent request, including queued work. Running work is fenced and its slot stays reserved until the native executor confirms exit. This cannot close someone else's sharing hotspot", {
    session_id: stringSchema("Writable session identifier"), request_event_id: stringSchema("Your canonical shared-Agent request event ID"),
    idempotency_key: idempotencySchema(),
  }, ["session_id", "request_event_id", "idempotency_key"], MUTATING_TOOL_ANNOTATIONS),
] as const;

export class CollaborationMcpService {
  readonly #api: CollaborationApi;
  readonly #serverName: string;
  readonly #serverVersion: string;
  readonly #allowProviderRequestCapture: boolean;
  readonly #toolProfile: "user" | "runtime";
  readonly #localSync: LocalConversationSyncControl | undefined;
  readonly #toolDefinitions: readonly (typeof USER_TOOL_DEFINITIONS[number] | typeof RUNTIME_TOOL_DEFINITIONS[number])[];
  readonly #toolNames: ReadonlySet<string>;

  constructor(options: CollaborationMcpServiceOptions) {
    this.#api = options.api;
    this.#serverName = options.serverName ?? "gatherthread";
    this.#serverVersion = options.serverVersion ?? "0.1.0";
    this.#allowProviderRequestCapture = options.allowProviderRequestCapture === true;
    this.#toolProfile = options.toolProfile ?? "user";
    this.#localSync = options.localSync;
    this.#toolDefinitions = this.#toolProfile === "runtime" ? RUNTIME_TOOL_DEFINITIONS
      : [...USER_TOOL_DEFINITIONS, ...(options.api.agentSharingRequestApi ? SHARING_TOOL_DEFINITIONS : [])];
    this.#toolNames = new Set(this.#toolDefinitions.map(({ name }) => name));
  }

  async handle(input: unknown): Promise<JsonRpcResponse | undefined> {
    if (!isObject(input) || input.jsonrpc !== "2.0" || typeof input.method !== "string"
      || !(input.id === undefined || input.id === null || typeof input.id === "string"
        || (typeof input.id === "number" && Number.isFinite(input.id)))) {
      const invalidId = isObject(input) && (typeof input.id === "string"
        || (typeof input.id === "number" && Number.isFinite(input.id)))
        ? input.id
        : null;
      return failure(invalidId, -32600, "Invalid Request");
    }
    const request = input as unknown as JsonRpcRequest;
    if (request.id === undefined) return undefined;

    try {
      const result = await this.#dispatch(request.method, request.params);
      return { jsonrpc: "2.0", id: request.id ?? null, result };
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : "Unknown MCP error");
      const code = error instanceof MethodNotFoundError ? -32601 : -32602;
      return failure(request.id ?? null, code, message);
    }
  }

  async #dispatch(method: string, params: unknown): Promise<unknown> {
    if (method === "initialize") {
      return {
        protocolVersion: requestedProtocolVersion(params),
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: this.#serverName, version: this.#serverVersion },
      };
    }
    if (method === "ping") return {};
    if (method === "tools/list") return { tools: this.#toolDefinitions };
    if (method === "resources/list") {
      return { resources: this.#toolProfile === "user" ? await this.#listResources() : [] };
    }
    if (method === "resources/read") {
      if (this.#toolProfile !== "user") throw new MethodNotFoundError("Method not found: resources/read");
      return this.#readResource(requiredString(requiredObject(params), "uri"));
    }
    if (method === "tools/call") {
      const input = requiredObject(params);
      const name = requiredString(input, "name");
      if (!this.#toolNames.has(name)) throw new MethodNotFoundError(`Unknown tool: ${name}`);
      return this.#callTool(name, optionalObject(input.arguments));
    }
    throw new MethodNotFoundError(`Method not found: ${method}`);
  }

  async #callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    let result: unknown;
    switch (name) {
      case "collaboration_get_configuration_schema": {
        const kind = requiredString(args, "kind");
        if (!["preferences", "agent-team"].includes(kind)) throw new Error("Unsupported configuration kind");
        result = { schema: kind === "preferences" ? PreferencesJsonSchema : AGENT_TEAM_CONFIG_JSON_SCHEMA,
          workflow: "Return JSON for user preview/import. Team drafts require Agent selection, save, test and explicit enable. No execution or authorization is imported." };
        break;
      }
      case "collaboration_validate_configuration": {
        const json = readConfigurationJson(requiredString(args, "json"));
        const kind = (json && typeof json === "object" && "kind" in json) ? json.kind : undefined;
        const parsed = (kind === "gatherthread.preferences" ? PreferencesConfigurationSchema : AgentTeamConfigSchema).safeParse(json);
        result = parsed.success ? { valid: true, kind } : { valid: false,
          issues: parsed.error.issues.slice(0, 8).map(issue => ({ path: issue.path.join("."), message: issue.message })) };
        break;
      }
      case "collaboration_list_projects":
        result = await this.#requireProjectApi("listProjects")();
        break;
      case "collaboration_list_project_sessions":
        result = await this.#requireProjectApi("listProjectSessions")(requiredString(args, "project_id"));
        break;
      case "collaboration_list_sessions":
        result = await this.#api.listSessions();
        break;
      case "collaboration_read_history":
        result = await this.#api.readEvents(
          requiredString(args, "session_id"),
          optionalInteger(args.after_sequence, 0),
          optionalPositiveInteger(args.limit, 200),
        );
        break;
      case "collaboration_read_context": {
        if (Object.keys(args).some((key) => key !== "session_id" && key !== "view")) {
          throw new Error("Context read accepts only session_id and view");
        }
        const sessionId = requiredString(args, "session_id");
        const view = args.view === undefined ? undefined : requiredEnum(args, "view", ["summary", "original"] as const);
        validateContextReadInput(sessionId, view);
        if (!this.#api.readContext) {
          throw new Error("Context reading is unavailable on the configured API; raw history was not substituted");
        }
        result = parseHistoryContext(await this.#api.readContext(sessionId, view), view);
        break;
      }
      case "collaboration_append_chat":
        result = await this.#appendVisibleMessage(args, "human_chat");
        break;
      case "collaboration_request_agent":
        result = await this.#appendVisibleMessage(args, "agent_request");
        break;
      case "collaboration_list_shared_agents": {
        if (Object.keys(args).some(key => key !== "project_id")) throw new Error("Shared Agent listing accepts only project_id");
        const projectId = IdSchema.parse(args.project_id);
        const listed = AgentSharesResponseSchema.parse(await this.#requireSharingApi().list(projectId));
        if (listed.shares.some(share => share.project_id !== projectId)) throw new Error("Shared Agent response scope mismatch");
        result = { shares: listed.shares.filter(share => share.source_runtime_id === undefined && share.allowed_user_ids === undefined)
          .map(publicSharedAgent) };
        break;
      }
      case "collaboration_request_shared_agent": {
        const { session_id: sessionId, ...body } = args;
        const input = SharedAgentRequestInputSchema.parse(body);
        if (JSON.stringify(redactValue(input)) !== JSON.stringify(input)) throw new Error("Remove credentials from a shared Agent task before sending it");
        const target = IdSchema.parse(sessionId);
        result = acceptedSharedAgentResult(await this.#requireSharingApi().start(target, input), target, input);
        break;
      }
      case "collaboration_cancel_shared_agent_request": {
        if (Object.keys(args).some(key => !["session_id", "request_event_id", "idempotency_key"].includes(key))) throw new Error("Unknown shared request cancellation field");
        const sessionId = IdSchema.parse(args.session_id), requestId = IdSchema.parse(args.request_event_id),
          key = requiredIdempotencyKey(args, "idempotency_key");
        const cancelled = AgentShareJobResponseSchema.parse(await this.#requireSharingApi().cancel(sessionId, requestId, { idempotency_key: key }));
        if (cancelled.job.session_id !== sessionId || cancelled.job.request_event_id !== requestId) throw new Error("Shared Agent response scope mismatch");
        result = cancelled;
        break;
      }
      case "collaboration_get_connection_status":
        result = await this.#connectionStatus(requiredString(args, "project_id"));
        break;
      case "collaboration_get_local_sync_status":
        result = await this.#requireLocalSync().getLocalSyncStatus(requiredString(args, "session_id"));
        break;
      case "collaboration_set_local_auto_upload":
        result = await this.#requireLocalSync().setLocalAutoUpload(
          requiredString(args, "session_id"),
          requiredBoolean(args, "enabled"),
        );
        break;
      case "collaboration_upload_local_turns":
        result = await this.#requireLocalSync().uploadLocalTurns(requiredString(args, "session_id"));
        break;
      case "collaboration_import_codex_history":
        result = await this.#requireLocalSync().importVisibleHistorySnapshot(requiredString(args, "session_id"));
        break;
      case "collaboration_register_runtime":
        result = await this.#api.registerRuntime(runtimeInput(args));
        break;
      case "collaboration_claim_agent_request":
        result = await this.#api.claimAgentRequest(
          requiredString(args, "session_id"),
          requiredString(args, "request_id"),
          requiredString(args, "runtime_id"),
        );
        break;
      case "collaboration_complete_agent_request":
        result = await this.#api.completeAgentRequest(
          requiredString(args, "session_id"),
          requiredString(args, "request_id"),
          {
            runtimeId: requiredString(args, "runtime_id"),
            idempotencyKey: requiredIdempotencyKey(args, "idempotency_key"),
            payload: redactValue(requiredValue(args, "payload")),
          },
        );
        break;
      case "collaboration_upload_context_snapshot":
        result = await this.#uploadContextSnapshot(args);
        break;
      default:
        throw new MethodNotFoundError(`Unknown tool: ${name}`);
    }
    return toolResult(result);
  }

  #requireLocalSync(): LocalConversationSyncControl {
    if (!this.#localSync) throw new Error("Local conversation upload controls require an active local connector");
    return this.#localSync;
  }
  #requireSharingApi() {
    const api = this.#api.agentSharingRequestApi?.();
    if (!api) throw new Error("Shared Agent requests require a compatible authorized connector; no ordinary Agent fallback was used");
    return api;
  }

  async #connectionStatus(projectId: string): Promise<unknown> {
    const projects = await this.#requireProjectApi("listProjects")();
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("The requested project is unavailable for this user");
    const listMembers = this.#api.listSessionMembers;
    if (!listMembers) throw new Error("The configured collaboration API does not support listSessionMembers");
    const sessions = await this.#requireProjectApi("listProjectSessions")(projectId);
    return {
      project: { id: project.id, name: project.name, role: project.role, state: project.state },
      sessions: await Promise.all(sessions.map(async (session) => ({
        id: session.id,
        name: session.name,
        mode: session.mode,
        members: (await listMembers.call(this.#api, session.id)).map((member) => ({
          displayName: member.displayName,
          role: member.role,
          runtime: member.runtime,
        })),
      }))),
    };
  }

  async #appendVisibleMessage(
    args: Record<string, unknown>,
    type: "human_chat" | "agent_request",
  ): Promise<unknown> {
    const replyTo = optionalString(args.reply_to);
    const contentRevision = type === "agent_request" ? args.content_revision : undefined;
    if (contentRevision !== undefined && (typeof contentRevision !== "number" || !Number.isSafeInteger(contentRevision) || contentRevision < 0)) {
      throw new Error("content_revision must be a non-negative safe integer");
    }
    return this.#api.appendEvent(requiredString(args, "session_id"), {
      type,
      idempotencyKey: requiredIdempotencyKey(args, "idempotency_key"),
      payload: { text: redactText(requiredString(args, "content")) },
      ...(replyTo === undefined ? {} : { replyTo }),
      ...(contentRevision === undefined ? {} : { contentRevision }),
    });
  }

  async #uploadContextSnapshot(args: Record<string, unknown>): Promise<unknown> {
    const fidelity = requiredEnum(args, "capture_fidelity", [
      "canonical_history", "harness_transcript", "provider_request",
    ] as const);
    const payload: Record<string, unknown> = {
      capture_fidelity: fidelity,
      content: redactValue(requiredValue(args, "content")),
    };
    if (fidelity === "canonical_history") {
      payload.covers_through_sequence = requiredInteger(args, "covers_through_sequence");
    } else if (fidelity === "harness_transcript") {
      payload.local_session_fingerprint = createHash("sha256")
        .update(requiredString(args, "local_session_id"))
        .digest("hex");
    } else {
      if (!this.#allowProviderRequestCapture
        || args.exact_provider_request !== true
        || !["harness_hook", "authorized_proxy"].includes(String(args.observed_by))) {
        throw new Error(
          "provider_request requires explicit service authorization, exact_provider_request=true, and hook/proxy observation",
        );
      }
      payload.exact_provider_request = true;
      payload.observed_by = args.observed_by;
      payload.runtime_id = requiredString(args, "runtime_id");
    }
    const runtimeId = optionalString(args.runtime_id);
    return this.#api.appendEvent(requiredString(args, "session_id"), {
      type: "context_snapshot",
      idempotencyKey: optionalIdempotencyKey(args.idempotency_key) ?? randomUUID(),
      payload,
      ...(runtimeId === undefined ? {} : { runtimeId }),
    });
  }

  async #listResources(): Promise<unknown[]> {
    const sessions = await this.#api.listSessions();
    const projects = this.#api.listProjects ? await this.#api.listProjects() : [];
    return [
      ...(this.#api.listProjects ? [{
        uri: "collaboration://projects",
        name: "Collaboration projects",
        mimeType: "application/json",
      }] : []),
      ...projects.map((project) => ({
        uri: `collaboration://projects/${encodeURIComponent(project.id)}/sessions`,
        name: `${project.name} sessions`,
        mimeType: "application/json",
      })),
      {
        uri: "collaboration://sessions",
        name: "Collaboration sessions",
        mimeType: "application/json",
      },
      ...sessions.map((session) => ({
        uri: `collaboration://sessions/${encodeURIComponent(session.id)}/events`,
        name: session.name ? `${session.name} history` : `Session ${session.id} history`,
        mimeType: "application/json",
      })),
    ];
  }

  async #readResource(uri: string): Promise<unknown> {
    const parsed = new URL(uri);
    if (parsed.protocol !== "collaboration:") throw new Error("Unsupported resource URI");
    if (parsed.hostname === "projects" && (parsed.pathname === "" || parsed.pathname === "/")) {
      return resourceResult(uri, await this.#requireProjectApi("listProjects")());
    }
    if (parsed.hostname === "projects") {
      const projectMatch = parsed.pathname.match(/^\/([^/]+)\/sessions$/);
      if (!projectMatch) throw new Error("Unsupported resource URI");
      return resourceResult(
        uri,
        await this.#requireProjectApi("listProjectSessions")(decodeURIComponent(projectMatch[1] ?? "")),
      );
    }
    if (parsed.hostname === "sessions" && (parsed.pathname === "" || parsed.pathname === "/")) {
      return resourceResult(uri, await this.#api.listSessions());
    }
    if (parsed.hostname !== "sessions") throw new Error("Unsupported resource URI");
    const match = parsed.pathname.match(/^\/([^/]+)\/events$/);
    if (!match) throw new Error("Unsupported resource URI");
    const sessionId = decodeURIComponent(match[1] ?? "");
    const after = optionalInteger(parsed.searchParams.get("after_sequence"), 0);
    const limit = optionalPositiveInteger(parsed.searchParams.get("limit"), 200);
    return resourceResult(uri, await this.#api.readEvents(sessionId, after, limit));
  }

  #requireProjectApi<K extends "listProjects" | "listProjectSessions">(
    name: K,
  ): NonNullable<CollaborationApi[K]> {
    const operation = this.#api[name];
    if (!operation) throw new Error(`The configured collaboration API does not support ${name}`);
    return operation.bind(this.#api) as NonNullable<CollaborationApi[K]>;
  }
}

function acceptedSharedAgentResult(raw: unknown, sessionId: string, input: SharedAgentRequestInput) {
  const result = SharedAgentRequestAcceptedSchema.parse(raw), { event, job } = result, proof = event.shared_execution;
  if (event.session_id !== sessionId || job.session_id !== sessionId || job.request_event_id !== event.id
    || event.type !== "agent_request" || event.idempotency_key !== input.idempotency_key || event.actor_user_id !== job.requester_user_id
    || job.share_id !== input.share_id || job.share_revision !== input.share_revision
    || proof?.job_id !== job.id || proof.share_id !== input.share_id || proof.share_revision !== input.share_revision
    || JSON.stringify(proof.execution_profile) !== JSON.stringify(job.execution_profile)
    || input.execution_profile && JSON.stringify(input.execution_profile) !== JSON.stringify(job.execution_profile)) throw new Error("Shared Agent response scope mismatch");
  return result;
}
function publicSharedAgent(share: AgentShare) {
  const { source_runtime_id: _source, owner_device_id: _device, allowed_user_ids: _allowlist, total_usage: _total, ...publicFields } = share;
  return publicFields;
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[] = [],
  annotations: { [Key in keyof typeof READ_ONLY_TOOL_ANNOTATIONS]: boolean } = READ_ONLY_TOOL_ANNOTATIONS,
) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations,
  };
}

function stringSchema(description: string) {
  return { type: "string", description };
}

function integerSchema(description: string, minimum: number) {
  return { type: "integer", minimum, description };
}

function idempotencySchema(description = "Stable retry key") {
  return { type: "string", minLength: 8, maxLength: 200, description };
}

function enumSchema(values: readonly string[]) {
  return { type: "string", enum: values };
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: { result: value },
  };
}

function resourceResult(uri: string, value: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }] };
}

function requestedProtocolVersion(params: unknown): string {
  const input = optionalObject(params);
  return optionalString(input.protocolVersion) ?? "2025-03-26";
}

function runtimeInput(args: Record<string, unknown>): RuntimeRegistration {
  const capabilities = optionalStringArray(args.capabilities);
  return {
    sessionId: requiredString(args, "session_id"),
    deviceId: requiredString(args, "device_id"),
    harness: requiredEnum(args, "harness", ["codex", "claude-code"] as const),
    provider: requiredString(args, "provider"),
    model: requiredString(args, "model"),
    localSessionId: requiredString(args, "local_session_id"),
    captureFidelity: requiredEnum(args, "capture_fidelity", [
      "canonical_history", "harness_transcript", "provider_request",
    ] as const),
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

function requiredObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> {
  return value === undefined ? {} : requiredObject(value);
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function requiredBoolean(input: Record<string, unknown>, key: string): boolean {
  const value = input[key];
  if (typeof value !== "boolean") throw new Error(`${key} must be true or false`);
  return value;
}

function requiredIdempotencyKey(input: Record<string, unknown>, key: string): string {
  const value = requiredString(input, key);
  if (value.length < 8 || value.length > 200) {
    throw new Error(`${key} must contain 8 to 200 characters`);
  }
  return value;
}

function optionalIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const input = { value };
  return requiredIdempotencyKey(input, "value");
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}

function requiredInteger(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${key} must be a non-negative integer`);
  return Number(value);
}

function optionalInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 0) throw new Error("Expected a non-negative integer");
  return Number(parsed);
}

function optionalPositiveInteger(value: unknown, fallback: number): number {
  const parsed = optionalInteger(value, fallback);
  if (parsed < 1) throw new Error("Expected a positive integer");
  return parsed;
}

function requiredValue(input: Record<string, unknown>, key: string): unknown {
  if (!(key in input)) throw new Error(`${key} is required`);
  return input[key];
}

function requiredEnum<const T extends readonly string[]>(
  input: Record<string, unknown>,
  key: string,
  allowed: T,
): T[number] {
  const value = input[key];
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Expected an array of strings");
  }
  return value as string[];
}

function failure(id: string | number | null, code: number, message: string): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

class MethodNotFoundError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

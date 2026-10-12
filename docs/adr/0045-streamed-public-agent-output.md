# ADR-0045: Live answers, visible thinking, tools and plans across Agents

- Status: proposed / implementation review
- Date: 2026-10-12
- Scope: additive progress contract; Codex, DSH and hosted OpenCode producers; Web presentation; no database migration

## Context

Readers should see the same current work that their Agent exposes in its native interface, rather than a generic working label followed by a finished answer. A useful work log includes a growing answer, native-visible thinking or reasoning summaries, tool activity and a changing plan. Hidden Codex reasoning is not a source for this feature. Shared work must remain confined to the initiating member's exact execution, with existing permissions, pause controls, quotas and final-response rules intact.

Independent runtime presence and work-based claim renewal remain separate. A heartbeat or persistent busy label cannot fabricate progress. Publishing every model token would exhaust canonical write budgets; independently redacting fragments can leak the prefix of a split credential. Adjacent-fragment concatenation also mishandles interleaved items, replay and references to incomplete text.

## Decision

### One bounded snapshot contract

`agent_progress` adds `phase: stream`, an opaque UUID `stream_id`, `stream_mode: snapshot`, `stream_kind: answer|reasoning|tool|plan`, increasing `stream_revision` and `stream_state: running|completed|failed`. A plan carries bounded `{step, status}` entries. Native IDs remain private. Legacy lifecycle/activity events and delta-shaped output remain readable.

Each request owns a `createLiveOutputPublisher`. It coalesces updates on one 1.5-second publication cadence, holds at most 128 items with 96 KiB of input each, caps public content at 24 KiB, and accepts at most 1,200 publications. Plans have at most 64 steps of 512 bytes. The terminal drain is bounded to 64 items. Live previews are not a lossless replacement for the canonical final response or existing completed tool events.

Cumulative content is redacted before publication. Serialized sensitive fields, including interrupted values and Cookie headers, use the same sensitive-key policy as structured objects. An incomplete credential-shaped ASCII tail and unfinished private-key block are withheld; normal Chinese text does not require a whitespace boundary. Tool arguments are structurally redacted before serialization, including on abandoned/failed attempts. A failed or uncertain upload retries the identical pending ID and payload; only acknowledgement advances revision and publication time. New text arriving during acknowledgement remains dirty for the next snapshot. Dirty items rotate fairly so continuous answers cannot starve plans or tools. Supplementary progress failures never strand final completion.

### Native adapters, not raw event uploads

- **Codex:** only the connector-owned thread and authoritative turn may publish. Early events are bounded and held until `turn/start` identifies that turn. Public assistant deltas, native reasoning **summary** deltas, selected tool fields and native plan updates are mapped. Raw reasoning text, private instructions and whole notification objects are excluded. Terminal native items reconcile the live preview. Existing tool-sharing choices remain respected.
- **DSH:** live output is observed only for the exact claimed prompt on its selected Agent, Session and model route. The supported alpha interface uses native assistant-stream frames. The pinned npm fallback requires DSH's actual Agent-loop request marker, current Agent ownership and Session/turn/step matching; model-name matching alone is insufficient. It maps exposed assistant text, exposed thinking, selected tools and native plans. Incomplete tool JSON produces only a preparation marker until it can be parsed and structurally redacted. Native automatic-upload capture remains unchanged and excludes unrelated local work.
- **Cloud Agent:** the existing pinned `opencode serve` process is reused. Its loopback SSE subscription starts before the prompt and selects only that fresh Session's assistant parts, visible reasoning, tools and todo events. A bounded private JSONL pipe carries selected progress to the host, separately from the legacy final JSON result. It coalesces at 1.5 seconds and reserves half its unchanged transport allowance for a latest-state drain; oversized combined final previews are fairly truncated while preserving item states and plan statuses. Docker logging is disabled for these executor pipes; progress bodies are never operational logs. No extra executor or external network permission is introduced. Strict finished-message, idle-session and confirmed-cleanup checks still decide success; a live preview cannot substitute for them.

Hosted publication is an internal server callback, not a new public endpoint. In the insertion transaction it requires the running, unpaused job, its active device, current write access and the exact request. GitHub tasks additionally require their current task/device/repository binding and authorization. Completed, revoked, expired, rebound or read-only work cannot publish. Progress uses ordinary storage charges, opaque server-derived idempotency keys and existing ordered fan-out.

### Readable, stable presentation

The Web client replaces a stream's snapshot by request ID, opaque stream ID and highest revision, even when other work interleaves or replay arrives out of order. Its visual anchor stays on the first entry; copy and quote use the latest real canonical snapshot. Following a reference to an older revision reveals that exact stored text. Legacy aggregated fragments may be copied as a whole but are not quoted under a misleading single-fragment ID.

The answer grows in full. Thinking, Tool and Plan use compact, individually collapsible sections in the existing work log. Explicit collapse choices survive new output and final completion; paused output stays readable and labelled paused. The composer retains its existing Pause/Resume control, focus and history scroll position. Rapidly changing content is not an `aria-live` region; concise lifecycle status and plan labels remain accessible. Motion respects reduced-motion preferences.

## Alternatives considered

- **Every token as an event:** rejected for write/storage pressure and split-secret exposure.
- **Only final items with a redesigned placeholder:** rejected because readers still cannot inspect current work.
- **Adjacent delta concatenation only:** rejected for interleaving, replay and exact-reference integrity. Kept only as a backward-compatible reader path.
- **Unbounded snapshots or raw native event forwarding:** rejected. Fixed byte/item/publication caps, field selection, exact execution fencing and redaction are required.
- **Obtain hidden reasoning or manufacture a plan:** rejected. Only actual native-exposed information is shown; models that emit no such information have no invented Thinking or Plan section.

## Consequences and delivery

This is additive on the existing progress route and SQLite event log; it changes no membership, lease, summary-context, code-sync or final-response authority. Snapshots duplicate some intermediate text in canonical history, but all writes remain bounded and charged. The final answer remains primary and existing work-log folding remains available.

DSH, Codex and hosted adapters require matching builds. A Web-only deployment cannot upgrade an installed connector/plugin or the hosted executor. Test deployment must use the reviewed source plus its matching immutable hosted image. Previously released npm packages and launcher installers are not silently overwritten by this PR. Engine-based browser and synthetic native-event tests are not evidence of a live provider request or native Safari execution; those checks must be reported separately.

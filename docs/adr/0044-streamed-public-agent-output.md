# ADR-0044: Stream public agent output into the shared work log

- Status: proposed / implementation review
- Date: 2026-10-12
- Scope: Codex connector progress cadence and Web work-log presentation; no wire schema, database or migration change

## Context

A claimed Web Agent turn already reaches the server as ordered `agent_progress` before its final `agent_response`. The Codex connector, however, received the public agent-message text only as complete native items: it published commentary when an item finished, and otherwise published a throttled, content-free `activity` placeholder. A reader watching a long turn therefore saw "Agent is working." for minutes and then the entire message at once.

[ADR-0005](0005-managed-codex-thread-bridge.md) deferred streaming model tokens into the room and chose `codex exec --json` on a smaller security surface. The project has since moved to the managed App Server, which already delivers public agent-message text incrementally as `item/agentMessage/delta`, and the connector already reads those notifications — it used them only to derive a coarse `running` state and discarded the text.

Three existing constraints bound any solution:

- Accepted progress is what renews a claim lease, and the per-device write budget is finite, so output cannot be published once per token.
- A progress payload past its size cap is replaced wholesale by a truncation envelope, so one publication must never grow without bound.
- Hidden reasoning is not shared by default. Reasoning and tool-output streams must not reach published progress.

## Decision

The Codex connector publishes the public slices of `item/agentMessage/delta` as `agent_progress` with `phase: "stream"` and an opaque, connector-generated `stream_id`.

- **Bounded publication.** `createAgentOutputStream` coalesces slices and publishes at most one fragment per item per interval, each capped to a UTF-8-safe byte budget, with the tail flushed when the native item closes and when the turn settles. Reference rates and fragments stay far below the payload ceiling and the per-device write budget.
- **Merged for the reader.** The Web client concatenates adjacent fragments that share a `stream_id` into one growing work-log entry. The entries count and the anchor stay on the first fragment, so the entry does not jump.
- **No duplicate copy.** When the stream published an item's text in full, the completed item is not published a second time under its own identity. When the two differ — a capped stream, or an App Server that does not emit deltas at all — the completed item is published as before, so text is never lost.
- **Placeholder demoted, not removed.** The generic busy/thinking placeholder is suppressed while streamed output is recent and returns afterwards, so it still reports silent tool work and still renews the lease well inside the five-minute window.
- **Public text only.** Only `item/agentMessage/delta` reaches the streaming hook. Reasoning and tool-output streams have no path in, and the deltas are redacted like every other uploaded payload.
- **Verbatim fragments.** A streamed fragment keeps its exact text apart from credential redaction. Trimming each fragment would delete the whitespace that joins it to its neighbours and silently corrupt the merged view.
- **Presentation.** The pending-answer indicator shows the tail of what the agent is writing instead of the generic "is responding" wording, and the newest streamed entry carries a reduced-motion-aware caret. The streamed line is deliberately not a live region: text that rewrites itself every couple of seconds must not be read aloud repeatedly.

## Alternatives Considered

### Publish an accumulated snapshot on each tick

- **Pros**: A reader could simply replace the previous entry; no merge logic, and fragment trimming would be harmless.
- **Cons**: Every publication carries the whole message so far, so payload volume grows quadratically and one publication eventually crosses the truncation ceiling.
- **Why not**: Long answers are exactly when a reader benefits most from streaming, and they are where snapshots fail.

### Keep item-level progress and change only the presentation

- **Pros**: Smallest possible patch, no connector change.
- **Cons**: The reader still sees nothing until a native item completes.
- **Why not**: It does not deliver the requested outcome; the coarse placeholder would remain the only signal during the part of a turn the reader is actually waiting through.

### Publish every native fragment

- **Pros**: Smoothest possible stream.
- **Cons**: Exceeds the per-device write budget and inflates the canonical log with thousands of tiny events.
- **Why not**: The server's write budget and storage quotas are shared with every other connector operation.

### Include reasoning streams

- **Pros**: Would show the model's chain of thought where a provider exposes one.
- **Cons**: Violates the invariant that hidden reasoning is not shared by default.
- **Why not**: The Codex App Server does not expose readable reasoning, so the option buys nothing here and would only weaken a boundary the project treats as non-negotiable.

## Consequences

### Positive

- A reader watches the agent's public output as it is written instead of a placeholder.
- No protocol, database or migration change: progress payload fields are a bridge-to-Web convention, and the added `phase` and `stream_id` values are additive for older readers, which render each fragment as its own entry.
- The claim-lease path is unchanged; streamed progress renews it exactly as commentary and heartbeats already did.

### Negative

- A streamed message is stored twice once the turn completes: once as fragments and once as the canonical `agent_response` or completed commentary. This is bounded by the per-publication budget and hidden by the work log's collapse-by-default behaviour.
- The work log is no longer a strict one-entry-per-event list, so its rendered entry count can be smaller than the number of canonical events it represents.
- The DSH connector keeps its documented content-free heartbeats, so its progress stays generic. Extending it needs its own decision: its live-progress cadence is tied to lease renewal, and its event content is governed by a separate upload allowlist.

### Risks

- **Fragments that do not reconstruct the completed item.** Mitigated by comparing the streamed text with the completed item text and publishing the completed item whenever they differ.
- **Dedup erases an item.** A stream that failed to publish everything reports only what it published, and the caller falls back to the completed item, so the invariant is "never lost", not "never duplicated".
- **Write-budget pressure during long turns.** Mitigated by the per-item interval plus the byte cap; both are module constants with tests asserting the bound.

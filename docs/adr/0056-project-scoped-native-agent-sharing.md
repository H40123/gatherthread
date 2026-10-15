# ADR-0056: Project-scoped native Agent sharing

- Status: proposed / local implementation preview
- Date: 2026-10-15

## Context

A member wants to share a selected local Codex or DSH connection with chosen
project members, through manual requests or the borrower's authorized MCP tools. Ordinary runtime
claims cannot grant another user access to that member's native credentials or
ordinary write authority over the requester's Solo.

## Decision

The native stop acknowledgment is backed by a bounded metadata-only local outbox
written after actual execution quiescence. Unknown work remains fenced. Agent
connection loss, native source availability and execution leases determine
revocation. Desktop locking is not a separate trigger, and no OS notification
listener or Swift toolchain is required. Windows sharing remains unavailable
until confinement is verified; ordinary connections retain their existing behavior.

Introduce a separate, revisioned native-sharing grant and broker. The owner
manages it from an authenticated browser; allowed current project writers need
no invitation acceptance. Each source has one autosaved configuration; start
atomically saves and enables it. Grants share a connection and its advertised
model catalog. Borrowers select the exact model/effort per call. Every accepted
call binds the exact source/profile,
current authority, public context revision and reserved usage. Borrowing never treats another member's runtime as owned.
The requester remains canonical author; a readonly server-origin proof records
the execution owner independently of temporary broker jobs.

Use fresh native executions with an enforced project-only list/read/write facade
and independent cancellation/watchdog. Shared work must stop when the grant or
device becomes unavailable. Unconfirmed cleanup holds the serial execution slot.
Interruption/restart commits OFF; READY never replaces the owner's manual enable.
Native support is capability/probe gated, with no permissive fallback. The first
version excludes cloud sharing, monetary limits and Windows execution.

The canonical owners are [Product specification](../PRODUCT_SPEC.md#share-my-native-agent-local-implementation-preview)
for flow/defaults, [Interface contracts](../INTERFACE_CONTRACTS.md#native-agent-sharing-preview-contract)
for routes/compatibility, [Security](../SECURITY.md#native-agent-sharing-preview-boundary)
for isolation/retention, and [Architecture](../ARCHITECTURE.md#project-scoped-native-agent-sharing-local-preview)
for component/data flow. Existing author erasure remains governed by
[ADR-0050](0050-author-message-erasure-and-context-revisions.md).

## Consequences and verification

The broker adds private grant/job/quota state and exact native controls; it does
not relax normal session ACLs, share credentials or reuse owner task history.
Grant limits apply to Web and MCP calls together. A source that cannot prove confinement or
cleanup is unavailable rather than silently routed elsewhere. Bounded project
file operations intentionally omit shell/build commands and arbitrary tools.

Contract tests and fictional loopback browser/native fixtures exercise authority,
Solo disclosure, same-key retry, quota/slot accounting, disable/offline/restart,
late-output fences, attribution and erasure. Those fixtures do not prove real
model account/subscription refresh, Windows/Linux runtime acceptance or a deployed
feature. Real native/provider acceptance and release authorization are separate
gates. No package version, release metadata, publication or deployment changes
are part of this decision.

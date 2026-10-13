# ADR-0052: Distinguish cloud timeouts and continue with bounded fresh rounds

- Status: proposed / implementation review
- Date: 2026-10-12

## Context

Cloud trials used a five-minute container deadline, repository tasks fifteen
minutes, and provider requests thirty seconds. Timeout codes existed but the
Web showed the same failure/retry treatment. Node's default HTTP header/body
limits can also end inference before a twelve-minute round allowance.

## Decision

Bound each cloud execution request to twelve minutes, including provider
streams. Use a private per-execution Undici dispatcher with explicit matching
header/body timeouts rather than changing a global dispatcher. Connection
establishment retains its short bound. Destroy only the owned dispatcher on
cleanup. The container's independent OpenCode final-JSON transport uses its own image-pinned Undici pool with the same header/body bound and an absolute round signal; two connections keep supplementary SSE from blocking final response. A known final-response/whole-round deadline emits only `agent_timeout`. Short health/session/idle probes retain their phase failure semantics. The supported API is documented by [Undici](https://undici.nodejs.org/api/Client).

Keep existing `failed` status values for compatibility and add a strict terminal
`outcome`, plus an additive durable outcome table. Only allowlisted execution
or known transport deadline failures classify as timeout. Original error text,
provider payloads and reasoning never enter public diagnostics.

Continue is an explicit new reservation: same author, session, task, profile,
code choice and quote, with current authorization and ordinary quota checks.
One timeout accepts one child; uncertain same-key delivery replays the receipt.
Generic append and native local-turn APIs cannot forge its server-owned linkage.
The new round sees current authorized conversation and saved code. Identical,
verified task ancestors become explicit references only in private derived input,
so a maximum-size task can continue without multiplying itself past the context
limit. Distinct public material is retained. Canonical order stays append-only;
the author-erasure exception and history revision fences in [ADR-0050](0050-author-message-erasure-and-context-revisions.md) remain authoritative.
Erased or stale source requests cannot continue. Personal API continuation must
retain its exact private configuration revision under [ADR-0049](0049-account-owned-cloud-api-configuration.md), even if an edit leaves provider and model unchanged.

Summary continuation validates original selected sources and retains its canonical
instructions without widening provider transfer. Repository continuation retains
its existing private saved-source workflow and exact original profile. No flow
promises to recover stopped processes, hidden reasoning or unsaved files.

## Compatibility and verification

Server and Web should upgrade together to expose Continue. Older clients still
see `failed`; stored timeout codes classify old events without rewriting them.
The additive outcome table can remain during rollback and usage is never reset.
A matching immutable runner image must be rebuilt and verified from this source; Web/server-only updates cannot fix the internal transport.
Provider endpoints, quotas, executor-exit slot release and storage allowances
remain independently enforced.

Tests exercise strict wire inputs, timeout/failure classification, duplicate child
and idempotency fences, unauthorized/forged metadata, summaries, source snapshots,
maximum-size ASCII/Chinese task continuation and real HTTP parsing past five
minutes with an accelerated parser clock. A live provider/deployment acceptance
requires separate operator authorization; local fixtures establish no deployment.

# ADR-0060: Manage Solo and Multi visibility per project member

**Date**: 2026-10-20

**Status**: proposed / local implementation

**Supersedes**: ADR-0058's creation-only Web audience choice; further refines ADR-0006/0015's project-wide session read assumption

## Context

The creator needs one common member-management surface for Solo and Multi, including changes after creation. A binary creation option cannot express that one teammate may read while another may not, and crowds the creation dialog.

## Decision

Keep project roles and conversation authorship independent from a per-member read override. The Members sidebar owns these controls for both modes, and the creator always retains visibility while a project member. Canonical product behavior is in [Product specification](../PRODUCT_SPEC.md#session-visibility), security in [Security](../SECURITY.md#security-invariants), and wire, migration, recovery and enforcement semantics in [Interface contracts](../INTERFACE_CONTRACTS.md#session-member-visibility).

Authorization is a live SQLite read model, not a rewrite of shared history. A denial additionally creates a durable sequence fence for that user's old requests, so regrant cannot revive an interrupted execution. Existing private defaults and their scopes are preserved; new Web sessions use the established project-visible creation default. No release version, publication or deployment is part of this implementation.

## Consequences

Mutable visibility requires immediate realtime revocation, exact mutation recovery, runtime/job fencing and authoritative discovery filtering. It does not recall previously delivered local/provider content, change project-file access, transfer creation ownership or promote a project viewer to a writer. Old servers without the new read boundary cannot safely serve these databases.

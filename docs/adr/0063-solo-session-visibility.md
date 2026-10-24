# ADR-0063: Choose a Solo conversation's read audience at creation

**Date**: 2026-10-20

**Status**: superseded for Web interaction and mutable visibility by [ADR-0062](0062-per-member-session-visibility.md); retained as historical context

**Partially supersedes**: ADR-0006 and ADR-0015's always-project-visible Solo read policy

## Context

Solo currently separates writing authority but shares every conversation with project members. Creators need a deliberate choice between a private draft and a readable personal progress thread without creating another project.

## Decision

Use a distinct, immutable session read audience rather than changing Solo's writing model or event-level visibility. The current behavior is specified in [Product specification](../PRODUCT_SPEC.md#session-visibility), authorization in [Security](../SECURITY.md#security-invariants), and migration/client compatibility in [Interface contracts](../INTERFACE_CONTRACTS.md#session-member-visibility). ADR-0062 supersedes the creation-only controls and adds per-member overrides to this initial audience.

Existing sessions and omission by older clients keep their current audience. New Web users make an explicit choice, initially private. Runtime selection and project file sharing remain independent. This implementation adds no release version, publication or deployment.

## Alternatives

- Hiding rows only in the browser would leave HTTP, realtime and native discovery exposed.
- Treating every event as owner-only would confuse project-owner privileges with Solo authorship, expose session metadata and overload event-level visibility.
- Allowing visibility changes now would require revoking active readers, cached projections and jobs. Creation-only visibility meets this request without promising to retract already distributed history.

## Consequences

Private Solos require creator-aware authorization everywhere and make rolling back to old servers unsafe. They do not provide privacy against the trusted server operator, turn project files private or prevent a project owner from deleting the entire project. Follow-up sharing or ownership changes require their own explicit contracts and authorization review.

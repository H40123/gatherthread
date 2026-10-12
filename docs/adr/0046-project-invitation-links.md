# ADR-0046: Project invitation links with explicit authenticated confirmation

**Date**: 2026-10-12
**Status**: proposed / implementation review
**Deciders**: pending project-lead review

## Context

Manually copying an invitation secret into the workspace makes first-time collaboration difficult. A link should preserve the invitation through registration/sign-in, show the destination and role, require explicit consent and open the project. Links are durable public entry contracts and introduce a capability into browser history, so this choice requires a documented exception to the former blanket prohibition on invitation URLs.

## Decision

Reuse the existing one-use project invitation, role, fixed TTLs, revocation and peppered digest. Generate a same-server `/app/#invite=…` link and continue sharing the manually enterable key and validity range. The fragment carries only an invitation capability; account, email verification and native-device credentials keep their existing URL prohibitions.

The application retains the fragment in memory/navigation during ordinary verified-email authentication and refresh, without Web Storage or an open redirect parameter. Before entering the normal workspace it displays an authenticated, read-only preview with project title, inviter display name, current account, role and expiry. Joining requires an explicit button. Declining clears the fragment without consuming the invitation; switching accounts keeps it pending. On completion the app replaces the capability URL with a same-server project link derived from the server response and reloads through normal Cookie restoration.

A new strict browser-only POST preview exposes only confirmation metadata. It does not consume, expire or audit an invitation. Existing members can explicitly open the project without changing roles or consuming a pending invite. A consumed invite can be previewed only by its original recipient who still belongs to that project, while it remains otherwise valid; this recovers an uncertain acceptance response without changing the legacy accept contract. Another user or a removed member cannot reuse it. Acceptance remains authoritative and transactional, with a fresh preview before the write and generation fences on UI responses.

## Alternatives

- A token query/path would expose the capability to HTTP request logs and redirect processing. The fragment avoids these channels.
- Automatically accepting after authentication would treat opening a link as consent. Explicit confirmation is required.
- Creating a second public invite-link record would need new storage, expiry and compatibility machinery. Reusing the existing capability keeps one-use and revocation behavior consistent.
- Saving pending invitations in Web Storage would unnecessarily persist a secret. Retaining the fragment supports refresh without that storage.

## Consequences and compatibility

The link is a shareable project capability, not an email-targeted grant. Anyone holding it with an eligible authenticated account may claim its role once. Fragments are not sent in HTTP/Referer, but clipboard recipients, browser history, extensions and scripts can still observe them. Private sharing and revocation remain necessary; no real secrets may appear in source, fixtures, screenshots or public review text. Product and security details belong to [PRODUCT_SPEC](../PRODUCT_SPEC.md#identity-invitations-and-devices) and [SECURITY](../SECURITY.md#authentication-and-authorization-requirements).

The route/schema are additive and require no database migration. Manual-secret entry and native clients remain compatible. An older server cannot render the new preview; the confirmation page provides the manual-key fallback instead of attempting automatic membership. Link and key share expiry and revocation: an expired invitation needs a new invitation. Account registration still obeys operator closure, email verification and challenge controls; links do not open signup or bypass isolated test admission. API details belong to [INTERFACE_CONTRACTS](../INTERFACE_CONTRACTS.md#route-families).

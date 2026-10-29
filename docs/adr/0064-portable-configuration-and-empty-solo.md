# ADR-0064: Portable configuration and empty Solo cleanup

Status: Accepted

## Context

Users need to ask their Agents to build Team configurations and to move browser preferences without exporting credentials or execution permissions. Starting the configuration assistant must not leave an unused conversation behind.

## Decision

Version 1 configuration files have explicit `kind` and `version`, optional fixed `$schema`, bounded standard JSON and strict shared protocol validators. Portable preferences are partial patches; Team configurations contain only editable draft fields and budgets. Import is staged for review, not execution. Saved revisions, grants, test receipts, credentials and device bindings are not preference-file fields. Team target selection remains subject to the existing exact runtime and permission checks.

The web `/gatherthread-config` entry creates an account-private Solo and an unsent prompt. Its built-in instructions describe the same contract used by read-only MCP schema/validation tools and the native plugin skill. Generated JSON only exposes an explicit draft-preview action.

New browser-created Solo conversations use the existing server creation/routing path. On navigation away, the browser asks a conditional endpoint to discard an unused Solo. The server checks active actor/device, creator ownership, membership, mode and canonical history in the same SQLite write transaction as deletion. An accepted event beyond creation protects the conversation. Multi is never conditionally discarded; unconfirmed cleanup retains the conversation. This is not background sweeping and does not delete native tasks or local files.

## Consequences

- Editors can offer schema completion; runtime validation additionally enforces graph and permission invariants.
- AI generation works with currently selected local/shared/cloud Agents without silently rerouting requests.
- A brief server record exists before a Solo's first message, maintaining existing runtime registration contracts. Browser closure/crash is not a deletion signal.
- No migration or broad filesystem/server configuration API is required.

See [configuration guide](../CONFIGURATION.md), [Team contract](../INTERFACE_CONTRACTS.md) and [ADR-0061](0061-account-private-saved-agent-teams.md).

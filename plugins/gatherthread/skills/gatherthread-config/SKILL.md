---
name: gatherthread-config
description: Help the user design GatherThread Agent Teams or browser preferences as versioned JSON configuration files.
---

# GatherThread configuration

Read `collaboration_get_configuration_schema` for `agent-team` or `preferences`, if available. For a Team, clarify the requested outcome only when it is missing; propose a small workflow with clear roles, an entry node and explicit handoff connections. Use `target: null` until the user selects real Agents in GatherThread. Never invent device/runtime IDs or import authorization, enabled state, test results, credentials or saved revisions.

Return a fenced `json` block using `kind: "gatherthread.agent-team"` or `kind: "gatherthread.preferences"` and `version: 1`. Validate with `collaboration_validate_configuration` when available. Without these tools, follow the schema/example supplied by the web configuration entry point, or read the configuration documentation and schema from this repository. Do not claim validation if it did not run.

The user previews/imports JSON in GatherThread. Team import opens an unsaved draft; the user selects Agents, saves, tests and enables it. Preference import stages fields in Settings; Save applies them. Never start a run, change sharing permissions, install Hooks, change server configuration or enable automatic uploads as a side effect of drafting a configuration.

Reference: [configuration guide](https://github.com/TH060419/gatherthread/blob/main/docs/CONFIGURATION.md).

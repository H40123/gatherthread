# ADR-0053: Remember the project's Cloud Agent code choice

- Status: accepted implementation decision
- Date: 2026-10-13

## Context

The Cloud Agent composer cleared its project-code checkbox after every send.
Repeated tasks unexpectedly reverted to an empty workspace and could discard
new files instead of saving them to the requester's GT Cloud branch.

## Decision

The visible GT Cloud code choice defaults on. Remember an explicit on/off
preference by account and project in the browser; sending, language changes,
Agent selection and background renders must not change that preference. An
explicit off remains off. This contains only a boolean preference, not source
or credentials, and it grants no server-side permission.

An effective request includes GT Cloud code only when sharing is enabled and
the user may write. If the requester has no personal branch yet, the existing
shared-source fallback remains available. Ineligible code access disables the
control without silently changing the remembered choice. Local files and
the separate GitHub workflow remain independent. Retry and Continue preserve
the original request's code selection, not a newer composer preference.

The composer displays what code can be used before sending. The user guides
and bilingual privacy notice describe this default and how to turn it off.
No task starts merely by loading or enabling the checkbox.

## Verification

Tests cover the default, remembered off, send/render stability, account/project
isolation, blocked browser storage, paused sharing and lost write permission.
Browser acceptance uses ordinary clicks and checks the actual request body;
it does not establish live-provider compatibility or a deployment.

# Beta 2 publication and isolated test rollout

## Scope

The user requested all reviewed main updates to ship to the test service and
matching npm packages, then explicitly selected `0.1.0-beta.2` for every current
product version identifier. The user authorized publication and merge, including
the one-time impossible-self-approval exception. Production promotion is a later,
separate user action.

This branch changes release metadata and matching documentation, not server,
database, protocol schemas, model execution, permissions or resource policies.
The native Mac installer requires numeric version `0.1.2`; its product release,
connector and plugin version are `0.1.0-beta.2`. Beta 1 tags/packages and dated
release records remain unchanged. Explicit warnings about old Beta 1 packages
are historical compatibility information, not current version declarations.

## Verification approach

This is a mechanical release update, not a new behavioral feature. No fabricated
RED checkpoint is claimed. Functional verification from reviewed main
`a3abdb0d8e540e95199251d32393653363b48c15` and its successful quality CI
`38636450096` is reused. The existing quality workflow remains intact; no new
test workflow or provider/browser/container diagnostic is added.

Only necessary build, package/version consistency, archive integrity and
deployment startup/health confirmation are run for this release. The server
build uses a clean Linux source archive with private configuration excluded.
Unchanged hosted runtime code reuses its existing immutable image and genuine
4173-source provenance; it is not falsely presented as a new Beta 2 image build.

Local build, `release:check`, `release:pack-npm`, reference/branding/secret audits
and `git diff --check` pass. The two generated tarballs declare Beta 2 and retain
their standalone package inventories. External lockfile dependencies and all
server/database/hosted execution source are byte-identical to the reviewed base.

The first CI pass caught a dynamically constructed legacy Launcher Release URL
and its static assertion. Both now point to the Beta 2 Release; the existing two
download-path checks are reused rather than adding a new browser test campaign.

The test service retains its separate accounts, admission, database, secrets,
8GB/shared-host resource settings and recoverable backup. A later production
promotion will reuse the same application build while retaining production data
and configuration; it does not copy test users or secrets.

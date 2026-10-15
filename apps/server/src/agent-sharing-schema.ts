/** Grants are revocable; job slots and minimal usage survive deleted conversation records. */
export const AGENT_SHARING_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_share_runtime_capabilities (
 runtime_id TEXT PRIMARY KEY REFERENCES runtimes(id) ON DELETE CASCADE,
 capability_json TEXT NOT NULL CHECK(json_valid(capability_json)),
 availability TEXT NOT NULL CHECK(availability IN ('ready','locked','offline','unsupported')), updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS agent_share_source_receipts (
 runtime_id TEXT NOT NULL REFERENCES runtimes(id) ON DELETE CASCADE,
 owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 idempotency_key TEXT NOT NULL, input_digest TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(runtime_id,idempotency_key)
) STRICT;
CREATE TABLE IF NOT EXISTS agent_share_source_barriers (
 runtime_id TEXT PRIMARY KEY REFERENCES runtimes(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS agent_shares (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 owner_device_id TEXT NOT NULL, authorizing_device_id TEXT NOT NULL, source_runtime_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 disabled_reason TEXT, profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
 limits_json TEXT NOT NULL CHECK(json_valid(limits_json)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(project_id,owner_user_id,source_runtime_id)
) STRICT;
CREATE TABLE IF NOT EXISTS agent_share_members (
 share_id TEXT NOT NULL REFERENCES agent_shares(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(share_id,user_id)
) STRICT;
CREATE TABLE IF NOT EXISTS agent_share_receipts (
 owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 idempotency_key TEXT NOT NULL, input_digest TEXT NOT NULL, share_id TEXT NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(owner_user_id,project_id,idempotency_key)
) STRICT;
CREATE TABLE IF NOT EXISTS agent_share_jobs (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, share_id TEXT NOT NULL, share_revision INTEGER NOT NULL,
 owner_user_id TEXT NOT NULL, owner_device_id TEXT NOT NULL, source_runtime_id TEXT NOT NULL,
 requester_user_id TEXT NOT NULL, requester_device_id TEXT NOT NULL, requester_display_name TEXT NOT NULL,
 session_id TEXT NOT NULL, request_event_id TEXT NOT NULL UNIQUE, response_event_id TEXT,
 idempotency_key TEXT NOT NULL, input_digest TEXT NOT NULL,
 content_revision INTEGER NOT NULL, through_sequence INTEGER NOT NULL, content TEXT NOT NULL,
 context_json TEXT NOT NULL CHECK(json_valid(context_json)), context_digest TEXT NOT NULL,
 profile_json TEXT NOT NULL CHECK(json_valid(profile_json)), max_request_seconds INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','timed_out')),
 claim_attempt INTEGER NOT NULL DEFAULT 0, lease_expires_at TEXT, claim_key TEXT,
 utc_day TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, deadline_at TEXT, finished_at TEXT,
 error_code TEXT, cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_pending IN (0,1)),
 seconds_reserved INTEGER NOT NULL, seconds_used INTEGER NOT NULL DEFAULT 0,
 UNIQUE(session_id,requester_user_id,idempotency_key)
) STRICT;
CREATE INDEX IF NOT EXISTS agent_share_jobs_owner_idx ON agent_share_jobs(owner_user_id,owner_device_id,status,created_at);
CREATE INDEX IF NOT EXISTS agent_share_jobs_source_idx ON agent_share_jobs(source_runtime_id,cleanup_pending,status);
CREATE TABLE IF NOT EXISTS agent_share_job_receipts (
 job_id TEXT NOT NULL REFERENCES agent_share_jobs(id) ON DELETE CASCADE,
 idempotency_key TEXT NOT NULL, input_digest TEXT NOT NULL, event_id TEXT,
 created_at TEXT NOT NULL, PRIMARY KEY(job_id,idempotency_key)
) STRICT;
CREATE TABLE IF NOT EXISTS agent_share_daily_usage (
 owner_user_id TEXT NOT NULL, project_id TEXT NOT NULL, source_runtime_id TEXT NOT NULL,
 utc_day TEXT NOT NULL, member_user_id TEXT NOT NULL,
 calls INTEGER NOT NULL CHECK(calls>=0), seconds_used INTEGER NOT NULL CHECK(seconds_used>=0),
 seconds_reserved INTEGER NOT NULL CHECK(seconds_reserved>=0),
 PRIMARY KEY(owner_user_id,project_id,source_runtime_id,utc_day,member_user_id)
) STRICT;
`;

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CloudApiPutInputSchema, HostedAgentRequestInputSchema, HostedHistorySummaryInputSchema, HostedGithubTaskInputSchema } from "../src/index.js";

test("personal API wire contract rejects URLs, headers, key whitespace and unpinned profile selection", () => {
  const input = { profile_id: `api-${randomUUID()}`, content: "hello", idempotency_key: "fixture-request" };
  assert.equal(HostedAgentRequestInputSchema.safeParse(input).success, false);
  assert.equal(HostedAgentRequestInputSchema.safeParse({ ...input, api_config_revision: randomUUID() }).success, true);
  assert.equal(HostedAgentRequestInputSchema.safeParse({ ...input, profile_id: "default", api_config_revision: randomUUID() }).success, false);
  assert.equal(HostedHistorySummaryInputSchema.safeParse({ profile_id: input.profile_id, source_event_ids: ["message"], idempotency_key: "fixture-summary" }).success, false);
  assert.equal(HostedGithubTaskInputSchema.safeParse(input).success, false);
  const config = { expected_revision: null, provider_id: "openai", label: "My API", model: "fixture-chat", enabled: true, api_key: "synthetic-provider-key" };
  for (const field of [{ base_url: "https://127.0.0.1" }, { headers: { Authorization: "synthetic" } }, { api_key: "key\nwith-newline" }]) {
    assert.equal(CloudApiPutInputSchema.safeParse({ ...config, ...field }).success, false);
  }
});

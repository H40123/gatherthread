import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PreferencesConfigurationSchema, PreferencesJsonSchema, readConfigurationJson, AGENT_TEAM_CONFIG_JSON_SCHEMA } from "../src/index.js";

test("published editor schemas match the protocol definitions", async () => {
  for (const [file, schema] of [["preferences.v1.schema.json", PreferencesJsonSchema], ["agent-team.v1.schema.json", AGENT_TEAM_CONFIG_JSON_SCHEMA]] as const) {
    const actual = JSON.parse(await readFile(new URL(`../../../../docs/configuration/${file}`, import.meta.url), "utf8"));
    assert.deepEqual(actual, schema);
  }
});

test("portable preferences reject execution authority, invalid defaults and oversized multibyte input", () => {
  const valid = { version: 1, kind: "gatherthread.preferences", settings: { agents: { activeHarness: "cloud", enabledHarnesses: ["cloud"] } } };
  assert.equal(PreferencesConfigurationSchema.safeParse(valid).success, true);
  assert.equal(PreferencesConfigurationSchema.safeParse({ ...valid, enabled: true }).success, false);
  assert.equal(PreferencesConfigurationSchema.safeParse({ ...valid, settings: { agents: { activeHarness: "codex", enabledHarnesses: ["cloud"] } } }).success, false);
  assert.throws(() => readConfigurationJson(JSON.stringify({ content: "中".repeat(44000) })));
  assert.throws(() => readConfigurationJson('{"settings":{"__proto__":{}}}'));
});

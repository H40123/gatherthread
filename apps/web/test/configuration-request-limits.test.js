import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createAgentTeamConfiguration, HostedAgentRequestInputSchema, HostedGithubTaskInputSchema } from "@gatherthread/protocol";
import { CONFIGURATION_SKILL, configurationPrompt, configurationSkillContent } from "../src/configuration-assistant.js";

const source = (await readFile(new URL("../src/main.js", import.meta.url), "utf8")).replace(/\r\n?/gu, "\n");
const functionSource = name => {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m")); assert.notEqual(start, -1, name);
  const tail = source.slice(start), end = tail.indexOf("\n}\n") + 2; assert.ok(end > 1, name); return tail.slice(0, end);
};
const noop = () => {};
const base = () => createAgentTeamConfiguration({ max_calls: 12, max_duration_minutes: 30, draft: {
  name: "Team1", team_prompt: "a".repeat(1800), entry_node_id: "lead",
  nodes: [{ id: "lead", label: "Lead", role: "b".repeat(1000), prompt: "c".repeat(1400), x: 80, y: 100, target: null }], edges: [],
} });
const cloud = { kind: "hosted_agent", locale: "zh-CN" };
const prompt = configurationPrompt("zh-CN");
function requestAt(length, configuration = base()) {
  const overhead = configurationSkillContent(prompt, configuration).length;
  return prompt + "需".repeat(length - overhead);
}
const node = () => ({ value: "", textContent: "", disabled: false, childNodes: [], focus: noop,
  replaceChildren(...children) { this.childNodes = children; } });

test("the reported 4523-character Team fits cloud contracts after compact expansion with room for requirements", () => {
  const configuration = base(), before = JSON.stringify(configuration);
  assert.equal(before.length, 4523);
  const expanded = configurationSkillContent(prompt + "研究与验证", configuration, cloud);
  for (const schema of [HostedAgentRequestInputSchema, HostedGithubTaskInputSchema]) {
    assert.equal(schema.shape.content.maxLength, 6000);
    assert.equal(schema.shape.content.safeParse(expanded).success, true);
  }
  assert.doesNotThrow(() => configurationSkillContent(prompt, configuration, { ...cloud, reserve: 256 }));
  assert.equal(JSON.stringify(configuration), before, "validation must not modify the user's draft");
});

test("expanded configuration requests honor the exact cloud 6000/6001 boundary without truncation", () => {
  const configuration = base(), content = requestAt(6000, configuration);
  const expanded = configurationSkillContent(content, configuration, cloud);
  assert.equal(expanded.length, 6000); assert.ok(expanded.startsWith(content));
  assert.throws(() => configurationSkillContent(content + "需", configuration, cloud), error => {
    assert.equal(error.code, "configuration_request_too_long"); assert.equal(error.limit, 6000); assert.equal(error.length, 6001);
    assert.match(error.message, /6000/u); assert.match(error.message, /JSON/u); return true;
  });
  for (const schema of [HostedAgentRequestInputSchema, HostedGithubTaskInputSchema]) {
    assert.equal(schema.shape.content.safeParse(expanded).success, true);
    assert.equal(schema.shape.content.safeParse(expanded + "需").success, false);
  }
});

test("native and shared requests retain their existing larger limit; ordinary text never invokes the skill", () => {
  const content = requestAt(6001);
  for (const kind of ["agent_request", "shared_agent"]) {
    assert.equal(configurationSkillContent(content, base(), { kind }).length, 6001);
    assert.equal(configurationSkillContent(requestAt(12000), base(), { kind }).length, 12000);
    assert.throws(() => configurationSkillContent(requestAt(12001), base(), { kind }), error => error.limit === 12000);
  }
  const ordinary = "ordinary question ".repeat(800);
  assert.equal(configurationSkillContent(ordinary, base(), cloud), ordinary);
});

function composerFixture({ github = false, harness = "cloud", content = requestAt(6001) } = {}) {
  const calls = [], configuration = base(), app = vm.createContext({
    authenticationGeneration: 1, selectedSessionGeneration: 1, CONFIGURATION_SKILL, configurationSkillContent,
    configurationDrafts: new Map([["session-a", configuration]]), configurationSkillChip: { hidden: false },
    state: { currentUser: { id: "alice" }, project: { id: "project-a" }, session: { id: "session-a", mode: "multi" },
      settings: { composer: { confirmAgentRequest: false }, general: { locale: "zh-CN" } }, sync: { contentRevision: 0 } },
    messageInput: { ...node(), value: content }, sendAgentButton: node(), sendChatButton: node(), sendError: node(),
    currentProjectHarness: () => harness, agentRequestControl: { action: () => "request" },
    CLOUD_AGENT_ENTRY_ENABLED: true, currentCloudProfile: () => ({ id: "free", api_config_revision: 1 }),
    cloudCodeConsent: { submission: () => ({ allowed: true, includeCode: false }) }, hostedAgentStatus: {},
    cloudGithubUi: { start: async (...args) => calls.push(["github", ...args]) },
    api: { appendHostedAgentRequest: async (...args) => calls.push(["cloud", ...args]), getHostedAgentStatus: async () => ({ enabled: true }) },
    element: () => ({ value: github ? "github" : "gt-cloud" }), messageActions: { metadata: () => ({ replyTo: null, mentions: [] }), sent: noop },
    localizer: { t: text => text }, teamsUi: { describeError: error => error.message }, window: { confirm: () => true },
    pendingMessageSend: null, soloDrafts: { submitted: noop }, renderComposerPermissions: noop, createIdempotencyKey: () => "test-request",
  });
  vm.runInContext(["captureWorkspaceScope", "sendMessage"].map(functionSource).join("\n"), app);
  return { app, calls, content, configuration };
}

for (const github of [false, true]) {
  test(`the real composer preserves an oversized cloud ${github ? "GitHub" : "chat"} configuration draft before any API call`, async () => {
    const f = composerFixture({ github }); await f.app.sendMessage("agent_request");
    assert.equal(f.calls.length, 0); assert.equal(f.app.messageInput.value, f.content);
    assert.equal(f.app.configurationDrafts.get("session-a"), f.configuration);
    assert.match(f.app.sendError.textContent, /6000/u); assert.match(f.app.sendError.textContent, /已保留/u);
    assert.equal(f.app.pendingMessageSend, null); assert.equal(f.app.configurationSkillChip.hidden, false);
  });
  test(`the real composer sends the complete boundary-length configuration through cloud ${github ? "GitHub" : "chat"}`, async () => {
    const f = composerFixture({ github, content: requestAt(6000) }); await f.app.sendMessage("agent_request");
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], github ? "github" : "cloud");
    assert.equal(f.calls[0][2].content.length, 6000); assert.ok(f.calls[0][2].content.startsWith(f.content));
    assert.equal(f.app.messageInput.value, ""); assert.equal(f.app.configurationDrafts.has("session-a"), false);
  });
}

test("the real composer still refuses Team execution for the configuration helper before expansion", async () => {
  const f = composerFixture({ harness: "team" }); await f.app.sendMessage("agent_request");
  assert.equal(f.calls.length, 0); assert.equal(f.app.messageInput.value, f.content);
  assert.equal(f.app.sendError.textContent, "Choose an individual Agent to help configure your Team.");
});

function creationFixture(harness) {
  let creations = 0;
  const app = vm.createContext({
    configuringTeam: false, authenticationGeneration: 1, selectedSessionGeneration: 1,
    teamComposerActive: harness === "team", teamComposerScope: "1:1:project-a",
    sharedComposerActive: harness === "shared", sharedComposerScope: "1:1:project-a",
    projectAgentHarness: () => "cloud", configurationPrompt, configurationSkillContent,
    state: { currentUser: { id: "alice" }, project: { id: "project-a", role: "owner" }, session: { id: "session-a" },
      settings: { general: { locale: "zh-CN" } } }, messageInput: { value: "Unsent message" },
    soloDrafts: { has: () => false }, window: { confirm: () => false }, localizer: { t: text => text },
    api: { createSession: () => { creations++; throw new Error("must not create"); } },
  });
  vm.runInContext(["currentProjectHarness", "captureWorkspaceScope", "startTeamConfiguration"].map(functionSource).join("\n"), app);
  return { app, creations: () => creations };
}

test("pre-creation rejects an unusable cloud base while retaining the current Team and message", async () => {
  const f = creationFixture("cloud"), configuration = base(); configuration.draft.nodes[0].prompt += "c".repeat(600);
  assert.ok(JSON.stringify(configuration).length < 6000);
  const before = JSON.stringify(configuration);
  await assert.rejects(f.app.startTeamConfiguration(configuration), error => error.code === "configuration_request_too_long" && error.limit === 6000);
  assert.equal(f.creations(), 0); assert.equal(f.app.messageInput.value, "Unsent message");
  assert.equal(JSON.stringify(configuration), before); assert.equal(f.app.configuringTeam, false);
});

test("pre-creation reads the actual shared selection rather than the stored cloud default", async () => {
  const f = creationFixture("shared"), configuration = base(); configuration.draft.nodes[0].prompt += "c".repeat(600);
  assert.equal(f.app.currentProjectHarness(), "shared");
  assert.equal(await f.app.startTeamConfiguration(configuration), false, "the existing explicit replace-draft cancellation remains effective");
  assert.equal(f.creations(), 0); assert.equal(f.app.messageInput.value, "Unsent message");
  f.app.selectedSessionGeneration++;
  assert.equal(f.app.currentProjectHarness(), "cloud", "stale selection never changes a new session's route");
});

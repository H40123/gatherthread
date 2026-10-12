import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { composerAgentAction } from "../src/agent-request-control.js";

const cloudRequest = { id: "cloud-request", type: "agent_request", actor: { id: "me" },
  payload: { profile_id: "free", execution_profile: { harness: "opencode", model: "free-model" } } };
test("cloud pending messages never wait for a local connector", () => {
  const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  const body = source.match(/function renderAgentPendingStatus\(request, progressEvents = \[\]\) \{[\s\S]*?\n\}/)[0];
  const createElement = () => ({ children: [], dataset: {}, setAttribute() {}, append(...nodes) { this.children.push(...nodes); } });
  const sandbox = { document: { createElement }, state: { session: { members: [] } },
    isExecutionRuntime: () => false, localizer: { t: text => text },
    latestStreamedText: (events) => events?.length ? "Reading the parser" : "" };
  vm.createContext(sandbox); vm.runInContext(body, sandbox);
  const pending = sandbox.renderAgentPendingStatus(cloudRequest);
  assert.equal(pending.dataset.state, "answering");
  assert.match(pending.children[1].textContent, /Cloud Agent/);
  assert.doesNotMatch(pending.children[1].textContent, /local runtime/);

  const streamed = sandbox.renderAgentPendingStatus(cloudRequest, [{ payload: { content: "x" } }]);
  assert.equal(streamed.dataset.streamed, "true");
  assert.equal(streamed.children[1].textContent, "Agent: Working");
  assert.doesNotMatch(streamed.children[1].textContent, /Reading the parser/,
    "the full answer is displayed in its section, not repeated in the compact status");
});

test("cloud progress uses cloud controls without exposing the local claim route", () => {
  const progress = { type: "agent_progress", replyTo: cloudRequest.id, payload: { status: "working" } };
  assert.equal(composerAgentAction([cloudRequest, progress], "me").action, "pause");
  assert.equal(composerAgentAction([cloudRequest, progress], "me").cloud, true);
  assert.equal(composerAgentAction([{ ...cloudRequest, payload: { ...cloudRequest.payload, github_task_id: "fixture" } }, progress], "me").action, "wait");
  assert.equal(composerAgentAction([cloudRequest, { type: "agent_response", replyTo: cloudRequest.id }], "me").action, "request");
});

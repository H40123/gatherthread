import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLiveOutputPublisher, type LiveOutputUpdate } from "@gatherthread/adapters";
import { CodexAppServerClient } from "../src/codex-app-server.js";
import { createCodexLiveOutputMapper } from "../src/codex-live-output.js";

test("Codex live scope queues the fast current turn and refuses old or turnless work", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "gt-codex-stream-scope-"));
  const script = path.join(dir, "fake.mjs");
  await writeFile(script, `import {createInterface} from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
for await (const line of createInterface({input:process.stdin})) {
const m=JSON.parse(line); if(m.method==='initialized')continue;
if(m.method==='turn/start') {
 for(const turnId of ['old', undefined, 'current']) send({method:'item/agentMessage/delta',params:{threadId:m.params.threadId,turnId,itemId:'answer',delta:turnId==='current'?'Public text ':'UNRELATED PRIVATE '}});
 send({method:'item/completed',params:{threadId:m.params.threadId,turnId:'old',item:{type:'agentMessage',id:'old',text:'WRONG TURN'}}});
 send({method:'turn/plan/updated',params:{threadId:m.params.threadId,turnId:'current',plan:[{step:'Test',status:'inProgress'}]}});
 send({method:'item/reasoning/textDelta',params:{threadId:m.params.threadId,turnId:'current',itemId:'reason',delta:'HIDDEN REASONING'}});
 send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'old',status:'completed',items:[]}}});
 send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'current',status:'completed',items:[{type:'agentMessage',id:'answer',text:'Public text'}]}}});
 send({id:m.id,result:{turn:{id:'current'}}});
} else send({id:m.id,result:{}});
}`);
  const client = new CodexAppServerClient({ command: process.execPath, commandArgs: [script], cwd: dir, turnTimeoutMs: 2000 });
  t.after(() => client.dispose());
  const output: string[] = [], work: string[] = [], completed: unknown[] = [];
  const result = await client.runTurn({ threadId: "owned-thread", prompt: "Fixture", clientUserMessageId: "request",
    onItemDelta: (_id, delta) => { output.push(delta); }, onItemCompleted: item => { completed.push(item); },
    onNativeWork: method => { work.push(method); } });
  assert.equal(result.turnId, "current"); assert.deepEqual(output, ["Public text "]); assert.deepEqual(completed, []);
  assert.ok(work.includes("turn/plan/updated")); assert.ok(!work.includes("item/reasoning/textDelta"));
});

test("Codex streams public tools and plan states without private IDs, prompts or raw reasoning", async () => {
  const updates: LiveOutputUpdate[] = [];
  const publisher = createLiveOutputPublisher({ schedule: false, publish: update => { updates.push(update); } });
  const mapper = createCodexLiveOutputMapper(publisher, { shareTools: true });
  await mapper.accept("item/started", { item: { type: "commandExecution", id: "native-private", command: "npm test", status: "inProgress", cwd: "/private/user/location", processId: "private-process", systemPrompt: "private-instructions" } });
  await mapper.accept("item/commandExecution/outputDelta", { itemId: "native-private", delta: "tests passed\n" });
  await mapper.accept("item/completed", { item: { type: "commandExecution", id: "native-private", command: "npm test", status: "completed", exitCode: 0, aggregatedOutput: "tests passed\n" } });
  await mapper.accept("turn/plan/updated", { plan: [{ step: "Fix parser", status: "inProgress" }, { step: "Test", status: "pending" }] });
  await mapper.accept("item/reasoning/textDelta", { itemId: "hidden", delta: "private reasoning" });
  await publisher.finish();
  assert.ok(updates.some(update => update.streamKind === "tool" && update.content.includes("tests passed")));
  assert.equal(updates.findLast(update => update.streamKind === "plan")?.plan?.[0]?.status, "in_progress");
  assert.doesNotMatch(JSON.stringify(updates), /native-private|private-process|private-instructions|private\/user|private reasoning/);
});

test("completed native commands with a nonzero exit remain failed in the work log", async () => {
  const updates: LiveOutputUpdate[] = [];
  const publisher = createLiveOutputPublisher({ schedule: false, publish: update => { updates.push(update); } });
  const mapper = createCodexLiveOutputMapper(publisher, { shareTools: true });
  await mapper.accept("item/completed", { item: { type: "commandExecution", id: "failed-command", command: "npm test", status: "completed", exitCode: 1, aggregatedOutput: "One test failed\n" } });
  await publisher.finish();
  assert.equal(updates.at(-1)?.streamState, "failed");
  assert.match(updates.at(-1)?.content ?? "", /Exit: 1/);
});

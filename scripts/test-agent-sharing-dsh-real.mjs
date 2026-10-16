import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const repository = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const install = process.env.GATHERTHREAD_DSH_NPM_ROOT;
const output = process.env.GATHERTHREAD_SHARED_TEST_OUTPUT;
assert.ok(install && path.isAbsolute(install), 'Supply an installed pinned DSH package directory; this gate never downloads software.');
assert.ok(output && path.isAbsolute(output), 'Supply a private synthetic test output directory.');
assert.equal(JSON.parse(await readFile(path.join(install, 'package.json'), 'utf8')).version, '0.1.7-rc.2');
await mkdir(output, { recursive: true, mode: 0o700 });
const root = await mkdtemp(path.join(output, 'native-dsh-sharing-'));
const home = path.join(root, 'home'), project = path.join(root, 'project'), plugin = path.join(root, 'plugin');
for (const folder of [home, project, plugin]) await mkdir(folder, { mode: 0o700 });
await writeFile(path.join(project, 'inside.txt'), 'INSIDE_PROJECT_FIXTURE');
await writeFile(path.join(root, 'outside.txt'), 'OUTSIDE_PROJECT_FIXTURE');
await symlink(path.join(root, 'outside.txt'), path.join(project, 'escape'));
await symlink(path.dirname(path.dirname(install)), path.join(plugin, 'node_modules'), 'dir');
const context = { view: 'original', through_sequence: 0, content_revision: 0, items: [] };
const digest = createHash('sha256').update(JSON.stringify(context, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest('hex');
const capsule = { version: 1, source_runtime_id: 'runtime-a', owner_device_id: 'device-a', content: 'Use the permitted project file tools; then return a public result.',
  context, context_digest: digest, content_revision: 0, through_sequence: 0, claim_attempt: 1, lease_expires_at: new Date(Date.now() + 60000).toISOString(),
  deadline_at: new Date(Date.now() + 720000).toISOString(), max_request_seconds: 720, sandbox_scope: 'project_only',
  job: { id: 'job', project_id: 'project', share_id: 'share', share_revision: 1, session_id: 'solo-b', request_event_id: 'request-b',
    status: 'running', requester_user_id: 'b', requester_display_name: 'B', execution_profile: { harness: 'deepseek-harness', provider: 'deepseek-official', model: 'deepseek-flash' },
    created_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 720000).toISOString(), finished_at: null, error_code: null, cleanup_pending: false } };
const capsulePath = path.join(root, 'capsule.json'), reportPath = path.join(root, 'result.json');
await writeFile(capsulePath, JSON.stringify(capsule), { mode: 0o600 });
const source = path.join(plugin, 'source.mjs'), bundle = path.join(plugin, 'plugin.mjs');
await writeFile(source, `
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {DshSharedAgentExecutor} from ${JSON.stringify(path.join(repository, 'packages/dsh-host/dist/src/shared-agent-executor.js'))};
import {freezeMessage} from '@deepseek-ai/dsh-llm';
export const name='gatherthread-native-sharing-acceptance';
export const inject=['agents','sessions','llm','tools','agentLoop'];
export function apply(ctx) {
 let executor, owner;
 const abort=new AbortController();
 ctx.effect(()=>{
  void (async()=>{
   try {
    owner=await ctx.agents.create({sessionId:'ordinary-owner-fixture',meta:{cwd:${JSON.stringify(project)}},agentOptions:{provider:'deepseek-official',model:'deepseek-flash'}});
    owner.agent.session.append('user/message',freezeMessage({id:'owner-private-fixture',role:'user',content:[{type:'text',text:'OWNER_PRIVATE_HISTORY_FIXTURE'}],source:{kind:'user'}}),{surfaceOp:'append'});
    const ownerHistory=()=>JSON.stringify(owner.agent.session.snapshotEvents(0).filter(event=>event.type!=='session/title'));
    const ownerBefore=ownerHistory();
    executor=new DshSharedAgentExecutor({context:ctx,workspacePath:${JSON.stringify(project)}});
    assert.ok(await executor.preflight(),'native sharing preflight refused');
    const capsule=JSON.parse(await readFile(${JSON.stringify(capsulePath)},'utf8'));
    const result=await executor.execute(capsule,abort.signal);
    assert.equal(result.content,'Public project result.');
    assert.equal(await readFile(${JSON.stringify(path.join(project, 'new.txt'))},'utf8'),'SHARED_WRITE_FIXTURE');
    assert.equal(await readFile(${JSON.stringify(path.join(root, 'outside.txt'))},'utf8'),'OUTSIDE_PROJECT_FIXTURE');
    const cancel=new AbortController();
    const pending=executor.execute({...capsule,job:{...capsule.job,id:'cancel-job'},content:'CANCEL_FIXTURE'},cancel.signal);
    const timer=setTimeout(()=>cancel.abort(new Error('synthetic lock')),1200);
    await assert.rejects(pending); clearTimeout(timer);
    assert.equal(ownerHistory(),ownerBefore,'shared calls must not mutate ordinary owner content');
    await executor.close();
    await writeFile(${JSON.stringify(reportPath)},JSON.stringify({passed:true,dshVersion:'0.1.7-rc.2',isolated:true,ownerHistoryUnchanged:true,projectTools:true,ordinaryToolsDenied:true,cancelled:true}),{mode:0o600});
   } catch(error) { await writeFile(${JSON.stringify(reportPath)},JSON.stringify({passed:false,errorType:error.name,safeMessage:String(error.message).slice(0,400)}),{mode:0o600}); }
  })();
  return async()=>{abort.abort();await executor?.close();await owner?.dispose();};
 });
}
`);
await createRequire(path.join(repository, 'package.json'))('esbuild').build({ entryPoints: [source], outfile: bundle,
  bundle: true, platform: 'node', target: 'node24', format: 'esm', external: ['@deepseek-ai/*'], logLevel: 'warning' });
let calls = 0, heldConnection = false, closedHeld = false, fixtureFailure;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST'); assert.ok(request.url.endsWith('/messages'));
    let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 256000); }
    const body = JSON.parse(raw); calls++;
    assert.equal(body.model, 'deepseek-flash');
    assert.ok(!raw.includes('OWNER_PRIVATE_HISTORY_FIXTURE') && !raw.includes('OWNER_PRIVATE_PROMPT_FIXTURE'));
    const tools = (body.tools ?? []).map(tool => tool.name); assert.ok(tools.every(name => name.startsWith('gatherthread_project_')));
    assert.ok(tools.includes('gatherthread_project_read'));
    let block, stop = 'tool_use';
    if (calls === 1) block = { type: 'tool_use', id: 'read-fixture', name: 'gatherthread_project_read', input: { path: 'inside.txt' } };
    else if (calls === 2) { assert.ok(raw.includes('INSIDE_PROJECT_FIXTURE')); block = { type: 'tool_use', id: 'write-fixture', name: 'gatherthread_project_write', input: { path: 'new.txt', content: 'SHARED_WRITE_FIXTURE' } }; }
    else if (calls === 3) block = { type: 'tool_use', id: 'forbidden-shell', name: 'bash', input: { command: 'exit 0', description: 'Forbidden synthetic shell' } };
    else if (calls === 4) {
      const denied = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find(block => block.type === 'tool_result' && block.tool_use_id === 'forbidden-shell');
      assert.equal(denied?.is_error, true, 'Forbidden native shell must return an error without dispatch.');
      block = { type: 'text', text: 'Public project result.' }; stop = 'end_turn';
    }
    else { assert.equal(calls, 5); assert.ok(raw.includes('CANCEL_FIXTURE')); heldConnection = true; }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const send = value => response.write('event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n');
    send({ type: 'message_start', message: { id: 'fixture-message-' + calls, type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } });
    if (!block) { response.once('close', () => { closedHeld = true; }); return; }
    send({ type: 'content_block_start', index: 0, content_block: block }); send({ type: 'content_block_stop', index: 0 });
    send({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }); send({ type: 'message_stop' }); response.end();
  } catch (error) { fixtureFailure = error.message; response.destroy(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/anthropic`;
const patch = path.join(root, 'test.cordis.patch.yml');
await writeFile(patch, `- id: llm-deepseek\n  config:\n    thinking: disabled\n    baseURL: ${JSON.stringify(endpoint)}\n- id: system-prompt\n  config:\n    includeHarnessIdentity: false\n    includeRuntimeContext: false\n    personaPrefix: OWNER_PRIVATE_PROMPT_FIXTURE\n- insert:\n    - id: shared-native-fixture\n      name: ${JSON.stringify(pathToFileURL(bundle).href)}\n      inject: [agents,sessions,llm,tools,agentLoop]\n`, { mode: 0o600 });
const child = spawn(process.execPath, [path.join(install, 'lib/bin.js'), '--profile', 'sdk-minimal', '--patch', patch], {
  cwd: project, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? 'C.UTF-8',
    DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'synthetic-not-a-real-key', NO_COLOR: '1' }, stdio: ['pipe', 'ignore', 'pipe'], shell: false });
let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-20000); });
try {
  let report;
  for (let attempt = 0; attempt < 600; attempt++) {
    report = await readFile(reportPath, 'utf8').then(JSON.parse).catch(() => undefined);
    if (report || fixtureFailure || child.exitCode !== null) break;
    await delay(100);
  }
  if (!report) { await writeFile(path.join(root, 'diagnostic.log'), stderr.replaceAll('synthetic-not-a-real-key', '[FIXTURE KEY]'), { mode: 0o600 }); }
  assert.ok(report, fixtureFailure ?? 'Native fixture did not settle; see private synthetic diagnostic.');
  assert.equal(report.passed, true, report.safeMessage);
  assert.equal(calls, 5); assert.ok(heldConnection && closedHeld, 'Cancellation must close the actual native provider transport.');
  process.stdout.write(JSON.stringify({ ...report, calls, realModelCalls: 0, nativeProviderTransportClosed: true }) + '\n');
} finally {
  child.kill('SIGTERM'); for (let i = 0; i < 20 && child.exitCode === null; i++) await delay(50);
  if (child.exitCode === null) child.kill('SIGKILL'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}

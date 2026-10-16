// Installed Codex protocol acceptance against a loopback Responses fixture.
// No real account credentials, external model calls, or production data.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CodexSharedAgentExecutor, CodexAppServerClient, stableSharedContextJson } from '../packages/bridge/dist/src/index.js';

const command = process.env.GATHERTHREAD_CODEX_COMMAND;
const output = process.env.GATHERTHREAD_SHARED_TEST_OUTPUT;
assert.ok(command && path.isAbsolute(command), 'Supply the absolute installed official Codex executable.');
assert.ok(output && path.isAbsolute(output), 'Supply a private synthetic output directory.');
await mkdir(output, { recursive: true, mode: 0o700 });
const root = await realpath(await mkdtemp(path.join(output, 'native-codex-sharing-')));
const project = path.join(root, 'project'), control = path.join(root, 'private'), auth = path.join(root, 'fixture-auth.json');
await mkdir(project, { mode: 0o700 });
await writeFile(auth, JSON.stringify({ OPENAI_API_KEY: 'gatherthread-local-synthetic-key' }), { mode: 0o600 });
await writeFile(path.join(project, 'inside.txt'), 'INSIDE_PROJECT_FIXTURE');
await writeFile(path.join(root, 'outside.txt'), 'OUTSIDE_PROJECT_FIXTURE');
await symlink(path.join(root, 'outside.txt'), path.join(project, 'escape'));
let calls = 0, catalog = [], fixtureFailure, holdStarted = false, holdClosed = false;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.ok(request.url?.endsWith('/responses'), 'Only the loopback Responses protocol is accepted');
    let raw = ''; for await (const bytes of request) { raw += bytes; assert.ok(raw.length < 512000); }
    const body = JSON.parse(raw); calls++;
    assert.ok(!raw.includes('OWNER_PRIVATE_HISTORY_FIXTURE'));
    catalog = (body.tools ?? []).map(tool => tool.name ?? tool.type);
    await writeFile(path.join(root, 'tool-catalog.json'), JSON.stringify({ tools: catalog, realModelCalls: 0 }), { mode: 0o600 });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const emit = event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const id = `fixture-response-${calls}`, msgId = `fixture-message-${calls}`;
    emit({ type: 'response.created', response: { id, object: 'response', created_at: 1, status: 'in_progress', output: [] } });
    if (calls === 6) { holdStarted = true; response.once('close', () => { holdClosed = true; }); return; }
    let item;
    if (calls < 5) {
      const name = calls === 1 ? 'gatherthread_project_read' : calls === 2 ? 'gatherthread_project_write' : calls === 3 ? 'gatherthread_project_read' : 'exec_command';
      const args = calls === 1 ? { path: 'inside.txt' } : calls === 2 ? { path: 'written.txt', content: 'SHARED_WRITE_FIXTURE' } : calls === 3 ? { path: 'escape' } : { cmd: 'printf forbidden' };
      if (calls === 2) assert.ok(raw.includes('INSIDE_PROJECT_FIXTURE'), 'actual dynamic file read result must reach the native next request');
      if (calls === 4) assert.ok(raw.includes('operation refused'), 'symlink escape must be refused');
      item = { id: `fixture-function-${calls}`, type: 'function_call', call_id: `fixture-call-${calls}`, name, arguments: JSON.stringify(args), status: 'completed' };
    } else {
      assert.equal(calls, 5); assert.ok(raw.includes('exec_command'), 'unknown shell tool must return a public refusal');
      item = { id: msgId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Public project result.', annotations: [] }] };
    }
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    if (item.type === 'message') {
      emit({ type: 'response.content_part.added', item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      emit({ type: 'response.output_text.delta', item_id: msgId, output_index: 0, content_index: 0, delta: 'Public project result.' });
      emit({ type: 'response.output_text.done', item_id: msgId, output_index: 0, content_index: 0, text: 'Public project result.' });
    }
    emit({ type: 'response.output_item.done', output_index: 0, item });
    emit({ type: 'response.completed', response: { id, object: 'response', created_at: 1, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    response.end();
  } catch (error) { fixtureFailure = error; response.writeHead(500); response.end('Synthetic acceptance failed.'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const context = { view: 'original', through_sequence: 0, content_revision: 0, items: [] };
const deadline = new Date(Date.now() + 60000).toISOString();
const profile = { harness: 'codex', provider: 'openai', model: 'gpt-5.3-codex', reasoning_effort: 'high' };
const capsule = { version: 1, source_runtime_id: 'fixture-runtime', owner_device_id: 'fixture-device', content: 'Return a public project result.',
  context, context_digest: createHash('sha256').update(stableSharedContextJson(context)).digest('hex'), content_revision: 0, through_sequence: 0,
  claim_attempt: 1, lease_expires_at: new Date(Date.now() + 15000).toISOString(), deadline_at: deadline, max_request_seconds: 60, sandbox_scope: 'project_only',
  job: { id: 'fixture-job', project_id: 'fixture-project', share_id: 'fixture-share', share_revision: 1, session_id: 'fixture-solo', request_event_id: 'fixture-request', status: 'running',
    requester_user_id: 'fixture-b', requester_display_name: 'Fixture B', execution_profile: profile, created_at: new Date().toISOString(), deadline_at: deadline, finished_at: null, error_code: null, cleanup_pending: false } };
const executor = new CodexSharedAgentExecutor({ command, workspacePath: project, privateStateRoot: control, authSourcePath: auth,
  clientFactory: options => {
    const client = new CodexAppServerClient({ ...options, env: { ...options.env, GATHERTHREAD_LOOPBACK_FIXTURE_KEY: 'synthetic-local-key' }, commandArgs: [
      '-c', 'model_providers.gatherthread_fixture.name="Synthetic loopback only"',
      '-c', `model_providers.gatherthread_fixture.base_url=${JSON.stringify(baseUrl)}`,
      '-c', 'model_providers.gatherthread_fixture.env_key="GATHERTHREAD_LOOPBACK_FIXTURE_KEY"',
      '-c', 'model_providers.gatherthread_fixture.wire_api="responses"',
      '-c', 'model_providers.gatherthread_fixture.requires_openai_auth=false',
      '-c', 'model_providers.gatherthread_fixture.supports_websockets=false',
    ] });
    const request = client.request.bind(client);
    client.request = async (method, input, ...rest) => {
      // The test-only client maps the fixed production provider to an explicit
      // custom loopback provider. Built-in OpenAI endpoints cannot be overridden.
      const result = await request(method, method === 'thread/start' ? { ...input, modelProvider: 'gatherthread_fixture' } : input, ...rest);
      if (method === 'thread/start') await writeFile(path.join(root, 'native-start-metadata.json'), JSON.stringify({ keys: Object.keys(result), model: result.model, modelProvider: result.modelProvider, activePermissionProfile: result.activePermissionProfile, approvalPolicy: result.approvalPolicy, cwd: result.cwd, runtimeWorkspaceRoots: result.runtimeWorkspaceRoots, instructionSources: result.instructionSources }), { mode: 0o600 });
      return method === 'thread/start' ? { ...result, modelProvider: 'openai' } : result;
    };
    return client;
  } });
try {
  assert.ok(await executor.preflight(), 'Native project permission probe must pass before execution');
  const result = await executor.execute(capsule, AbortSignal.timeout(55000));
  assert.equal(fixtureFailure, undefined, fixtureFailure?.message);
  assert.equal(result.content, 'Public project result.');
  assert.equal(await readFile(path.join(project, 'written.txt'), 'utf8'), 'SHARED_WRITE_FIXTURE');
  assert.equal(await readFile(path.join(root, 'outside.txt'), 'utf8'), 'OUTSIDE_PROJECT_FIXTURE');
  const allowed = new Set(['gatherthread_project_list', 'gatherthread_project_read', 'gatherthread_project_write', 'update_plan', 'request_user_input']);
  assert.ok(catalog.includes('gatherthread_project_read'));
  assert.deepEqual(catalog.filter(name => !allowed.has(name)), [], 'Shared Codex must not expose additional executable capabilities');
  const cancel = new AbortController();
  const pending = executor.execute({ ...capsule, job: { ...capsule.job, id: 'fixture-cancel-job' } }, cancel.signal);
  const timer = setTimeout(() => cancel.abort(new Error('synthetic device lock')), 1800);
  await assert.rejects(pending); clearTimeout(timer);
  assert.ok(holdStarted && holdClosed, 'actual native provider transport must close before shared cancellation settles');
  const report = { passed: true, catalog, calls, realModelCalls: 0, dynamicProjectReadWrite: true, symlinkEscapeDenied: true, shellToolDenied: true, nativeProviderTransportClosed: true };
  await writeFile(path.join(root, 'result.json'), JSON.stringify(report), { mode: 0o600 });
  process.stdout.write(JSON.stringify(report) + '\n');
} catch (error) {
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ passed: false, stage: catalog.length ? 'tool-catalog' : 'native-execution', errorType: error.name, safeMessage: error.message, catalog, realModelCalls: 0 }), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ passed: false, stage: catalog.length ? 'tool-catalog' : 'native-execution', errorType: error.name, safeMessage: error.message, catalog, realModelCalls: 0 }) + '\n'); process.exitCode = 1;
} finally { await executor.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

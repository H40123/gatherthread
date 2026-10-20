import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CreateSessionInputSchema, UpdateSessionInputSchema } from "@gatherthread/protocol";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { ApiError } from "../src/errors.js";
import { startCollaborationServer } from "../src/server.js";
import { WebSocket } from "ws";

function seed(database: CollaborationDatabase) {
  const service = new CollaborationService(database);
  const owner = database.bootstrapIdentity({ display_name: "Project owner", device_name: "Owner device" });
  const creator = database.createIdentity({ display_name: "Solo creator", device_name: "Creator device" });
  const viewer = database.createIdentity({ display_name: "Viewer", device_name: "Viewer device" });
  const participant = database.createIdentity({ display_name: "Participant", device_name: "Participant device" });
  const project = service.createProject(owner.actor, { title: "Visibility project", idempotency_key: "project" });
  for (const identity of [creator, participant, viewer]) database.sqlite.prepare(
    "INSERT INTO project_memberships(project_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)"
  ).run(project.id, identity.actor.user_id, identity === viewer ? "viewer" : "participant", new Date().toISOString(), new Date().toISOString());
  const input = { project_id: project.id, mode: "solo" as const, title: "Personal notes", idempotency_key: "private", visibility: "private" as const };
  const { session } = service.createSession(creator.actor, input);
  return { service, owner, creator, participant, viewer, project, input, session };
}
const denied = (error: unknown) => error instanceof ApiError && error.status === 404;

test("private Solo is hidden from every other role, including the project owner, at all read boundaries", t => {
  const db = new CollaborationDatabase(":memory:"); t.after(() => db.close());
  const f = seed(db);
  const event = f.service.appendEvent(f.creator.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "chat", payload: { content: "Personal draft" } });
  assert.equal(f.service.getSession(f.creator.actor, f.session.id).session.visibility, "private");
  assert.equal(f.service.listProjectSessions(f.creator.actor, f.project.id)[0]!.member_count, 1);
  assert.equal(db.listSessionMembers(f.session.id).length, 1);
  assert.equal(f.service.listProjects(f.creator.actor)[0]!.session_count, 1);
  for (const identity of [f.owner, f.participant, f.viewer]) {
    const actor = identity.actor;
    assert.equal(f.service.listSessions(actor).length, 0);
    assert.equal(f.service.listProjectSessions(actor, f.project.id).length, 0);
    assert.equal(f.service.listProjects(actor)[0]!.session_count, 0);
    assert.equal(f.service.canReadEvent(actor, event), false);
    assert.throws(() => f.service.getSession(actor, f.session.id), denied);
    assert.throws(() => f.service.replay(actor, f.session.id, 0, 100), denied);
    assert.throws(() => f.service.listMembers(actor, f.session.id), denied);
    assert.throws(() => f.service.readHistoryContext(actor, f.session.id), denied);
    assert.throws(() => f.service.createSnapshotRequest(actor, f.session.id), denied);
    assert.throws(() => f.service.registerRuntime(actor, { session_id: f.session.id,
      device_id: actor.device_id, harness: "codex", provider: "fixture", model: "fixture",
      local_session_id: "fixture-local", capture_fidelity: "harness_transcript" }), denied);
    assert.throws(() => f.service.deleteSession(actor, f.session.id), denied);
    assert.throws(() => f.service.createInvitation(actor, f.session.id, { role: "viewer" }), denied);
  }
});

test("project-visible Solo keeps existing read-only observers and omitted visibility stays compatible", t => {
  const db = new CollaborationDatabase(":memory:"); t.after(() => db.close());
  const f = seed(db);
  const input = { ...f.input, visibility: "project" as const, idempotency_key: "shared" };
  const { session } = f.service.createSession(f.creator.actor, input);
  for (const identity of [f.owner, f.participant, f.viewer]) {
    assert.equal(f.service.getSession(identity.actor, session.id).session.visibility, "project");
    assert.throws(() => f.service.appendEvent(identity.actor, session.id, { type: "human_chat", visibility: "session", idempotency_key: "blocked", payload: { content: "No write" } }), (e: unknown) => e instanceof ApiError && e.status === 403);
  }
  const legacy = { project_id: f.project.id, mode: "solo" as const, title: "Legacy", idempotency_key: "legacy" };
  const first = f.service.createSession(f.creator.actor, legacy);
  assert.equal(first.session.visibility, "project");
  assert.equal(f.service.createSession(f.creator.actor, { ...legacy, visibility: "project" }).event.id, first.event.id);
});

test("private creation retries bind the audience; viewers, unauthorized conversion and revoked devices fail closed", t => {
  const db = new CollaborationDatabase(":memory:"); t.after(() => db.close());
  const f = seed(db);
  assert.equal(f.service.createSession(f.creator.actor, f.input).session.id, f.session.id);
  assert.throws(() => f.service.createSession(f.creator.actor, { ...f.input, visibility: "project" }), (e: unknown) => e instanceof ApiError && e.code === "idempotency_conflict");
  assert.throws(() => f.service.createSession(f.viewer.actor, { ...f.input, idempotency_key: "viewer" }));
  assert.equal(f.service.createSession(f.owner.actor, { ...f.input, mode: "multi", idempotency_key: "private-multi" }).session.visibility, "private");
  assert.throws(() => f.service.updateSession(f.creator.actor, f.session.id, { mode: "multi", idempotency_key: "expose" }));
  assert.throws(() => f.service.createSession(f.owner.actor, { ...f.input, session_id: f.session.id }), denied);
  f.service.revokeDevice(f.creator.actor, f.creator.actor.device_id);
  assert.throws(() => f.service.getSession(f.creator.actor, f.session.id));
  assert.throws(() => f.service.createSession(f.creator.actor, { ...f.input, idempotency_key: "revoked" }));
});

test("wire contracts accept both modes, reject unknown audiences and require the dedicated per-member mutation", () => {
  const input = { title: "Test", mode: "solo", idempotency_key: "create-session-key" };
  assert.equal(CreateSessionInputSchema.safeParse({ ...input, visibility: "private" }).success, true);
  assert.equal(CreateSessionInputSchema.safeParse({ ...input, mode: "multi", visibility: "private" }).success, true);
  assert.equal(CreateSessionInputSchema.safeParse({ ...input, visibility: "public" }).success, false);
  assert.equal(UpdateSessionInputSchema.safeParse({ title: "Rename", visibility: "project", idempotency_key: "rename" }).success, false);
});

test("mode conversion preserves individual visibility, and downgraded creators stay read-only", t => {
  const db = new CollaborationDatabase(":memory:"); t.after(() => db.close());
  const f = seed(db);
  const own = f.service.createSession(f.owner.actor, { ...f.input, idempotency_key: "owner-private" }).session;
  assert.equal(f.service.updateSession(f.owner.actor, own.id, { mode: "multi", idempotency_key: "owner-convert" }).session.visibility, "private");
  assert.equal(db.membershipRole(own.id,f.creator.actor.user_id),null);
  assert.equal(f.service.updateSession(f.owner.actor, own.id, { title: "Renamed private Solo", idempotency_key: "private-rename" }).session.visibility, "private");
  db.setProjectMembership(f.owner.actor, f.project.id, f.creator.actor.user_id, "viewer");
  assert.equal(f.service.getSession(f.creator.actor, f.session.id).session.visibility, "private");
  assert.throws(() => f.service.appendEvent(f.creator.actor, f.session.id, { type: "human_chat", visibility: "session",
    payload: { content: "Read only" }, idempotency_key: "downgraded-write" }), e => e instanceof ApiError && e.status === 403);
  db.removeProjectMembership(f.creator.actor, f.project.id, f.creator.actor.user_id);
  assert.throws(() => f.service.getSession(f.creator.actor, f.session.id), denied);
});

test("existing SQLite sessions migrate with their project-wide visibility; private choice survives reopening", t => {
  const directory = mkdtempSync(join(tmpdir(), "gt-visibility-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "data.sqlite");
  let db = new CollaborationDatabase(file);
  const f = seed(db);
  db.close();
  const old = new DatabaseSync(file);
  old.exec(`DROP VIEW session_readers; DROP TABLE session_visibility_receipts;
    DROP TABLE session_member_visibility; ALTER TABLE sessions DROP COLUMN visibility_revision;
    ALTER TABLE sessions DROP COLUMN visibility`); old.close();
  db = new CollaborationDatabase(file);
  assert.equal(db.requireSession(f.session.id).visibility, "project");
  assert.equal(db.listProjectSessions(f.project.id, f.owner.actor.user_id).length, 1);
  const created = db.createSession(f.creator.actor, { ...f.input, idempotency_key: "after-upgrade" });
  db.setSessionMemberVisibility(f.creator.actor,created.session.id,f.viewer.actor.user_id,{visible:true,expected_revision:0,idempotency_key:"persist-grant"});
  db.setSessionMemberVisibility(f.creator.actor,f.session.id,f.owner.actor.user_id,{visible:false,expected_revision:0,idempotency_key:"persist-denial"});
  db.close(); db = new CollaborationDatabase(file);
  assert.equal(db.requireSession(created.session.id).visibility, "private");
  assert.equal(db.membershipRole(created.session.id, f.owner.actor.user_id), null);
  assert.equal(db.membershipRole(created.session.id,f.viewer.actor.user_id),"viewer");
  assert.equal(db.membershipRole(f.session.id,f.owner.actor.user_id),null);
  db.close();
});

test("real HTTP denies private metadata, replay, context, avatars, invitations and realtime tickets", async t => {
  const running = await startCollaborationServer({ databasePath: ":memory:" }, 0);
  t.after(() => running.close());
  const f = seed(running.database);
  for (const identity of [f.owner, f.participant, f.viewer]) {
    for (const suffix of ["", "/events", "/members", "/context", "/avatar-profiles", "/invitations"]) {
      const response = await fetch(`${running.origin}/v1/sessions/${f.session.id}${suffix}`, { headers: { authorization: `Bearer ${identity.token}` } });
      assert.equal(response.status, 404, `${suffix || 'metadata'} is private to creator`);
      assert.equal((await response.text()).includes("Personal notes"), false);
    }
    const ticket = await fetch(`${running.origin}/v1/realtime-ticket`, { method: "POST", headers: {
      authorization: `Bearer ${identity.token}`, "content-type": "application/json",
    }, body: JSON.stringify({ session_id: f.session.id }) });
    assert.equal(ticket.status, 404);
  }
  const own = await fetch(`${running.origin}/v1/sessions/${f.session.id}`, { headers: { authorization: `Bearer ${f.creator.token}` } });
  assert.equal(own.status, 200);
  const capabilities = await fetch(`${running.origin}/v1/projects/${f.project.id}`, { headers: { authorization: `Bearer ${f.creator.token}` } });
  const body = await capabilities.json() as { data: { session_visibility_options: string[] } };
  assert.deepEqual(body.data.session_visibility_options, ["project", "private"]);
});

test("creator controls per-member visibility in both modes without changing project roles or Solo write rights", t => {
  const db = new CollaborationDatabase(":memory:"); t.after(()=>db.close());
  const f = seed(db);
  for (const mode of ["solo","multi"] as const) {
    const author = mode === "solo" ? f.creator : f.owner;
    const target = mode === "solo" ? f.owner : f.participant;
    const s = f.service.createSession(author.actor,{project_id:f.project.id,mode,title:mode,idempotency_key:`scope-${mode}`}).session;
    const roleBefore = db.projectMembershipRole(f.project.id,target.actor.user_id);
    const save = (visible:boolean, revision:number, key:string) => f.service.setSessionMemberVisibility(author.actor,s.id,target.actor.user_id,
      {visible,expected_revision:revision,idempotency_key:key});
    assert.equal(f.service.listMembers(author.actor,s.id).find(m=>m.user_id===target.actor.user_id)!.session_visible,true);
    const hidden=save(false,0,`hide-${mode}`);
    assert.equal(hidden.revision,1);
    assert.equal(db.membershipRole(s.id,target.actor.user_id),null);
    assert.equal(f.service.listSessions(target.actor).some(item=>item.id===s.id),false);
    assert.throws(()=>f.service.getSession(target.actor,s.id),denied);
    assert.equal(f.service.listMembers(author.actor,s.id).find(m=>m.user_id===target.actor.user_id)!.session_visible,false);
    const shown=save(true,1,`show-${mode}`);
    assert.equal(shown.revision,2);
    assert.equal(db.projectMembershipRole(f.project.id,target.actor.user_id),roleBefore);
    assert.equal(f.service.getSession(target.actor,s.id).session.mode,mode);
    if (mode === "solo") assert.throws(()=>f.service.appendEvent(target.actor,s.id,{type:"human_chat",visibility:"session",payload:{content:"Read only"},idempotency_key:"solo-no-write"}));
    else assert.equal(f.service.appendEvent(target.actor,s.id,{type:"human_chat",visibility:"session",payload:{content:"Visible again"},idempotency_key:"multi-can-write"}).type,"human_chat");
  }
  const granted=f.service.setSessionMemberVisibility(f.creator.actor,f.session.id,f.viewer.actor.user_id,{visible:true,expected_revision:0,idempotency_key:"private-viewer"});
  assert.equal(granted.visible,true);
  assert.equal(f.service.listProjectSessions(f.creator.actor,f.project.id).find(s=>s.id===f.session.id)!.member_count,2);
  assert.throws(()=>f.service.appendEvent(f.viewer.actor,f.session.id,{type:"human_chat",visibility:"session",payload:{content:"No writer upgrade"},idempotency_key:"viewer-still-readonly"}));
});

test("visibility enforces creator identity, active membership/device, self protection, CAS and exact idempotent recovery", t=>{
  const db=new CollaborationDatabase(":memory:"); t.after(()=>db.close()); const f=seed(db);
  const s=f.service.createSession(f.creator.actor,{...f.input,visibility:"project",idempotency_key:"shared-acl"}).session;
  const allow={visible:true,expected_revision:0,idempotency_key:"allow-original"};
  assert.throws(()=>f.service.setSessionMemberVisibility(f.owner.actor,s.id,f.viewer.actor.user_id,allow),e=>e instanceof ApiError && e.status===403);
  assert.throws(()=>f.service.setSessionMemberVisibility(f.creator.actor,s.id,f.creator.actor.user_id,allow));
  const stranger=db.createIdentity({display_name:"Outside project",device_name:"Outside"});
  assert.throws(()=>f.service.setSessionMemberVisibility(f.creator.actor,s.id,stranger.actor.user_id,allow),denied);
  assert.equal(f.service.setSessionMemberVisibility(f.creator.actor,s.id,f.viewer.actor.user_id,allow).revision,0);
  const hide={visible:false,expected_revision:0,idempotency_key:"deny-newer"};
  f.service.setSessionMemberVisibility(f.creator.actor,s.id,f.viewer.actor.user_id,hide);
  const repeated=f.service.setSessionMemberVisibility(f.creator.actor,s.id,f.viewer.actor.user_id,allow);
  assert.equal(repeated.replayed,true); assert.equal(repeated.visible,false); assert.equal(repeated.revision,1);
  assert.throws(()=>f.service.setSessionMemberVisibility(f.creator.actor,s.id,f.viewer.actor.user_id,{...hide,visible:true}),e=>e instanceof ApiError && e.code==='idempotency_conflict');
  assert.throws(()=>f.service.setSessionMemberVisibility(f.creator.actor,s.id,f.participant.actor.user_id,{...allow,idempotency_key:"stale-revision"}),e=>e instanceof ApiError && e.code==='session_visibility_conflict');
  assert.throws(()=>f.service.setSessionMemberVisibility(f.creator.actor,s.id,f.participant.actor.user_id,{...allow,visible:"yes" as unknown as boolean}));
  db.setProjectMembership(f.owner.actor,f.project.id,f.creator.actor.user_id,'viewer');
  assert.throws(()=>f.service.setSessionMemberVisibility(f.creator.actor,s.id,f.participant.actor.user_id,{visible:false,expected_revision:1,idempotency_key:"viewer-cannot-manage"}));
  f.service.revokeDevice(f.creator.actor,f.creator.actor.device_id);
  assert.throws(()=>f.service.setSessionMemberVisibility(f.creator.actor,s.id,f.participant.actor.user_id,{visible:false,expected_revision:1,idempotency_key:"revoked-cannot-manage"}));
});

test("hide and regrant permanently fence old Agent claims and snapshot jobs while allowing new requests", t=>{
  const db=new CollaborationDatabase(":memory:"); t.after(()=>db.close()); const f=seed(db);
  const s=f.service.createSession(f.owner.actor,{project_id:f.project.id,mode:'multi',title:'Execution',idempotency_key:'execution-acl'}).session;
  const runtimeInput={session_id:s.id,device_id:f.participant.actor.device_id,harness:'codex',provider:'fixture',model:'fixture',local_session_id:'visibility-runtime',capture_fidelity:'harness_transcript' as const};
  const runtime=f.service.registerRuntime(f.participant.actor,runtimeInput);
  const input={type:'agent_request' as const,visibility:'session' as const,idempotency_key:'before-revocation',payload:{content:'Pending',execution_profile:{harness:'codex',provider:'fixture',model:'fixture',runtime_id:runtime.id}}};
  const request=f.service.appendEvent(f.participant.actor,s.id,input);
  f.service.claimAgentRequest(f.participant.actor,s.id,request.id,runtime.id);
  const snapshot=f.service.createSnapshotRequest(f.participant.actor,s.id);
  f.service.setSessionMemberVisibility(f.owner.actor,s.id,f.participant.actor.user_id,{visible:false,expected_revision:0,idempotency_key:'revoke-runtime'});
  assert.equal(db.getRuntime(runtime.id).status,'revoked');
  assert.equal(db.sqlite.prepare('SELECT status FROM snapshot_requests WHERE id=?').get(snapshot.id)?.status,'failed');
  assert.equal(db.sqlite.prepare('SELECT status FROM agent_request_claims WHERE request_event_id=?').get(request.id)?.status,'paused');
  f.service.setSessionMemberVisibility(f.owner.actor,s.id,f.participant.actor.user_id,{visible:true,expected_revision:1,idempotency_key:'restore-runtime'});
  assert.equal(db.isRequestContextCurrent(s.id,request.id),false);
  const renewed=f.service.registerRuntime(f.participant.actor,runtimeInput);
  assert.throws(()=>f.service.claimAgentRequest(f.participant.actor,s.id,request.id,renewed.id));
  const fresh=f.service.appendEvent(f.participant.actor,s.id,{...input,idempotency_key:'after-revocation',payload:{...input.payload,execution_profile:{...input.payload.execution_profile,runtime_id:renewed.id}}});
  assert.equal(db.isRequestContextCurrent(s.id,fresh.id),true);
  assert.equal(f.service.claimAgentRequest(f.participant.actor,s.id,fresh.id,renewed.id).status,'claimed');
});

test("real HTTP visibility mutation closes an existing WebSocket, invalidates tickets and can restore access", async t=>{
  const server=await startCollaborationServer({databasePath:':memory:'},0); t.after(()=>server.close()); const f=seed(server.database);
  const s=server.service.createSession(f.owner.actor,{project_id:f.project.id,mode:'multi',title:'Realtime ACL',idempotency_key:'realtime-acl'}).session;
  async function ticket() {
    const response=await fetch(`${server.origin}/v1/realtime-ticket`,{method:'POST',headers:{authorization:`Bearer ${f.participant.token}`,'content-type':'application/json'},body:JSON.stringify({session_id:s.id})});
    return await response.json() as {data:{ticket:string}};
  }
  const issued=await ticket(); const spare=await ticket();
  const socket=new WebSocket(server.origin.replace('http:','ws:')+'/v1/ws',['gatherthread-v1',`gatherthread-ticket.${issued.data.ticket}`]);
  t.after(()=>socket.terminate());
  await new Promise<void>((resolve,reject)=>{socket.once('open',()=>resolve());socket.once('error',reject);});
  const subscribed=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Subscription deadline')),3000);socket.on('message',raw=>{if(JSON.parse(raw.toString()).type==='subscribed'){clearTimeout(timer);resolve();}});});
  socket.send(JSON.stringify({type:'subscribe',session_id:s.id,after_sequence:0})); await subscribed;
  const closed=new Promise<number>(resolve=>socket.once('close',code=>resolve(code)));
  const route=`${server.origin}/v1/sessions/${s.id}/members/${f.participant.actor.user_id}/visibility`;
  const mutate=(visible:boolean,revision:number,key:string,token=f.owner.token)=>fetch(route,{method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({visible,expected_revision:revision,idempotency_key:key})});
  assert.equal((await mutate(false,0,'http-hide-other',f.viewer.token)).status,403);
  assert.equal((await mutate(false,0,'http-hide-other')).status,200);
  assert.equal(await closed,1008);
  assert.equal((await fetch(`${server.origin}/v1/sessions/${s.id}`,{headers:{authorization:`Bearer ${f.participant.token}`}})).status,404);
  const stale=new WebSocket(server.origin.replace('http:','ws:')+'/v1/ws',['gatherthread-v1',`gatherthread-ticket.${spare.data.ticket}`]);
  const rejected=await new Promise<number>((resolve,reject)=>{stale.once('unexpected-response',(_req,res)=>{res.resume();resolve(res.statusCode!);});stale.once('open',()=>reject(new Error('Revoked ticket accepted')));stale.on('error',()=>{});});
  assert.equal(rejected,401);
  assert.equal((await mutate(true,1,'http-show-other')).status,200);
  assert.equal((await fetch(`${server.origin}/v1/sessions/${s.id}`,{headers:{authorization:`Bearer ${f.participant.token}`}})).status,200);
});

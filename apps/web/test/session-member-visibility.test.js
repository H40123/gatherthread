import test from "node:test";
import assert from "node:assert/strict";
import { HttpCollaborationApi, MockCollaborationApi } from "../src/api.js";
import { createSessionVisibilityController } from "../src/session-visibility.js";

test("visibility PUT is session-scoped, cookie-authenticated, bounded and strict", async()=>{
  const original=globalThis.fetch; let call;
  globalThis.fetch=async(url,options)=>{call={url,options};return Response.json({data:{user_id:"member",visible:false,revision:3,replayed:false}});};
  try {
    await new HttpCollaborationApi().setSessionMemberVisibility("s / 1","member",{visible:false,expectedRevision:2,idempotencyKey:"visibility-test"});
    assert.equal(call.url,"/v1/sessions/s%20%2F%201/members/member/visibility");
    assert.equal(call.options.method,"PUT"); assert.equal(call.options.credentials,"include");
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(call.options.body),{visible:false,expected_revision:2,idempotency_key:"visibility-test"});
  } finally {globalThis.fetch=original;}
});

test("uncertain saves block another change and retry the exact body/key until acceptance is confirmed", async()=>{
  const calls=[]; let succeed=false, saved;
  const context={userId:"author",projectId:"p",sessionId:"s",canManage:true};
  const controller=createSessionVisibilityController({getContext:()=>context, onChange(){},onSaved:r=>saved=r,onMembers(){},api:{
    async setSessionMemberVisibility(s,u,input){calls.push({s,u,input:{...input}}); if(!succeed)throw new TypeError("lost acknowledgement");return {user_id:u,visible:false,revision:1,replayed:true};},
    async listMembers(){return [];},
  }});
  const member={userId:"member",sessionVisible:true,visibilityRevision:0};
  await controller.change(member,false);
  assert.ok(controller.pending()); assert.equal(controller.pending().busy,false);
  await controller.change({...member,userId:"other"},false); assert.equal(calls.length,1);
  succeed=true; await controller.retry();
  assert.deepEqual(calls[0],calls[1]); assert.equal(saved.replayed,true); assert.equal(controller.pending(),undefined);
});

test("late results from another account/project/session never modify the active member panel", async()=>{
  let context={userId:"author",projectId:"p",sessionId:"s",canManage:true}; let resolve;
  let effects=0;
  const controller=createSessionVisibilityController({getContext:()=>context,onChange(){},onSaved(){effects++;},onMembers(){effects++;},api:{
    setSessionMemberVisibility(){return new Promise(done=>{resolve=done;});},async listMembers(){return [];},
  }});
  const work=controller.change({userId:"member",sessionVisible:true,visibilityRevision:0},false);
  context={...context,sessionId:"different"};
  resolve({user_id:"member",visible:false,revision:1,replayed:false}); await work;
  assert.equal(effects,0); assert.equal(controller.pending(),undefined);
});

test("definitive conflicts refresh current members and never automatically reapply the stale choice", async()=>{
  let refreshed, calls=0;
  const controller=createSessionVisibilityController({getContext:()=>({userId:"author",projectId:"p",sessionId:"s",canManage:true}),onChange(){},onSaved(){assert.fail("unaccepted result");},onMembers:m=>refreshed=m,api:{
    async setSessionMemberVisibility(){calls++; throw Object.assign(new Error("stale"),{status:409});},
    async listMembers(){return [{userId:"member",sessionVisible:false,visibilityRevision:4}];},
  }});
  await controller.change({userId:"member",sessionVisible:true,visibilityRevision:0},false);
  assert.equal(calls,1); assert.equal(controller.pending(),undefined); assert.equal(refreshed[0].visibilityRevision,4);
  await controller.retry(); assert.equal(calls,1);
});

test("missing server metadata, non-creators and self changes never issue visibility writes", async()=>{
  let canManage=false,calls=0;
  const controller=createSessionVisibilityController({getContext:()=>({userId:"author",projectId:"p",sessionId:"s",canManage}),onChange(){},onSaved(){},onMembers(){},api:{async setSessionMemberVisibility(){calls++;}}});
  await controller.change({userId:"other",sessionVisible:true,visibilityRevision:0},false);
  canManage=true;
  await controller.change({userId:"author",sessionVisible:true,visibilityRevision:0},false);
  await controller.change({userId:"other"},false);
  assert.equal(calls,0);
});

test("mock member management mirrors hide/show, revision conflicts and changed retry rejection", async()=>{
  const api=new MockCollaborationApi({latency:0});
  const members=await api.listMembers('session-orbit');
  const target=members.find(m=>m.userId!==api.currentUser.id);
  const input={visible:false,expectedRevision:0,idempotencyKey:'mock-hide-member'};
  assert.equal((await api.setSessionMemberVisibility('session-orbit',target.userId,input)).revision,1);
  assert.equal((await api.listMembers('session-orbit')).find(m=>m.userId===target.userId).sessionVisible,false);
  assert.equal((await api.setSessionMemberVisibility('session-orbit',target.userId,input)).replayed,true);
  await assert.rejects(()=>api.setSessionMemberVisibility('session-orbit',target.userId,{...input,visible:true}),e=>e.code==='idempotency_conflict');
  await assert.rejects(()=>api.setSessionMemberVisibility('session-orbit',target.userId,{visible:true,expectedRevision:0,idempotencyKey:'mock-stale-grant'}),e=>e.code==='session_visibility_conflict');
});

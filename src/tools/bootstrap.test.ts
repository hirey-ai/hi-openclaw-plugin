import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {ensureCredential, invalidateAuthorizedClients, buildAuthorizedClients} from '../clients.js';
import {bootstrapPendingAgent} from '../bootstrap.js';
import {buildHiAgentInstallTool, buildHiAgentDoctorTool, buildHiAgentResetTool, isVerifiedModernIdentity} from './control.js';

test('modern identity requires nonempty matching Agent and verified identity fields', () => {
  const me={agent_id:'agt-test',person_id:'per-test',workspace_id:'ws-test',agent_session_id:'session-test'};
  assert.equal(isVerifiedModernIdentity(me,'agt-test'),true);
  assert.equal(isVerifiedModernIdentity(me,'other-agent'),false);
  for (const key of Object.keys(me)) assert.equal(isVerifiedModernIdentity({...me,[key]:' '},'agt-test'),false);
});

test('modern bootstrap persists one pending credential and concurrent/repeated callers reuse it', async () => {
  const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'hi-bootstrap-test-'));
  const original=globalThis.fetch;
  let posts=0;
  globalThis.fetch=async (url, init) => {
    if(String(url).includes('/.well-known/')) return Response.json({services:{oauth_token_url:'https://auth.test/oauth/token'}});
    assert.equal(String(url),'https://platform.test/v1/agents/api-keys');
    assert.equal(JSON.parse(String(init?.body)).agent_type,'openclaw');
    const marker=await fs.stat(path.join(stateDir,'test.registration-pending.json'));
    assert.equal(marker.mode & 0o777,0o600);
    posts++;
    return Response.json({agent_id:'agt-test',status:'pending',api_key:'hi_ak_'+Buffer.from(JSON.stringify({v:1,id:'client-test',secret:'fake-test-only'})).toString('base64url')});
  };
  try {
    const args={stateDir,profile:'test',platformBaseUrl:'https://platform.test'};
    const [a,b]=await Promise.all([ensureCredential(args),ensureCredential(args)]);
    assert.equal(a.identity?.agent_id,b.identity?.agent_id);
    assert.equal(a.identity?.anonymous,true);
    assert.equal(a.identity?.token_url,'https://auth.test/oauth/token');
    await ensureCredential(args);
    assert.equal(posts,1);
  } finally {globalThis.fetch=original;await fs.rm(stateDir,{recursive:true,force:true});}
});

for(const outcome of ['timeout','malformed','server-error']) {
  test(`bootstrap ${outcome} retains durable attempt and refuses another POST`, async()=>{
    const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'hi-bootstrap-test-'));
    const original=globalThis.fetch;let posts=0;
    globalThis.fetch=async(url)=>{
      if(String(url).includes('/.well-known/'))return Response.json({services:{oauth_token_url:'https://auth.test/oauth/token'}});
      posts++;
      if(outcome==='timeout')throw new Error('timeout');
      return outcome==='server-error'?Response.json({error:'failed'},{status:503}):Response.json({api_key:'invalid'});
    };
    try {
      const args={stateDir,profile:'test',platformBaseUrl:'https://platform.test'};
      await assert.rejects(bootstrapPendingAgent(args));
      await assert.rejects(bootstrapPendingAgent(args),/hi_registration_outcome_unknown/);
      assert.equal(posts,1);
      assert.doesNotMatch(await fs.readFile(path.join(stateDir,'test.registration-pending.json'),'utf8'),/secret|api_key/);
    } finally {globalThis.fetch=original;await fs.rm(stateDir,{recursive:true,force:true});}
  });
}

test('same credential transitions pending to flat active identity without legacy installation calls', async()=>{
  const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'hi-bootstrap-test-'));
  const original=globalThis.fetch;let posts=0, active=false, exchanges=0;
  globalThis.fetch=async(url,init)=>{
    const route=String(url);
    if(route.endsWith('/.well-known/hi-agent-platform.json'))return Response.json({platform:{platform_base_url:'https://platform.test'},services:{oauth_token_url:'https://auth.test/oauth/token'}});
    if(route.endsWith('/v1/agents/api-keys')){posts++;return Response.json({agent_id:'agt-test',status:'pending',api_key:'hi_ak_'+Buffer.from(JSON.stringify({v:1,id:'client-test',secret:'fake-test-only'})).toString('base64url')});}
    if(route.endsWith('/oauth/token')){assert.ok(init?.signal);exchanges++;return Response.json({access_token:active?'test-bound-token':'hi_ai_test-pending',token_type:'Bearer',expires_in:3600});}
    if(route.endsWith('/v1/agents/me')){assert.equal(active,true);assert.equal(new Headers(init?.headers).get('x-hirey-plugin-host'),'openclaw');assert.equal(new Headers(init?.headers).get('x-hirey-plugin-version'),'1.0.75');return Response.json({agent_id:'agt-test',person_id:'per-test',workspace_id:'ws-test',agent_session_id:'session-test'});}
    throw new Error(`unexpected endpoint ${route}`);
  };
  try {
    const config={modernEvents:{},stateDir,profile:'test',platformBaseUrl:'https://platform.test',webhookPath:'/hi',claimPollIntervalMs:30000,claimLeaseMs:30000};
    const install=buildHiAgentInstallTool(config);
    const pending=(await install.execute('test',{})).structuredContent as any;
    assert.equal(pending.ok,true);assert.equal(pending.activated,false);assert.equal(pending.hooks_ready,false);
    active=true;
    invalidateAuthorizedClients(stateDir,'test');
    const bound=(await install.execute('test2',{})).structuredContent as any;
    assert.equal(bound.ok,true);assert.equal(bound.activated,true);assert.equal(bound.push_ready,false);
    const doctor=(await buildHiAgentDoctorTool(config).execute('doctor',{probe_delivery:false})).structuredContent as any;
    assert.equal(doctor.ok,true);assert.equal(doctor.activated,true);assert.equal(doctor.push_ready,false);
    await Promise.all([buildAuthorizedClients(config),buildAuthorizedClients(config)]);
    assert.equal(posts,1);assert.equal(exchanges,2);
    await buildHiAgentResetTool(config).execute('explicit-reset',{clear_state:true});
    await assert.rejects(fs.stat(path.join(stateDir,'test.registration-pending.json')), {code:'ENOENT'});
    await fs.writeFile(path.join(stateDir,'test.registration-pending.json'),'{}');
    await buildHiAgentResetTool(config).execute('unknown-reset',{clear_state:true});
    assert.ok(await fs.stat(path.join(stateDir,'test.registration-pending.json')));
  } finally {globalThis.fetch=original;await fs.rm(stateDir,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {editorToWorkflow} from '../public/graph.mjs';
const root=new URL('../',import.meta.url);

test('HTTP session: frozen outputs, one active run, controls, pause/resume, persisted reuse and compact polling',{timeout:15000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'vr-session-'));let child;
 try{
  for(const name of ['server.mjs','engine.mjs','artifacts.mjs','graph-engine.mjs','public'])cpSync(new URL(name,root),path.join(dir,name),{recursive:true});
  writeFileSync(path.join(dir,'fixture.mjs'),`import {appendFileSync} from 'node:fs';
  globalThis.fetch=async(url,init)=>{const p=JSON.parse(init.body||'{}'),u=String(url);appendFileSync(${JSON.stringify(path.join(dir,'calls'))},JSON.stringify({url:u,params:p})+'\\n');
  if(u.endsWith('/pricing/estimate'))return Response.json({estimated_cost_usd:.01,assumptions:{}});
  if(u.endsWith('/images')){await new Promise(r=>setTimeout(r,350));return Response.json({data:[{url:'https://fixture.invalid/image.png'}],usage:{cost:.01}})}
  if(u.endsWith('/videos'))return Response.json({id:'test-video',status:'completed',data:[{url:'https://fixture.invalid/video.mp4'}],cost_usd:.1});throw Error('Unexpected transport')};`);
  child=spawn(process.execPath,['--import',path.join(dir,'fixture.mjs'),path.join(dir,'server.mjs')],{env:{...process.env,PORT:'18794',VIDEOROUTER_API_KEY:'fixture',VIDEOROUTER_MANAGEMENT_KEY:''},stdio:['ignore','pipe','pipe']});
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Fixture server exited')})]);
  async function local(p,body,ok=true){const response=await fetch('http://127.0.0.1:18794/local/'+p,{method:body===undefined?'GET':'POST',headers:{'X-Studio':'1','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();assert.equal(response.ok,ok,JSON.stringify(data));return data}
  const w=editorToWorkflow({id:'session-flow',name:'Session',steps:[{id:'image',op:'POST /v1/images',params:{model:'gpt-image-1',prompt:'Teapot'},action:'text-to-image'},{id:'video',op:'POST /v1/videos',action:'reference-to-video',params:{model:'fal/seedance-2.0',prompt:'Animate',duration_secs:5},media:{input_references:{mode:'list',items:[{mode:'previous',stepId:'image',port:'images',index:0}]}}}],groups:[{id:'first',nodeIds:['image']},{id:'second',nodeIds:['video']}]});
  await local('workflow',w);const prepared=await local('prepare',{workflow:w}),first=await local('run',prepared);
  await local('prepare',{workflow:w},false);
  let state=await local('run/'+first.id+'/control',{revision:0,stepId:'second',enabled:false});assert.equal(state.revision,1);
  await local('run/'+first.id+'/control',{revision:0,pauseAfterCurrent:true},false);
  await local('run/'+first.id+'/control',{revision:1,pauseAfterCurrent:true});
  for(let i=0;i<50;i++){state=await local('run/'+first.id);if(state.status!=='running')break;await new Promise(r=>setTimeout(r,20))}
  assert.equal(state.status,'paused');assert.equal(state.steps[0].status,'completed');
  const compact=await local('run/'+first.id+'?view=workflow');assert.equal(compact.steps[0].request,undefined);assert.equal(compact.steps[0].result,undefined);assert.equal(compact.workflowId,w.id);
  const resume=await local('prepare',{workflow:state.config.workflow,runId:first.id,revision:state.revision});await local('run/'+first.id+'/resume',resume);
  state=await local('run/'+first.id);assert.equal(state.status,'completed');assert.equal(state.steps[1].status,'skipped');
  w.steps[0].enabled=false;w.steps[1].enabled=true;await local('workflow',w);
  const candidates=await local('workflow/'+w.id+'/outputs');assert.equal(candidates.nodes.image[0].runId,first.id);
  const reuse=await local('prepare',{workflow:w});assert.deepEqual(reuse.preview.map(n=>n.status),['reused','waiting']);
  const second=await local('run',reuse);
  for(let i=0;i<50;i++){state=await local('run/'+second.id);if(state.status!=='running')break;await new Promise(r=>setTimeout(r,20))}
  assert.equal(state.status,'completed',state.error);assert.equal(state.steps[0].reusedFrom.runId,first.id);assert.equal(state.steps[0].cost,0);assert.equal(state.steps[1].request.params.input_references.length,1);
  const calls=readFileSync(path.join(dir,'calls'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.filter(c=>c.url.endsWith('/images')).length,1);assert.equal(calls.filter(c=>c.url.endsWith('/videos')).length,1);
 }finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit')}rmSync(dir,{recursive:true,force:true})}
});

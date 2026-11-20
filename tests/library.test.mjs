import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,cpSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createLibrary} from '../library.mjs';
import {createWebhookBridge} from '../webhooks.mjs';
import {portableWorkflow,parseWorkflowJSON} from '../public/workflow-json.mjs';
import {editorToWorkflow,workflowToEditor,compileGraph} from '../public/graph.mjs';
import {validateGraphRequests} from '../graph-engine.mjs';

const root=new URL('../',import.meta.url),routes=new Map(JSON.parse(readFileSync(new URL('public/catalog.json',root))).routes.map(r=>[r.id,r]));
function workflow(){return editorToWorkflow({id:'original-flow',name:'Portable',activeRunId:'private-run',steps:[
 {id:'image',op:'POST /v1/images',action:'text-to-image',params:{model:'gpt-image-1',prompt:'Teapot',n:1},reuse:{mode:'pinned',runId:'private-run'}},
 {id:'video',op:'POST /v1/videos',action:'reference-to-video',params:{model:'fal/seedance-2.0',prompt:'Animate',duration_secs:5,provider:{only:['fal'],allow_fallbacks:false}},media:{input_references:{mode:'list',items:[{mode:'previous',stepId:'image',port:'images',index:0},{mode:'file',file:'local-secret-id',name:'my-reference.png'},{mode:'url',url:'https://fixture.invalid/reference.png'}]}}}
],groups:[{id:'first',nodeIds:['image'],continueOnSuccess:false,view:'flow'},{id:'second',nodeIds:['video'],enabled:false}]})}
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE records(kind TEXT,id TEXT,body TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE assets(id TEXT PRIMARY KEY)');
 const all=kind=>db.prepare('SELECT body FROM records WHERE kind=?').all(kind).map(r=>JSON.parse(r.body));
 const get=(kind,id)=>{const row=db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind,id);return row?JSON.parse(row.body):null};
 const save=(kind,item)=>db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)').run(kind,item.id,JSON.stringify(item));
 const bridge=createWebhookBridge({db,settings:()=>({ready:true,url:'https://fixture.invalid/webhooks/videorouter'})}),busy=new Set();
 return {db,all,get,save,bridge,busy,library:createLibrary({db,all,get,save,routes,isBusy:id=>busy.has(id)}),close(){bridge.close();db.close()}};
}
const run=(id,status='completed',extra={})=>({id,name:id,status,steps:[],config:{workflow:{id:'original-flow'}},...extra});

test('portable JSON keeps graph/settings/URLs, omits runtime/editor/assets and resets history pins',()=>{
 const w=workflow();w.keys={api:'not-an-exported-credential'};w.steps[0].nodes[0].editor.extra='private-editor';
 const exported=portableWorkflow(w,{routes}),text=JSON.stringify(exported.workflow);
 assert.equal(exported.workflow.id,undefined);assert.ok(!text.includes('private-run'));assert.ok(!text.includes('local-secret-id'));assert.ok(!text.includes('private-editor'));assert.ok(!text.includes('not-an-exported-credential'));
 assert.equal(exported.workflow.steps[0].continueOnSuccess,false);assert.equal(exported.workflow.steps[0].view,'flow');assert.equal(exported.workflow.steps[1].enabled,false);
 assert.deepEqual(exported.workflow.steps[1].edges,w.steps[1].edges);assert.deepEqual(exported.workflow.steps[1].nodes[0].parameters.provider,{only:['fal'],allow_fallbacks:false});
 assert.equal(exported.workflow.steps[1].nodes[0].inputs.input_references[1].missing,true);assert.equal(exported.workflow.steps[1].nodes[0].inputs.input_references[2].url,'https://fixture.invalid/reference.png');
 const editor=workflowToEditor(exported.workflow);assert.equal(editor.steps[1].media.input_references.items[1].mode,'file');assert.equal(editor.steps[1].media.input_references.items[1].file,undefined);
 assert.equal(editorToWorkflow(editor).steps[1].nodes[0].inputs.input_references[1].missing,true);
 assert.equal(exported.warnings.length,2);
 const imported=parseWorkflowJSON(text,{routes});assert.deepEqual(imported.workflow,exported.workflow);assert.equal(compileGraph(imported.workflow).stages.length,2);
});

test('local file parameters become explicit missing markers; preflight stops before any API',()=>{
 const w=editorToWorkflow({name:'Upload',steps:[{id:'upload',op:'POST /v1/uploads',params:{file:'local-asset-id',purpose:'reference'}}]});
 const exported=portableWorkflow(w,{routes}).workflow;
 assert.equal(exported.steps[0].nodes[0].parameters.purpose,'reference');assert.ok(exported.steps[0].nodes[0].parameters.file.$missingAsset);
 assert.throws(()=>validateGraphRequests(exported,routes),/локальный файл/);
 const image=workflow();image.steps[1].enabled=true;
 assert.throws(()=>validateGraphRequests(portableWorkflow(image,{routes}).workflow,routes),/выберите источник/);
});

test('import rejects invalid JSON/version/IDs/operations/cycles/prototype fields without writes; legacy accepted',()=>{
 const f=fixture();try{
  for(const text of ['{','[]','{"version":9,"steps":[]}','{"version":2,"name":"x","steps":[],"__proto__":{}}'])assert.throws(()=>f.library.importJSON(text));
  for(const mutate of [w=>w.steps[0].nodes[0].id='"><script>',w=>w.steps[0].nodes[0].op='POST /unknown',w=>w.steps[1].nodes[0].parameters.link={$node:{nodeId:'video',path:'data'}}]){
   const w=workflow();mutate(w);assert.throws(()=>f.library.importJSON(JSON.stringify(w)));
  }
  assert.equal(f.all('flow').length,0);
  const old={name:'Old workflow',steps:[{id:'image',op:'POST /v1/images',params:{model:'gpt-image-1',prompt:'Frame'}}]};
  const imported=f.library.importJSON(JSON.stringify(old));assert.equal(imported.workflow.version,2);assert.equal(f.all('flow').length,1);
 }finally{f.close()}
});

test('import always creates a new workflow; exporting and importing never modifies original/history',()=>{
 const f=fixture();try{
  const original=workflow();f.save('flow',original);f.save('run',run('existing'));const savedOriginal=f.get('flow',original.id);
  const first=f.library.importJSON(JSON.stringify(original)),second=f.library.importJSON(JSON.stringify(original));
  assert.notEqual(first.workflow.id,original.id);assert.notEqual(first.workflow.id,second.workflow.id);
  assert.deepEqual(f.get('flow',original.id),savedOriginal);assert.equal(f.all('flow').length,3);assert.equal(f.all('run').length,1);
 }finally{f.close()}
});

test('delete run removes inbox and history, preserves assets/snapshots, warns on pins; late delivery cannot restore it',()=>{
 const f=fixture();try{
  const w=workflow();w.steps[0].nodes[0].reuse={mode:'pinned',runId:'remove'};f.save('flow',w);
  const r=run('remove');r.steps=[{id:'video'}];const params=f.bridge.prepare(r,r.steps[0],routes.get('POST /v1/videos'),{});r.steps[0].remoteId='job';f.bridge.bind(r.steps[0]);f.save('run',r);
  const event=JSON.stringify({id:'job',status:'completed',data:[{url:'https://fixture.invalid/video.mp4'}],cost_usd:.1});
  assert.equal(f.bridge.accept(r.steps[0].webhookAttempt,'video.completed','job',event),204);
  const keep=run('keep','completed',{steps:[{reusedFrom:{runId:r.id},artifacts:[{file:'shared'}]}]});f.save('run',keep);f.db.prepare('INSERT INTO assets VALUES(?)').run('shared');
  const plan=f.library.deletion({kind:'run',id:r.id});assert.equal(plan.pinnedWorkflows,1);f.library.deleteItems(plan);
  assert.equal(f.get('run',r.id),null);assert.deepEqual(f.get('run','keep'),keep);assert.equal(f.db.prepare('SELECT count(*) AS n FROM assets').get().n,1);
  assert.equal(f.bridge.stats().received,0);assert.equal(f.bridge.accept(params.webhook_url.split('/').pop(),'video.completed','job',event),404);assert.equal(f.get('run',r.id),null);
 }finally{f.close()}
});

test('clear reviews exact eligible IDs, preserves pauses/running/recovering, and rechecks before deletion',()=>{
 const f=fixture();try{
  for(const [id,status] of [['done','completed'],['error','failed'],['pause','paused'],['active','running'],['recover','interrupted']])f.save('run',run(id,status));
  f.busy.add('recover');const plan=f.library.deletion({kind:'run',clearCompleted:true});assert.deepEqual(plan.ids.sort(),['done','error']);
  assert.throws(()=>f.library.deletion({kind:'run',id:'active'}));assert.throws(()=>f.library.deletion({kind:'run',id:'recover'}));
  f.save('run',run('done','running'));assert.throws(()=>f.library.deleteItems(plan));assert.ok(f.get('run','error'));
  f.save('run',run('done'));f.save('run',run('finished-later'));f.library.deleteItems(plan);
  assert.deepEqual(f.all('run').map(r=>r.id).sort(),['active','finished-later','pause','recover']);
  const pause=f.library.deletion({kind:'run',id:'pause'});assert.equal(pause.paused,1);f.library.deleteItems(pause);assert.equal(f.get('run','pause'),null);
 }finally{f.close()}
});

test('workflow deletion preserves run snapshots and cannot delete an actively executing workflow or parent pause',()=>{
 const f=fixture();try{
  f.save('flow',workflow());f.save('run',run('parent','paused'));f.save('run',run('child','running',{parentRunId:'parent'}));
  assert.throws(()=>f.library.deletion({kind:'flow',id:'original-flow'}));assert.throws(()=>f.library.deletion({kind:'run',id:'parent'}));
  f.save('run',run('child','completed',{parentRunId:'parent'}));f.library.deleteItems(f.library.deletion({kind:'flow',id:'original-flow'}));
  assert.equal(f.get('flow','original-flow'),null);assert.equal(f.all('run').length,2);assert.equal(f.get('run','parent').config.workflow.id,'original-flow');
 }finally{f.close()}
});

test('HTTP import/export/delete confirmation uses local guard, survives restart, never calls external API',{timeout:10000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'vr-library-'));let child;const base='http://127.0.0.1:18806';
 async function start(){
  child=spawn(process.execPath,['--import',path.join(dir,'offline.mjs'),path.join(dir,'server.mjs')],{env:{...process.env,PORT:'18806',VIDEOROUTER_API_KEY:'',VIDEOROUTER_MANAGEMENT_KEY:'',VIDEOROUTER_WEBHOOK_ENABLED:'0',VIDEOROUTER_WEBHOOK_SECRET:''},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',d=>errors+=d);
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Server exited: '+errors)})]);
 }
 async function stop(){const stopped=once(child,'exit');child.kill();await stopped;child=null}
 async function local(p,body,expected=200){const r=await fetch(base+'/local/'+p,{method:body===undefined?'GET':'POST',headers:{'X-Studio':'1','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,expected,JSON.stringify(data));return data}
 try{
  for(const file of ['server.mjs','engine.mjs','graph-engine.mjs','webhooks.mjs','library.mjs','grok-cli.mjs','artifacts.mjs','public'])cpSync(new URL(file,root),path.join(dir,file),{recursive:true});
  writeFileSync(path.join(dir,'offline.mjs'),"globalThis.fetch=async()=>{throw Error('External API forbidden')};");await start();
  const exported=await local('workflow/export',{workflow:workflow()});assert.equal(exported.workflow.id,undefined);
  const imported=await local('workflow/import',{text:JSON.stringify(exported.workflow)});assert.ok(imported.workflow.id);
  assert.equal((await local('state')).runs.length,0);assert.equal((await local('state')).flows.length,1);
  const unauthorized=await fetch(base+'/local/library/delete-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'flow',id:imported.workflow.id})});assert.equal(unauthorized.status,403);
  await local('library/delete',{ticket:'unknown'},400);
  const preview=await local('library/delete-preview',{kind:'flow',id:imported.workflow.id});assert.equal((await local('state')).flows.length,1);
  await local('library/delete',preview);await local('library/delete',preview,400);
  await stop();await start();assert.equal((await local('state')).flows.length,0);assert.equal((await local('state')).runs.length,0);
 }finally{if(child)await stop();rmSync(dir,{recursive:true,force:true})}
});

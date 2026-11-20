import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync,cpSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {validateWorkflowContract} from '../contracts/workflow/validate.mjs';
import {operationRegistry} from '../contracts/workflow/registry.mjs';
import {createLibrary} from '../library.mjs';
import {parseWorkflowJSON,portableWorkflow} from '../public/workflow-json.mjs';
import {editorToWorkflow,workflowToEditor} from '../public/graph.mjs';
import {graphRun,createGraphRunner,reviseRun} from '../graph-engine.mjs';

const root=new URL('../',import.meta.url),fixtures=new URL('fixtures/workflow-contract/',import.meta.url);
const files=readdirSync(new URL('requests/',fixtures)).filter(f=>f.endsWith('.json')).sort();
const read=(part,file)=>readFileSync(new URL(part+'/'+file,fixtures),'utf8');
const routes=new Map(JSON.parse(readFileSync(new URL('public/catalog.json',root))).routes.map(r=>[r.id,r]));
const roles={image:['image','text-to-image','POST /v1/images'],edit:['image','image-edit','POST /v1/images'],video:['video','reference-to-video','POST /v1/videos']};

function assertDecisions(w,brief){
 assert.equal(w.name,brief.name);
 const steps=brief.decisions.steps,origins=new Map(steps.flatMap(s=>s.cards.map(c=>[c.key,s.key])));
 assert.deepEqual(w.steps.map(s=>s.id),steps.map(s=>s.key));
 for(const [index,expected] of steps.entries()){
  const actual=w.steps[index];assert.equal(actual.name,expected.name);
  assert.equal(actual.enabled,expected.enabled??true);assert.equal(actual.continueOnSuccess,expected.continueOnSuccess??true);assert.equal(actual.view,expected.view??'cards');
  assert.deepEqual(actual.nodes.map(n=>n.id),expected.cards.map(c=>c.key));
  assert.equal(actual.edges.length,expected.cards.reduce((n,c)=>n+(c.orderedImageReferences||[]).filter(r=>r.card).length,0));
  for(const c of expected.cards){
   const n=actual.nodes.find(n=>n.id===c.key),[kind,operationId,op]=roles[c.modelRole];
   assert.deepEqual([n.kind,n.operationId,n.op,n.model],[kind,operationId,op,brief.modelIds[c.modelRole]]);
   assert.deepEqual(n.parameters,{...c.parameters,prompt:c.prompt});
   assert.ok(Object.keys(n.inputs).every(key=>key==='input_references'));
   const bindings=[...(n.inputs.input_references||[])];
   for(const e of actual.edges.filter(e=>e.to.nodeId===n.id)){
    assert.equal(e.to.port,'input_references');assert.equal(e.from.port,'images');assert.equal(e.from.stepId,origins.get(e.from.nodeId));
    assert.ok(bindings[e.to.slot]==null);bindings[e.to.slot]={card:e.from.nodeId,outputIndex:e.from.outputIndex};
   }
   const wanted=(c.orderedImageReferences||[]).map(r=>{
    if(r.card)return r;const a=brief.availableAssets.find(a=>a.key===r.asset);assert.ok(a);
    return a.local?{missing:true,name:a.name}:{url:a.url};
   });
   assert.deepEqual(bindings,wanted,'reference order/index for '+c.key);
  }
 }
}

function memoryLibrary(){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE records(kind TEXT,id TEXT,body TEXT NOT NULL,PRIMARY KEY(kind,id))');
 const save=(kind,v)=>db.prepare('INSERT INTO records VALUES(?,?,?)').run(kind,v.id,JSON.stringify(v));
 const all=kind=>db.prepare('SELECT body FROM records WHERE kind=?').all(kind).map(r=>JSON.parse(r.body));
 const get=(kind,id)=>{const r=db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind,id);return r&&JSON.parse(r.body)};
 return {db,all,library:createLibrary({db,save,all,get,routes})};
}

async function simulate(w,brief){
 const cards=brief.decisions.steps.flatMap(s=>s.cards),calls=[];
 const produced=(key,index)=>'https://fixtures.invalid/'+key+'-'+index+'.png';
 const call=async(route,params)=>{
  if(route.path==='/v1/pricing/estimate')return {data:{estimated_cost_usd:0.01,assumptions:{}},cost:null};
  assert.ok(['/v1/images','/v1/videos'].includes(route.path),'unexpected transport operation');
  const c=cards.find(c=>c.prompt===params.prompt);assert.ok(c,'unexpected prompt');calls.push({key:c.key,params:structuredClone(params)});
  if(route.path==='/v1/images')return {data:{data:Array.from({length:params.n??1},(_,i)=>({url:produced(c.key,i)}))},cost:0.01};
  return {data:{id:c.key,status:'completed',data:[{url:'https://fixtures.invalid/'+c.key+'.mp4'}]},cost:0.1};
 };
 const unexpected=()=>{throw Error('No real files or uploads in contract checks')};
 const runner=createGraphRunner({routes,call,save:()=>{},storeFile:unexpected,readAsset:unexpected,pollDelay:0}),run=graphRun(brief.name,w);
 await runner.start(run);let pauses=0;
 while(run.status==='paused'){
  assert.ok(pauses++<w.steps.length,'unbounded pause loop');reviseRun(run,run.config.workflow);await runner.start(run);
 }
 assert.equal(run.status,'completed',run.error);
 assert.equal(pauses,brief.decisions.steps.slice(0,-1).filter(s=>s.enabled!==false&&s.continueOnSuccess===false).length);
 const activeCards=brief.decisions.steps.filter(s=>s.enabled!==false).flatMap(s=>s.cards);
 assert.deepEqual(calls.map(c=>c.key),activeCards.map(c=>c.key));
 const active=new Set(activeCards.map(c=>c.key));
 for(const c of activeCards){
  const params=calls.find(v=>v.key===c.key).params;
  assert.equal(params.model,brief.modelIds[c.modelRole]);assert.equal(params.prompt,c.prompt);
  for(const [key,value] of Object.entries(c.parameters))assert.deepEqual(params[key],value);
  const expected=(c.orderedImageReferences||[]).flatMap(r=>r.card?(active.has(r.card)?[produced(r.card,r.outputIndex)]:[]):[brief.availableAssets.find(a=>a.key===r.asset).url]);
  assert.deepEqual((params.input_references||[]).map(r=>r.image_url.url),expected,'materialized references for '+c.key);
 }
 return calls;
}

for(const file of files)test('independent agent '+file+': contract, real import, editor round-trip and offline dataflow',async()=>{
 const brief=JSON.parse(read('requests',file)),text=read('responses',file),report=validateWorkflowContract(text);
 assertDecisions(JSON.parse(text),brief);
 const f=memoryLibrary();try{
  const one=f.library.importJSON(text),two=f.library.importJSON(text);assert.notEqual(one.workflow.id,two.workflow.id);assert.equal(f.all('flow').length,2);assert.equal(f.all('run').length,0);
  assertDecisions(one.workflow,brief);
  const roundtrip=portableWorkflow(editorToWorkflow(workflowToEditor(one.workflow)),{routes}).workflow;assertDecisions(roundtrip,brief);
  if(brief.availableAssets.some(a=>a.local)){
   assert.equal(report.executionPreflight.valid,false);assert.match(report.executionPreflight.error,/источник|файл/);assert.ok(report.warnings.length);
  }else{
   assert.equal(report.executionPreflight.valid,true,report.executionPreflight.error);const calls=await simulate(one.workflow,brief);
   if(file==='01-stadium.json'){assert.equal(calls.filter(c=>c.params.model===brief.modelIds.video).length,1);assert.equal(calls.at(-1).params.duration_secs,20);assert.equal(calls.at(-1).params.input_references.length,4)}
  }
 }finally{f.db.close()}
});

test('contract registry matches the current Studio operation registry',()=>{
 assert.deepEqual(JSON.parse(readFileSync(new URL('contracts/workflow/operations.json',root))),operationRegistry());
});

test('contract rejects malformed wiring and silently discarded fields',()=>{
 const fresh=()=>JSON.parse(read('responses','01-stadium.json'));
 const mutations=[
  w=>w.workflow=w.steps,
  w=>w.steps[0].nodes[0].inputs.input_refrences=[],
  w=>w.steps[0].nodes[0].parameters.model='unwanted-duplicate',
  w=>w.steps[0].nodes[0].parameters.dep={$node:{nodeId:'final',path:'data.0.url'}},
  w=>w.steps[1].edges[0].from.port='videos',
  w=>w.steps[1].edges[0].from.nodeId='absent',
  w=>w.steps[1].edges[0].from.outputIndex=1,
  w=>w.steps[1].edges[0].to.slot=8,
  w=>w.steps[1].nodes[0].inputs.input_references=[{url:'https://fixtures.invalid/collision.png'}],
  w=>w.steps[1].edges[0].id=w.steps[0].edges[0].id,
  w=>w.steps[0].nodes[0].wait=false,
  w=>w.steps[0].nodes[0].op='POST /unknown',
  w=>w.steps[0].nodes[0].parameters.asset={assetId:'not-portable'},
  w=>w.steps[0].nodes[0].parameters.raw={$media:{nodeId:'hero',port:'images',index:0}},
  w=>w.steps[1].nodes[0].parameters.raw={$node:{nodeId:'hero',path:13}}
 ];
 for(const [i,mutate] of mutations.entries()){const w=fresh();mutate(w);assert.throws(()=>validateWorkflowContract(JSON.stringify(w)),undefined,'mutation '+i)}
 for(const text of ['not JSON','[]',JSON.stringify(fresh()).replace('"version":2','"version":9'),' {"version":2,"name":"x","steps":[],"__proto__":{}}'])assert.throws(()=>validateWorkflowContract(text));
});

test('draft import does not require every API field; arbitrary ordinary parameters survive',()=>{
 const w=JSON.parse(read('responses','01-stadium.json')),n=w.steps[0].nodes[0];
 n.parameters.experimental_setting={enabled:true,value:7};assert.equal(validateWorkflowContract(JSON.stringify(w)).importValid,true);
 assert.deepEqual(parseWorkflowJSON(JSON.stringify(w)).workflow.steps[0].nodes[0].parameters.experimental_setting,n.parameters.experimental_setting);
 n.parameters={};delete n.model;const report=validateWorkflowContract(JSON.stringify(w));assert.equal(report.importValid,true);assert.equal(report.executionPreflight.valid,false);
});

test('all six independent responses import through isolated HTTP without generation or production DB access',{timeout:15000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'vr-contract-'));let child;
 try{
  for(const file of ['server.mjs','engine.mjs','graph-engine.mjs','webhooks.mjs','library.mjs','grok-cli.mjs','artifacts.mjs','public'])cpSync(new URL(file,root),path.join(dir,file),{recursive:true});
  writeFileSync(path.join(dir,'offline.mjs'),"globalThis.fetch=async()=>{throw Error('External API forbidden in contract import check')};");
  child=spawn(process.execPath,['--import',path.join(dir,'offline.mjs'),path.join(dir,'server.mjs')],{env:{...process.env,PORT:'18807',VIDEOROUTER_API_KEY:'',VIDEOROUTER_MANAGEMENT_KEY:'',VIDEOROUTER_WEBHOOK_ENABLED:'0',VIDEOROUTER_WEBHOOK_SECRET:''},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',d=>errors+=d);
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Server exited: '+errors)})]);
  const local=async(p,body)=>{
   const r=await fetch('http://127.0.0.1:18807/local/'+p,{method:body===undefined?'GET':'POST',headers:{'X-Studio':'1','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
   const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;
  };
  const ids=new Set();
  for(const file of files){const result=await local('workflow/import',{text:read('responses',file)});assert.ok(result.workflow.id);ids.add(result.workflow.id);assertDecisions(result.workflow,JSON.parse(read('requests',file)))}
  assert.equal(ids.size,6);const state=await local('state');assert.equal(state.flows.length,6);assert.equal(state.runs.length,0);
 }finally{if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done}rmSync(dir,{recursive:true,force:true})}
});

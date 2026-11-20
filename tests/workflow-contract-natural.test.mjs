import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {validateWorkflowContract} from '../contracts/workflow/validate.mjs';
import {createLibrary} from '../library.mjs';
import {compileGraph,editorToWorkflow,workflowToEditor} from '../public/graph.mjs';
import {portableWorkflow} from '../public/workflow-json.mjs';
import {createGraphRunner,graphRun} from '../graph-engine.mjs';

const routes=new Map(JSON.parse(readFileSync(new URL('../public/catalog.json',import.meta.url))).routes.map(r=>[r.id,r]));
function checkIntent(workflow){
 const plan=compileGraph(workflow),nodes=new Map(workflow.steps.flatMap(s=>s.nodes.map(n=>[n.id,n])));
 const ordered=plan.stages.flatMap(s=>s.nodeIds).map(id=>nodes.get(id));
 assert.equal(ordered.length,5);assert.equal(ordered[0].operationId,'text-to-image');
 assert.equal(ordered[0].model,'google/nano-banana-2');
 assert.match(ordered[0].parameters.prompt,/7/);assert.match(ordered[0].parameters.prompt,/сини|blue/i);assert.match(ordered[0].parameters.prompt,/столб|column|pillar|post/i);
 assert.equal(workflow.steps.reduce((sum,s)=>sum+s.edges.length,0),4);
 for(const s of workflow.steps){assert.equal(s.enabled,true);assert.equal(s.continueOnSuccess,true)}
 for(const [i,n] of ordered.entries()){
  assert.equal(n.kind,'image');assert.equal(n.op,'POST /v1/images');assert.equal(n.parameters.n??1,1);
  assert.ok(Object.values(n.inputs).every(bindings=>bindings.every(b=>b===null)),'no invented external assets');
  if(!i)continue;
  assert.equal(n.operationId,'image-edit');assert.equal(n.model,'google/nano-banana-2-edit');
  assert.match(n.parameters.prompt,/неч[её]тн|odd/i);assert.match(n.parameters.prompt,/красн|red/i);
  assert.equal(n.parameters.prompt,ordered[1].parameters.prompt);
  const group=workflow.steps.find(s=>s.nodes.some(v=>v.id===n.id)),incoming=group.edges.filter(e=>e.to.nodeId===n.id);
  assert.equal(incoming.length,1);const e=incoming[0];assert.equal(e.from.nodeId,ordered[i-1].id);
  assert.equal(e.from.stepId,workflow.steps.find(s=>s.nodes.some(v=>v.id===ordered[i-1].id)).id);
  assert.equal(e.from.port,'images');assert.equal(e.from.outputIndex,0);assert.equal(e.to.port,'input_references');assert.equal(e.to.slot,0);
 }
 return ordered;
}

test('plain user request: one image followed by four sequential edits, without a supplied graph',async()=>{
 const text=readFileSync(new URL('fixtures/workflow-contract/natural/response.txt',import.meta.url),'utf8');
 const report=validateWorkflowContract(text);assert.equal(report.importValid,true);assert.equal(report.executionPreflight.valid,true,report.executionPreflight.error);
 checkIntent(JSON.parse(text));
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE records(kind TEXT,id TEXT,body TEXT,PRIMARY KEY(kind,id))');
 const all=kind=>db.prepare('SELECT body FROM records WHERE kind=?').all(kind).map(r=>JSON.parse(r.body));
 const save=(kind,item)=>db.prepare('INSERT INTO records VALUES(?,?,?)').run(kind,item.id,JSON.stringify(item));
 const get=(kind,id)=>{const r=db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind,id);return r&&JSON.parse(r.body)};
 try{
  const library=createLibrary({db,all,get,save,routes}),{workflow}=library.importJSON(text),ordered=checkIntent(workflow);
  assert.equal(all('flow').length,1);assert.equal(all('run').length,0);
  checkIntent(portableWorkflow(editorToWorkflow(workflowToEditor(workflow)),{routes}).workflow);
  const calls=[],url=i=>'https://fixtures.invalid/natural-'+i+'.png';
  const unexpected=()=>{throw Error('No file access in this offline scenario')};
  const runner=createGraphRunner({routes,save:()=>{},readAsset:unexpected,storeFile:unexpected,call:async(route,params)=>{
   if(route.path==='/v1/pricing/estimate')return {data:{estimated_cost_usd:0,assumptions:{}},cost:null};
   assert.equal(route.path,'/v1/images');const i=calls.length;assert.ok(i<5);calls.push(structuredClone(params));
   assert.equal(params.prompt,ordered[i].parameters.prompt);assert.equal(params.model,ordered[i].model);
   assert.deepEqual((params.input_references||[]).map(r=>r.image_url.url),i?[url(i-1)]:[],'every edit must consume the immediately preceding output');
   return {data:{data:[{url:url(i)}]},cost:0};
  }});
  const run=graphRun('Natural request',workflow);await runner.start(run);
  assert.equal(run.status,'completed',run.error);assert.equal(calls.length,5);assert.ok(run.steps.every(s=>s.status==='completed'));
  assert.equal(all('run').length,0,'simulation must not write execution history');
 }finally{db.close()}
});

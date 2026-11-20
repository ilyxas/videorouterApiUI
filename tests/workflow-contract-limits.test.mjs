import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createLibrary} from '../library.mjs';
import {compileGraph} from '../public/graph.mjs';
import {validateWorkflowContract} from '../contracts/workflow/validate.mjs';

const base=new URL('fixtures/workflow-contract/boundary/',import.meta.url);
const routes=new Map(JSON.parse(readFileSync(new URL('../public/catalog.json',import.meta.url))).routes.map(r=>[r.id,r]));
const brief=name=>JSON.parse(readFileSync(new URL('requests/'+name+'.json',base)));
const response=name=>readFileSync(new URL('responses/'+name+'.txt',base),'utf8');
const id=(prefix,i)=>prefix+String(i).padStart(3,'0');
const jsonDepth=(value,depth=0)=>value&&typeof value==='object'?Math.max(depth,...Object.values(value).map(v=>jsonDepth(v,depth+1))):depth;

// Independent construction of the requested structure, not supplied to the consumer agent.
function requestedWorkflow(b){
 const count=b.decisions.stepCount;
 return {version:2,name:b.name,steps:Array.from({length:count},(_,index)=>{
  const i=index+1,role=i===1?'image':i===count?'video':'edit';
  const decision=i===1?b.decisions.first:i===count?b.decisions.last:b.decisions.middle;
  const prompt=i===1||i===count?decision.prompt:`Refine pass ${i}: preserve the same hero, blue phone and stadium lake; improve visual clarity.`;
  return {id:id('s',i),name:'Step '+i,enabled:true,continueOnSuccess:true,view:'cards',nodes:[{
   id:id('n',i),kind:role==='video'?'video':'image',operationId:decision.operation,op:role==='video'?'POST /v1/videos':'POST /v1/images',model:b.modelIds[role],parameters:{...structuredClone(decision.parameters),prompt},inputs:{}
  }],edges:i===1?[]:[{id:id('e',i),from:{stepId:id('s',i-1),nodeId:id('n',i-1),port:'images',outputIndex:0},to:{nodeId:id('n',i),port:'input_references',slot:0}}]};
 })};
}

function repository(){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE records(kind TEXT,id TEXT,body TEXT NOT NULL,PRIMARY KEY(kind,id))');
 const all=kind=>db.prepare('SELECT body FROM records WHERE kind=?').all(kind).map(r=>JSON.parse(r.body));
 const get=(kind,id)=>{const row=db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind,id);return row&&JSON.parse(row.body)};
 const save=(kind,v)=>db.prepare('INSERT INTO records VALUES(?,?,?)').run(kind,v.id,JSON.stringify(v));
 return {db,all,library:createLibrary({db,all,get,save,routes})};
}

test('blind limit brief 07: 100-card dependency chain, JSON depth exactly 64, real import preserves decisions',()=>{
 const b=brief('07-long-refinement'),expected=requestedWorkflow(b),text=response('07-long-refinement');
 assert.equal(jsonDepth(expected),64,'oracle must reach the exact boundary');
 const actual=JSON.parse(text),report=validateWorkflowContract(text);
 assert.equal(report.importValid,true);assert.equal(report.executionPreflight.valid,true,report.executionPreflight.error);
 assert.equal(report.steps,100);assert.equal(report.cards,100);assert.equal(jsonDepth(actual),64);
 assert.equal(actual.name,expected.name);
 for(let i=0;i<100;i++){
  const a=actual.steps[i],e=expected.steps[i];
  for(const key of ['id','name','enabled','continueOnSuccess','view'])assert.deepEqual(a[key],e[key]);
  assert.equal(a.nodes.length,1);const n=a.nodes[0];
  for(const key of ['id','kind','operationId','op','model','parameters'])assert.deepEqual(n[key],e.nodes[0][key]);
  assert.ok(Object.keys(n.inputs).every(key=>key==='input_references'));
  assert.ok(Object.values(n.inputs).every(bindings=>bindings.length===0||bindings.length===1&&bindings[0]===null));
  assert.equal(a.edges.length,e.edges.length);
  if(i){assert.deepEqual(a.edges[0].from,e.edges[0].from);assert.deepEqual(a.edges[0].to,e.edges[0].to)}
 }
 const plan=compileGraph(actual);assert.equal(plan.stages.length,100);assert.deepEqual(plan.stages.map(s=>s.nodeIds),expected.steps.map(s=>s.nodes.map(n=>n.id)));
 const r=repository();try{
  const imported=r.library.importJSON(text);assert.ok(imported.workflow.id);assert.equal(jsonDepth(imported.workflow),64);
  assert.deepEqual(imported.workflow.steps.at(-1).nodes[0].parameters,expected.steps.at(-1).nodes[0].parameters);
  assert.equal(r.all('flow').length,1);assert.equal(r.all('run').length,0);
 }finally{r.db.close()}
});

test('blind limit brief 08: depth 65 is refused without silently changing the requested workflow',()=>{
 const b=brief('08-directed-motion'),expected=requestedWorkflow(b),text=response('08-directed-motion');
 assert.equal(expected.steps.length,65);assert.equal(jsonDepth(expected),65,'oracle must exceed depth by exactly one');
 let returned;try{returned=JSON.parse(text)}catch{}
 assert.ok(!(returned?.version===2&&Array.isArray(returned.steps)),'agent must report the conflict instead of returning a changed/invalid workflow');
 assert.match(text,/64/);assert.match(text,/65/);assert.match(text,/depth|nest|глуб|влож/i);
 const r=repository();try{
  assert.throws(()=>validateWorkflowContract(JSON.stringify(expected)),/глубоко/);
  assert.throws(()=>r.library.importJSON(JSON.stringify(expected)),/глубоко/);
  assert.equal(r.all('flow').length,0);assert.equal(r.all('run').length,0);
 }finally{r.db.close()}
});

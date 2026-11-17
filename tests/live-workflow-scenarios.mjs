// Explicit, paid acceptance runner. Never runs under `node --test tests/*.test.mjs`.
// Connect keys in Studio first; no credentials are read or persisted here.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {editorToWorkflow} from '../public/graph.mjs';

const cases=['01 · Four source Steps','02 · Two active + two reused → Video','03 · Pin earlier output','04 · Missing output and dependent skip → Video','05 · Live disable, pause/resume → four-reference Video'];
if(!process.argv.includes('--run-live')){
 console.log('Paid scenarios (opt-in):\n'+cases.join('\n')+'\nRun: node tests/live-workflow-scenarios.mjs --run-live --budget=4');
 process.exit(0);
}
const budget=Number(process.argv.find(a=>a.startsWith('--budget='))?.split('=')[1]);
assert(Number.isFinite(budget)&&budget>0&&budget<=4,'Explicit --budget required, at most $4 for this acceptance set');
const base=process.env.STUDIO_URL||'http://127.0.0.1:8791';
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(base),'Use the local Studio server');
const root=fileURLToPath(new URL('../',import.meta.url));
const workflowId=randomUUID(),report={workflowId,started:new Date().toISOString(),budget,cases:[]};
mkdirSync(root+'data/live-checks',{recursive:true});
const reportFile=root+'data/live-checks/'+workflowId+'.json';
function checkpoint(){writeFileSync(reportFile,JSON.stringify(report,null,2))}
async function local(path,body){
 const response=await fetch(base+'/local/'+path,{method:body===undefined?'GET':'POST',headers:{'X-Studio':'1','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await response.json();if(!response.ok)throw Error(path+': '+data.error);return data;
}
async function wallet(){const s=await local('account',{});return s.account}
const balance=w=>Number(w.balance_usd??w.balance??w.available_balance);
const state=await local('state');assert(!state.runs.some(r=>r.status==='running'),'Another run is active');
report.before=await wallet();assert(Number.isFinite(balance(report.before)),'Unrecognized wallet schema');checkpoint();
console.log(JSON.stringify({reportFile,workflowId,walletBefore:report.before}));
const image=(id,prompt)=>({id,op:'POST /v1/images',action:'text-to-image',params:{model:'gemini-2.5-flash-image',prompt,n:1},reuse:{mode:'latest'}});
const sourceIds=['teapot','vase','orange','leaf'];
const rows=[
 image('teapot','A small matte blue ceramic teapot, isolated on a pale cream studio background, realistic product photo, square image, no text.'),
 image('vase','A small tall coral ceramic vase, isolated on a pale cream studio background, realistic product photo, square image, no text.'),
 image('orange','A single ripe orange fruit with one green leaf, isolated on a pale cream studio background, realistic product photo, square image, no text.'),
 image('leaf','A small fresh green monstera leaf in a white ceramic cup, isolated on a pale cream studio background, realistic product photo, square image, no text.'),
 {id:'video',op:'POST /v1/videos',action:'reference-to-video',wait:true,params:{model:'fal/seedance-2.0',prompt:'Create a calm studio still life combining the blue teapot from @Image1, coral vase from @Image2, orange fruit from @Image3, and green leaf in a white cup from @Image4. All four objects sit together on a pale cream table. Slow gentle camera movement, preserve object identity and colors. No text.',duration_secs:5,resolution:'480p',aspect_ratio:'16:9',provider:{only:['fal'],allow_fallbacks:false}},media:{input_references:{mode:'list',items:sourceIds.map(stepId=>({mode:'previous',stepId,port:'images',index:0}))}}}
];
let workflow=editorToWorkflow({id:workflowId,name:'Проверка · 4 references — active / reused',steps:rows,groups:[...sourceIds,'video'].map((id,i)=>({id:'step-'+id,name:'Step '+(i+1)+' · '+id,nodeIds:[id],view:'flow',enabled:id!=='video',continueOnSuccess:true}))});
const node=id=>workflow.steps.flatMap(s=>s.nodes).find(n=>n.id===id);
const step=id=>workflow.steps.find(s=>s.id==='step-'+id);
const remaining=async(allowance)=>{
 const current=await wallet(),reported=report.cases.reduce((sum,r)=>sum+(r.cost||0),0);
 // Video billing may settle later than job completion; include holds and API cost.
 const spent=Math.max(0,reported,balance(report.before)-balance(current),Number(report.before.available_usd??balance(report.before))-Number(current.available_usd??balance(current)));
 assert(spent+allowance<=budget,`Budget guard: spent $${spent}, next conservative allowance $${allowance}, limit $${budget}`);
 assert(Number(current.available_usd??balance(current))>=allowance,'Insufficient wallet balance');return current;
};
async function settle(id,target='completed'){
 let last='';
 for(let i=0;i<600;i++){
  const r=await local('run/'+id+'?view=workflow'),signature=r.status+':'+r.currentStage+':'+r.steps.map(n=>n.status).join(',');
  if(signature!==last){console.log(JSON.stringify({run:id,status:r.status,stage:r.currentStage,nodes:r.steps.map(n=>({id:n.id,status:n.status}))}));last=signature}
  if(r.status!=='running'){assert.equal(r.status,target,r.error||'Unexpected terminal state');return local('run/'+id)}
  await sleep(2000);
 }
 throw Error('Still running; inspect the recorded run ID. Do not resubmit.');
}
async function begin(index,allowance,expected){
 await remaining(allowance);await local('workflow',workflow);
 const prepared=await local('prepare',{name:cases[index],workflow});
 for(const [id,status] of Object.entries(expected))assert.equal(prepared.preview.find(n=>n.id===id)?.status,status,'Preview '+id);
 const started=await local('run',prepared),record={name:cases[index],runId:started.id,expected};report.cases.push(record);checkpoint();console.log(JSON.stringify({started:record}));return record;
}
function referenceURL(a){return a.file?'data:'+a.mime+';base64,'+readFileSync(root+'data/files/'+a.file).toString('base64'):a.url}
async function verify(record,r,expected,video=false){
 assert.equal(r.status,'completed');
 for(const [id,status] of Object.entries(expected)){
  const row=r.steps.find(n=>n.id===id);assert.equal(row.status,status,id);
  if(status!=='completed'){assert.equal(row.request,undefined,id+' must not submit');assert.equal(row.estimate,undefined,id+' must not quote');assert.equal(row.technical.length,0);assert.equal(row.cost,0)}
 }
 if(video){
  const refs=r.steps.find(n=>n.id==='video').request.params.input_references;
  assert.equal(refs.length,4);
  refs.forEach((ref,i)=>assert.equal(ref.image_url.url,referenceURL(r.steps.find(n=>n.id===sourceIds[i]).artifacts[0]),'Exact source bytes '+sourceIds[i]));
 }
 assert(r.steps.every(n=>n.technical.length===0),'Small references should not upload');
 record.status=r.status;record.cost=r.cost;record.nodes=r.steps.map(n=>({id:n.id,status:n.status,cost:n.cost,reason:n.reason,omitted:n.omitted,reusedFrom:n.reusedFrom,artifactIds:n.artifacts.map(a=>a.id),requestReferenceCount:n.request?.params.input_references?.length,remoteId:n.remoteId}));
 record.videoURL=r.steps.find(n=>n.id==='video')?.artifacts[0]?.url;
 record.wallet=await wallet();checkpoint();
 assert(Math.max(report.cases.reduce((sum,r)=>sum+(r.cost||0),0),balance(report.before)-balance(record.wallet))<=budget,'Budget exceeded; no further calls');
 console.log(JSON.stringify({verified:record.name,cost:r.cost,balance:balance(record.wallet)}));
}
try{
 const one=await begin(0,.5,{teapot:'waiting',vase:'waiting',orange:'waiting',leaf:'waiting',video:'skipped'});
 await verify(one,await settle(one.runId),{teapot:'completed',vase:'completed',orange:'completed',leaf:'completed',video:'skipped'});
 step('teapot').enabled=false;step('vase').enabled=false;step('video').enabled=true;
 node('orange').parameters.prompt+=' Add a second small green leaf.';node('leaf').parameters.prompt+=' Use a gently curved leaf stem.';
 const two=await begin(1,1.2,{teapot:'reused',vase:'reused',orange:'waiting',leaf:'waiting',video:'waiting'});
 await verify(two,await settle(two.runId),{teapot:'reused',vase:'reused',orange:'completed',leaf:'completed',video:'completed'},true);
 step('orange').enabled=false;node('orange').reuse={mode:'pinned',runId:one.runId};step('video').enabled=false;
 node('leaf').parameters.prompt+=' Warm soft afternoon light.';
 const three=await begin(2,.15,{teapot:'reused',vase:'reused',orange:'reused',leaf:'waiting',video:'reused'}),r3=await settle(three.runId);
 assert.equal(r3.steps.find(n=>n.id==='orange').reusedFrom.runId,one.runId);
 await verify(three,r3,{teapot:'reused',vase:'reused',orange:'reused',leaf:'completed',video:'reused'});
 step('leaf').enabled=false;step('video').enabled=true;
 const ghost=structuredClone(step('teapot'));Object.assign(ghost,{id:'step-ghost',name:'Disabled · no output',enabled:false});ghost.nodes[0].id='ghost';
 const edit=structuredClone(ghost);Object.assign(edit,{id:'step-ghost-edit',name:'Dependent · skip',enabled:true});Object.assign(edit.nodes[0],{id:'ghost-edit',operationId:'image-edit',inputs:{input_references:[]},parameters:{prompt:'Add a thin gold stripe',n:1}});edit.edges=[{id:'ghost-edit-edge',from:{stepId:ghost.id,nodeId:'ghost',port:'images',outputIndex:0},to:{nodeId:'ghost-edit',port:'input_references',slot:0}}];
 workflow.steps.splice(4,0,ghost,edit);
 step('video').edges.push({id:'ghost-video-edge',from:{stepId:ghost.id,nodeId:'ghost',port:'images',outputIndex:0},to:{nodeId:'video',port:'input_references',slot:4}});
 const four=await begin(3,1.1,{teapot:'reused',vase:'reused',orange:'reused',leaf:'reused',ghost:'skipped','ghost-edit':'skipped',video:'waiting'}),r4=await settle(four.runId);
 assert.deepEqual(r4.steps.find(n=>n.id==='video').omitted,['ghost']);
 await verify(four,r4,{teapot:'reused',vase:'reused',orange:'reused',leaf:'reused',ghost:'skipped','ghost-edit':'skipped',video:'completed'},true);
 workflow.steps=workflow.steps.filter(s=>!s.id.startsWith('step-ghost'));step('video').edges=step('video').edges.filter(e=>e.id!=='ghost-video-edge');
 step('teapot').enabled=true;step('vase').enabled=true;step('leaf').enabled=true;
 node('teapot').parameters.prompt+=' Add one thin golden stripe.';
 const five=await begin(4,1.2,{teapot:'waiting',vase:'waiting',orange:'reused',leaf:'waiting',video:'waiting'});
 let control=await local('run/'+five.runId+'/control',{revision:0,stepId:'step-vase',enabled:false});
 await local('run/'+five.runId+'/control',{revision:control.revision,pauseAfterCurrent:true});
 const paused=await settle(five.runId,'paused');assert.equal(paused.currentStage,1);assert.equal(paused.steps.find(n=>n.id==='teapot').status,'completed');
 workflow=structuredClone(paused.config.workflow);
 // Reorder independent future Steps while keeping each source before Video.
 [workflow.steps[2],workflow.steps[3]]=[workflow.steps[3],workflow.steps[2]];
 const resume=await local('prepare',{workflow,runId:five.runId,revision:paused.revision});
 await local('run/'+five.runId+'/resume',resume);
 const r5=await settle(five.runId);assert.equal(r5.controls.length,2);assert.equal(r5.revisions.length,1);assert.equal(r5.steps.find(n=>n.id==='orange').reusedFrom.runId,one.runId);
 await verify(five,r5,{teapot:'completed',vase:'reused',orange:'reused',leaf:'completed',video:'completed'},true);
 await local('workflow',workflow);
 report.after=await wallet();
 for(let i=0;i<12&&balance(report.after)-Number(report.after.available_usd??balance(report.after))>.0001;i++){await sleep(5000);report.after=await wallet()}
 report.billingPending=balance(report.after)-Number(report.after.available_usd??balance(report.after))>.0001;
 report.walletDelta=balance(report.before)-balance(report.after);report.apiCost=report.cases.reduce((s,r)=>s+r.cost,0);report.status='passed';checkpoint();
 console.log(JSON.stringify({status:'passed',reportFile,workflowId,walletDelta:report.walletDelta,apiCost:report.apiCost,finalVideo:five.videoURL}));
}catch(e){report.status='stopped';report.error=e.message;checkpoint();console.error('STOP: '+e.message+'\nInspect '+reportFile+' before any retry.');process.exitCode=1}

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {editorToWorkflow,workflowToEditor,compileGraph,cardFactory,ImageCard} from '../public/graph.mjs';
import {graphRun,createGraphRunner,reviseRun,validateGraphRequests} from '../graph-engine.mjs';
import {previewEstimate} from '../public/workflow-core.mjs';
const catalog=JSON.parse(readFileSync(new URL('../public/catalog.json',import.meta.url)));
const routes=new Map(catalog.routes.map(r=>[r.id,r]));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=','base64');
function fixture(continueOnSuccess=true){return {name:'Acceptance',steps:[
 {id:'generate',op:'POST /v1/images',action:'text-to-image',params:{model:'gpt-image-1',prompt:'Teapot',n:1}},
 {id:'edit',op:'POST /v1/images',action:'image-edit',params:{model:'gemini-2.5-flash-image',prompt:'Gold stripe',n:1},media:{input_references:{mode:'list',items:[{mode:'previous',stepId:'generate',port:'images',index:0}]}}},
 {id:'video',op:'POST /v1/videos',action:'reference-to-video',params:{model:'bytedance/seedance-2.0',prompt:'Animate',duration_secs:5,resolution:'480p'},media:{input_references:{mode:'list',items:[{mode:'previous',stepId:'edit',port:'images',index:0},{mode:'file',file:'local'}]}}}
],groups:[{id:'step1',name:'Step 1',continueOnSuccess,nodeIds:['generate','edit']},{id:'step2',name:'Step 2',continueOnSuccess:true,nodeIds:['video']}]}}
function transport({failure=false,large=false}={}){
 const calls=[],saved=[],files=new Map([['local',{bytes:large?Buffer.alloc(7*1024*1024):png,type:'image/png',name:'local.png'}]]);
 const storeFile=(bytes,name,type)=>{const file='asset-'+files.size;files.set(file,{bytes,name,type});return {file,name,type,local_url:'/asset/'+file}};
 const call=async(route,params)=>{
  calls.push({path:route.path,params:structuredClone(params)});
  if(route.path==='/v1/pricing/estimate')return {data:{estimated_cost_usd:0.1,assumptions:{duration_secs:params.duration_secs}},cost:null};
  if(route.path==='/v1/images'){
   if(failure)throw Error('Fixture image failure');
   return {data:params.input_references?{data:[{b64_json:png.toString('base64')+'',media_type:'image/png'}]}:{data:[{url:'https://fixture.invalid/generated.png'}]},cost:0.01};
  }
  if(route.path==='/v1/uploads')return {data:{url:'https://fixture.invalid/uploaded.png',expires_in:1800},cost:0};
  if(route.path==='/v1/videos')return {data:{id:'video-fixture',status:'queued'},cost:0.1};
  if(route.path==='/v1/videos/{id}')return {data:{id:'video-fixture',status:'completed',data:[{url:'https://fixture.invalid/video.mp4'}]},cost:0.1};
  throw Error('Unexpected API: '+route.path);
 };
 const runner=createGraphRunner({routes,call,storeFile,readAsset:id=>{if(!files.has(id))throw Error('Missing asset');return files.get(id)},save:r=>saved.push(structuredClone(r)),pollDelay:0});
 return {runner,calls,saved,files};
}
test('v2 roundtrip, classes, stable selected outputs, topology and cycle/type validation',()=>{
 const w=editorToWorkflow(fixture());assert.equal(w.steps.length,2);assert.equal(w.steps[0].nodes.length,2);
 assert.ok(cardFactory(w.steps[0].nodes[0]) instanceof ImageCard);
 assert.deepEqual(compileGraph(w).stages.map(s=>s.nodeIds),[['generate','edit'],['video']]);
 const restored=editorToWorkflow(workflowToEditor(w));assert.deepEqual(restored.steps.map(s=>s.edges),w.steps.map(s=>s.edges));
 assert.deepEqual(validateGraphRequests(restored,routes).stages,compileGraph(w).stages);
 const cycle=structuredClone(w);cycle.steps[0].edges.push({id:'cycle',from:{stepId:'step1',nodeId:'edit',port:'images',outputIndex:0},to:{nodeId:'generate',port:'input_references',slot:0}});
 cycle.steps[0].nodes[0].operationId='image-edit';assert.throws(()=>compileGraph(cycle),/Цикл/);
 const wrong=structuredClone(w);wrong.steps[1].edges[0].from.port='audio';assert.throws(()=>compileGraph(wrong),/порты/);
 const backwards=structuredClone(w);backwards.steps.reverse();assert.throws(()=>compileGraph(backwards),/будущего/);
 const index=structuredClone(w);index.steps[1].edges[0].from.outputIndex=5;assert.throws(()=>compileGraph(index),/output/);
});
test('acceptance: two Steps, generated → edited image plus local reference → video, no external upload',async()=>{
 const t=transport(),run=graphRun('Acceptance',editorToWorkflow(fixture()));await t.runner.start(run);
 assert.equal(run.status,'completed',run.error);assert.equal(run.stages.length,2);assert.equal(run.steps.length,3);
 assert.equal(t.calls.filter(c=>c.path==='/v1/uploads').length,0);
 assert.deepEqual(t.calls.filter(c=>['/v1/images','/v1/videos'].includes(c.path)).map(c=>c.path),['/v1/images','/v1/images','/v1/videos']);
 const video=t.calls.find(c=>c.path==='/v1/videos').params;
 assert.equal(video.start_image_url,undefined);assert.equal(video.input_references.length,2);
 assert.match(video.input_references[0].image_url.url,/^data:image\/png;base64,/);
 assert.notEqual(video.input_references[0].image_url.url,'https://fixture.invalid/generated.png');
 assert.equal(video.input_references[1].image_url.url,'data:image/png;base64,'+png.toString('base64'));
 for(const row of run.steps){const {endpoint,...quote}=row.estimate.request;assert.deepEqual(quote,row.request.params);assert.ok(endpoint);assert.ok(row.idempotencyKey)}
 assert.equal(run.steps[2].artifacts[0].type,'video');assert.equal(run.steps[2].remoteId,'video-fixture');
 assert.equal(run.steps[2].remoteStatus,'completed');
 assert.equal(run.steps[0].artifacts[0].url,'https://fixture.invalid/generated.png');
 assert.ok(run.steps[1].artifacts[0].file);
});
test('pause allows editing any Step; continue keeps outputs without implicit regeneration',async()=>{
 const t=transport(),run=graphRun('Pause',editorToWorkflow(fixture(false)));await t.runner.start(run);
 assert.equal(run.status,'paused');assert.equal(run.currentStage,1);assert.equal(t.calls.filter(c=>c.path==='/v1/videos').length,0);
 const persisted=JSON.parse(JSON.stringify(run)),changed=structuredClone(run.config.workflow);changed.steps[1].nodes[0].parameters.prompt='Changed after review';
 changed.steps[0].nodes[0].parameters.prompt='Rewrite for the next explicit generation';
 reviseRun(persisted,changed);await t.runner.start(persisted);
 assert.equal(persisted.status,'completed',persisted.error);assert.equal(t.calls.filter(c=>c.path==='/v1/images').length,2);
 assert.equal(t.calls.find(c=>c.path==='/v1/videos').params.prompt,'Changed after review');assert.equal(persisted.revision,1);
 assert.equal(persisted.steps[0].outputDefinition.parameters.prompt,'Teapot');
});
test('large local reference uses upload fallback; source failure never creates dependent requests',async()=>{
 const t=transport({large:true}),run=graphRun('Large',editorToWorkflow(fixture()));await t.runner.start(run);
 assert.equal(run.status,'completed',run.error);assert.equal(t.calls.filter(c=>c.path==='/v1/uploads').length,1);
 assert.equal(t.calls.find(c=>c.path==='/v1/videos').params.input_references[1].image_url.url,'https://fixture.invalid/uploaded.png');
 const f=transport({failure:true}),failed=graphRun('Failure',editorToWorkflow(fixture()));await f.runner.start(failed);
 assert.equal(failed.status,'failed');assert.equal(f.calls.filter(c=>c.path==='/v1/images').length,1);assert.equal(f.calls.filter(c=>c.path==='/v1/videos').length,0);assert.equal(failed.steps[2].status,'blocked');
});
test('preview of multiple references excludes future and local inputs without doing work',()=>{
 const s=fixture().steps[2];const result=previewEstimate(s);assert.equal(result.request.duration_secs,5);assert.equal(result.request.input_references,undefined);assert.ok(result.omitted.includes('input_references'));
});
test('an empty chosen file is rejected before any generation, and local metadata survives reload',()=>{
 const f=fixture();f.steps[2].media.input_references.items[1]={mode:'file'};
 assert.throws(()=>validateGraphRequests(editorToWorkflow(f),routes),/выберите источник/);
 f.steps[2].media.input_references.items[1]={mode:'file',file:'local',name:'reference.png',width:512,height:512};
 const restored=workflowToEditor(editorToWorkflow(f));assert.deepEqual(restored.steps[2].media.input_references.items[1],f.steps[2].media.input_references.items[1]);
});

test('Step management preserves IDs, view/enable/reuse settings and rejects backward dependencies',async()=>{
 const {moveGraphStep,deleteGraphStep,layoutStep}=await import('../public/graph.mjs');
 const f=fixture();f.groups[0].enabled=false;f.groups[0].view='flow';f.steps[0].reuse={mode:'pinned',runId:'previous'};
 const round=workflowToEditor(editorToWorkflow(f));assert.equal(round.groups[0].enabled,false);assert.equal(round.groups[0].view,'flow');assert.equal(round.steps[0].reuse.runId,'previous');
 assert.throws(()=>moveGraphStep(round,'step2',-1),/будущего/);
 const independent={id:'independent',op:'POST /v1/images',action:'text-to-image',params:{model:'gpt-image-1',prompt:'Independent'}};
 f.steps.push(independent);f.groups.push({id:'step3',nodeIds:[independent.id]});
 const moved=moveGraphStep(f,'step3',-1);assert.deepEqual(moved.groups.map(g=>g.id),['step1','step3','step2']);assert.equal(moved.steps.find(s=>s.id==='video').media.input_references.items[0].stepId,'edit');
 const deleted=deleteGraphStep(f,'step1');assert.equal(deleted.steps.length,2);assert.equal(editorToWorkflow(deleted).steps.flatMap(g=>g.edges).length,0);
 const g=editorToWorkflow(fixture()).steps[0],layout=layoutStep(g);assert.ok(layout.positions.find(p=>p.id==='edit').x>layout.positions.find(p=>p.id==='generate').x);
});

test('four references across Steps: inactive reuse, active regenerate; reuse has no cost or API requests',async()=>{
 const {selectReusable,executionPreview}=await import('../public/workflow-state.mjs');
 const f=fixture(),video=f.steps[2];
 f.steps=Array.from({length:4},(_,i)=>({id:'image'+i,op:'POST /v1/images',action:'text-to-image',params:{model:'gpt-image-1',prompt:'Object '+i,n:1}}));
 video.media.input_references.items=f.steps.map(s=>({mode:'previous',stepId:s.id,port:'images',index:0}));f.steps.push(video);
 f.groups=f.steps.map((s,i)=>({id:'s'+i,nodeIds:[s.id],enabled:i!==4,continueOnSuccess:true}));
 const w=editorToWorkflow(f),t=transport(),first=graphRun('Seed',w);await t.runner.start(first);assert.equal(first.status,'completed',first.error);assert.equal(first.steps[4].status,'skipped');
 w.steps[0].enabled=w.steps[1].enabled=false;w.steps[4].enabled=true;
 const reusable=selectReusable(w,[first],id=>t.files.get(id));const preview=executionPreview(w,compileGraph(w),reusable);assert.deepEqual(preview.map(n=>n.status),['reused','reused','waiting','waiting','waiting']);
 const before=t.calls.length,second=graphRun('Mixed',w,reusable);await t.runner.start(second);assert.equal(second.status,'completed',second.error);
 assert.deepEqual(second.steps.map(n=>n.status),['reused','reused','completed','completed','completed']);
 assert.equal(second.steps[0].artifacts[0].id,first.steps[0].artifacts[0].id);assert.notEqual(second.steps[2].artifacts[0].id,first.steps[2].artifacts[0].id);
 const calls=t.calls.slice(before);assert.equal(calls.filter(c=>c.path==='/v1/images').length,2);assert.equal(calls.filter(c=>c.path==='/v1/videos').length,1);
 assert.equal(calls.find(c=>c.path==='/v1/videos').params.input_references.length,4);assert.equal(second.steps[0].cost,0);assert.ok(Math.abs(second.cost-.12)<1e-9);
});

test('missing inactive outputs prune optional references and skip required descendants without API work',async()=>{
 const {executionPreview}=await import('../public/workflow-state.mjs');
 const w=editorToWorkflow(fixture());w.steps[0].enabled=false;
 const t=transport(),run=graphRun('Omit',w);await t.runner.start(run);
 assert.equal(run.status,'completed',run.error);assert.deepEqual(run.steps.map(s=>s.status),['skipped','skipped','completed']);
 assert.equal(t.calls.filter(c=>c.path==='/v1/images').length,0);assert.equal(t.calls.find(c=>c.path==='/v1/videos').params.input_references.length,1);
 const noLocal=editorToWorkflow(fixture());noLocal.steps[0].enabled=false;noLocal.steps[1].nodes[0].inputs.input_references=[];
 assert.deepEqual(executionPreview(noLocal,compileGraph(noLocal),{}).map(s=>s.status),['skipped','skipped','skipped']);
 const absent=graphRun('No output',noLocal),t2=transport();await t2.runner.start(absent);assert.equal(absent.status,'completed');assert.equal(t2.calls.length,0);assert.equal(absent.cost,0);
});

test('pinned outputs survive newer results; failed, private and expired outputs are not reused',async()=>{
 const {selectReusable,outputCandidates}=await import('../public/workflow-state.mjs');
 const t=transport(),w=editorToWorkflow(fixture()),first=graphRun('First',w);await t.runner.start(first);
 first.steps.forEach(s=>s.finishedAt='2026-11-17T01:00:00Z');
 const next=structuredClone(first);next.id='newer';next.steps.forEach(s=>s.finishedAt='2026-11-18T01:00:00Z');next.steps[0].artifacts[0].url='https://fixture.invalid/newer.png';
 w.steps[0].nodes[0].reuse={mode:'pinned',runId:first.id};
 let sources=selectReusable(w,[next,first],id=>t.files.get(id));assert.equal(sources.generate.runId,first.id);assert.equal(sources.edit.runId,'newer');
 w.steps[0].nodes[0].reuse={mode:'latest'};next.steps[0].status='failed';sources=selectReusable(w,[next,first],id=>t.files.get(id));assert.equal(sources.generate.runId,first.id);
 first.steps[0].privateResult=true;assert.equal(outputCandidates([first],w.id,'generate').length,0);
 next.steps[0].status='completed';next.steps[0].artifacts[0].expiresAt=1;sources=selectReusable(w,[next],()=>{});assert.match(sources.generate.reason,/недоступен/);
});

test('live controls mutate the executing run, reject stale/current changes and resume once',async()=>{
 const t=transport(),w=editorToWorkflow(fixture()),run=graphRun('Control',w);
 // Hold the first save at an async provider boundary by supplying a gate around call.
 let release,entered;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),calls=[];
 const runner=createGraphRunner({routes,save:()=>{},readAsset:id=>t.files.get(id),storeFile:()=>({file:'local',type:'image/png'}),pollDelay:0,call:async(route,p)=>{
  calls.push(route.path);
  if(route.path==='/v1/pricing/estimate')return {data:{assumptions:{}},cost:null};
  if(route.path==='/v1/images'){if(calls.filter(x=>x==='/v1/images').length===1){entered();await gate}return {data:{data:[{url:'https://fixture.invalid/image.png'}]},cost:.01}}
  throw Error('Disabled video must not be called');
 }});
 const running=runner.start(run);await started;
 assert.throws(()=>runner.control(run.id,{revision:0,stepId:'step1',enabled:false}),/Начавшийся/);
 runner.control(run.id,{revision:0,stepId:'step2',enabled:false});assert.equal(run.config.workflow.steps[1].enabled,false);
 assert.throws(()=>runner.control(run.id,{revision:0,pauseAfterCurrent:true}),/Ревизия/);
 runner.control(run.id,{revision:1,pauseAfterCurrent:true});release();await running;assert.equal(run.status,'paused');
 reviseRun(run,run.config.workflow);await runner.start(run);assert.equal(run.status,'completed');assert.equal(run.steps[2].status,'skipped');assert.equal(calls.filter(x=>x==='/v1/images').length,2);
});

test('reference prompt numbering follows surviving slots, missing named references skip safely',async()=>{
 const {resolveNodeInputs,SkipNode}=await import('../public/workflow-state.mjs');
 const w=editorToWorkflow(fixture()),g=w.steps[1],n=g.nodes[0];n.parameters.prompt='Use @Image2';
 let resolved=resolveNodeInputs(n,g,[{id:'edit',status:'skipped',artifacts:[]}]);assert.equal(resolved.parameters.prompt,'Use @Image1');assert.equal(resolved.inputs.input_references.length,1);
 n.parameters.prompt='Use @Image1';assert.throws(()=>resolveNodeInputs(n,g,[{id:'edit',status:'skipped',artifacts:[]}]),SkipNode);
});

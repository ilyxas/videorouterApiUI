import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createGrokProvider} from '../grok-cli.mjs';
import {grokMode,grokQuote,validateGrok} from '../public/grok-profile.mjs';
import {graphRun,createGraphRunner,reviseRun} from '../graph-engine.mjs';
import {validateWorkflowContract} from '../contracts/workflow/validate.mjs';
import {portableWorkflow} from '../public/workflow-json.mjs';
import {resolveNodeInputs,SkipNode} from '../public/workflow-state.mjs';

const png=readFileSync(new URL('fixtures/reference.png',import.meta.url));
const mp4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(12)]);
function fixture(t,change=()=>{}){
 const root=mkdtempSync(path.join(tmpdir(),'grok-provider-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const binary=path.join(root,'grok');writeFileSync(binary,'fixture');const files=new Map(),spawns=[];
 const storeFile=(bytes,name,type)=>{const file=randomUUID();files.set(file,{bytes,name,type});return {file,name,type,local_url:'/asset/'+file}};
 const readAsset=id=>{assert.ok(files.has(id));return files.get(id)};
 const spawnProcess=(bin,args,options)=>{
  assert.equal(bin,binary);assert.equal(options.shell,false);assert.equal(options.env.XAI_API_KEY,undefined);assert.equal(options.env.VIDEOROUTER_API_KEY,undefined);
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{queueMicrotask(()=>child.emit('close',1));return true};
  const id=args[args.indexOf('--session-id')+1],cwd=args[args.indexOf('--cwd')+1],task=JSON.parse(args[args.indexOf('-p')+1].split('TASK JSON:\n')[1]);
  spawns.push({id,task});
  queueMicrotask(()=>{
   const events=[],session=path.join(root,'.grok/sessions',encodeURIComponent(cwd),id);mkdirSync(session,{recursive:true});
   function media(tool,input,number){
    const video=tool==='reference_to_video',file=path.join(session,number+(video?'.mp4':'.png'));writeFileSync(file,video?mp4:png);
    const callId='call-'+number;
    events.push({type:'tool_call',toolCallId:callId,toolName:tool,status:'pending',rawInput:input},{type:'tool_call_update',toolCallId:callId,status:'completed',rawOutput:{type:video?'ReferenceToVideo':tool==='image_edit'?'ImageEdit':'ImageGen',path:file}});
    return file;
   }
   if(task.operation.includes('video')){
    const first=task.first_frame||(task.images?.length?undefined:media('image_gen',{prompt:'A source image'},0));
    media('reference_to_video',{prompt:task.prompt,first_frame:first,images:task.images,duration:task.duration,resolution_name:task.resolution_name,aspect_ratio:task.aspect_ratio},1);
   }else media(task.operation==='image-edit'?'image_edit':'image_gen',{prompt:task.prompt,image:task.images,aspect_ratio:task.aspect_ratio},0);
   events.push({type:'end',stopReason:'end_turn'});change(events,{task,root,session});
   const bytes=Buffer.from(events.map(e=>JSON.stringify(e)).join('\n')+'\n');
   for(let i=0;i<bytes.length;i+=7)child.stdout.write(bytes.subarray(i,i+7));child.stdout.end();child.stderr.end();child.emit('close',0);
  });return child;
 };
 const provider=createGrokProvider({directory:path.join(root,'attempts'),home:root,binary,storeFile,readAsset,spawnProcess,request:()=>{throw Error('Unexpected network request')}});
 return {provider,spawns,files,readAsset,storeFile,root};
}
const image={model:'grok-cli/image',prompt:'A blue mug. Dialogue if visible: «Привет»',aspect_ratio:'1:1',n:1};
const video={model:'grok-cli/video',prompt:'The mug rotates slowly.',duration_secs:6,resolution:'720p',aspect_ratio:'16:9'};
test('Grok zero-based image labels follow surviving references and skip missing named sources',()=>{
 const node={id:'v',kind:'video',operationId:'reference-to-video',op:'POST /v1/videos',model:video.model,parameters:{prompt:'Animate <IMAGE_1>.',duration_secs:6},inputs:{input_references:[null,{url:'https://fixture.invalid/second.png'}]}};
 const group={edges:[{from:{nodeId:'missing',port:'images',outputIndex:0},to:{nodeId:'v',port:'input_references',slot:0}}]},rows=[{id:'missing',status:'skipped',artifacts:[]}];
 const resolved=resolveNodeInputs(node,group,rows);assert.equal(resolved.parameters.prompt,'Animate <IMAGE_0>.');assert.equal(resolved.inputs.input_references.length,1);
 node.parameters.prompt='Animate <IMAGE_0>.';assert.throws(()=>resolveNodeInputs(node,group,rows),SkipNode);
 const reused=[{id:'missing',status:'reused',artifacts:[{port:'images',index:0,url:'https://fixture.invalid/first.png'}]}];
 assert.equal(resolveNodeInputs(node,group,reused).inputs.input_references.length,2);
});
test('Grok validates its modes and limits, and quotes zero without provider calls',()=>{
 assert.equal(grokQuote(video).estimated_cost_usd,0);
 for(const duration_secs of [0,16,1.5])assert.throws(()=>validateGrok('text-to-video',{...video,duration_secs}),/duration/);
 assert.throws(()=>validateGrok('text-to-video',{...video,resolution:'1080p'}),/720p/);
 assert.throws(()=>validateGrok('text-to-image',{...image,n:2}),/one final output/);
 assert.throws(()=>validateGrok('text-to-image',{...image,provider:{only:['xai']}}),/parameter/);
 const refs=Array.from({length:14},()=>({type:'image_url',image_url:{url:'https://fixture.invalid/a.png'}}));
 validateGrok('reference-to-video',{...video,input_references:refs},{complete:true});
 assert.throws(()=>validateGrok('reference-to-video',{...video,input_references:[...refs,refs[0]]}),/14/);
 assert.throws(()=>validateGrok('image-to-video',video,{complete:true}),/start_image_url/);
});
test('Grok imports a final artifact, preserves Unicode, and reuses an attempt without spawning again',async t=>{
 const f=fixture(t),id=randomUUID(),p={...image,$headers:{'Idempotency-Key':id}};
 const result=await f.provider.execute(p);assert.equal(result.cost,0);assert.equal(f.spawns[0].task.prompt,image.prompt);
 assert.equal(result.data.tool_calls[0].parameters.prompt,image.prompt);assert.ok(f.files.has(result.data.data[0].file));
 assert.deepEqual(await f.provider.execute(p),result);assert.deepEqual(await f.provider.recover('grok-cli:'+id),result);assert.equal(f.spawns.length,1);
});
test('all Grok video modes and image edits materialize references and collect intermediates',async t=>{
 const f=fixture(t),asset=f.storeFile(png,'reference.png','image/png');
 const edit=await f.provider.execute({...image,input_references:[{type:'image_url',image_url:{url:{file:asset.file}}}]});assert.equal(edit.data.tool_calls[0].tool,'image_edit');
 for(const p of [video,{...video,start_image_url:{file:asset.file}},{...video,input_references:[{type:'image_url',image_url:{url:{file:asset.file}}}]}]){
  const result=await f.provider.execute(p);assert.equal(result.data.data[0].type,'video/mp4');assert.equal(result.data.status,'completed');
  assert.equal(result.data.intermediates.length,grokMode(p)==='text-to-video'?1:0);
 }
});
test('Grok rejects escaped output paths, mismatched settings, and incomplete endings',async t=>{
 for(const issue of ['path','duration','end']){
  const f=fixture(t,(events,{root})=>{
   if(issue==='path'){const outside=path.join(root,'outside.mp4');writeFileSync(outside,mp4);events.findLast(e=>e.rawOutput).rawOutput.path=outside}
   if(issue==='duration')events.find(e=>e.toolName==='reference_to_video').rawInput.duration=15;
   if(issue==='end')events.at(-1).stopReason='max_turn_requests';
  });await assert.rejects(f.provider.execute(video),issue==='path'?/outside/:issue==='duration'?/preserve/:/without completing/);assert.equal(f.files.size,0);
 }
});
test('Grok workflow runs image → edit, pauses, then produces a reference video and recovers without generation',async t=>{
 const f=fixture(t),catalog=JSON.parse(readFileSync(new URL('../public/catalog.json',import.meta.url))),routes=new Map(catalog.routes.map(r=>[r.id,r]));
 const node=(id,operationId,p)=>({id,kind:p.model.endsWith('video')?'video':'image',operationId,op:p.model.endsWith('video')?'POST /v1/videos':'POST /v1/images',model:p.model,parameters:Object.fromEntries(Object.entries(p).filter(([k])=>k!=='model')),inputs:{}});
 const edge=(id,from,step,to,slot=0)=>({id,from:{stepId:step,nodeId:from,port:'images',outputIndex:0},to:{nodeId:to,port:'input_references',slot}});
 const w={version:2,id:'grok-test',name:'Grok test',steps:[{id:'images',name:'Images',enabled:true,continueOnSuccess:false,nodes:[node('image','text-to-image',image),node('edit','image-edit',image)],edges:[edge('a','image','images','edit')]},{id:'video',name:'Video',enabled:true,continueOnSuccess:true,nodes:[node('video','reference-to-video',video)],edges:[edge('b','image','images','video'),edge('c','edit','images','video',1)]}]};
 const portable=portableWorkflow(w).workflow;
 const checked=validateWorkflowContract(JSON.stringify(portable));assert.equal(checked.importValid,true);assert.equal(checked.executionPreflight.valid,true);
 const call=(route,p,onEvent)=>p.id?f.provider.recover(p.id):route.path==='/v1/pricing/estimate'?{data:f.provider.quote(p),cost:0}:f.provider.execute(p,onEvent);
 const runner=createGraphRunner({routes,call,save(){},readAsset:f.readAsset,storeFile:f.storeFile}),run=graphRun(w.name,w);
 await runner.start(run);assert.equal(run.status,'paused');assert.equal(f.spawns.length,2);
 reviseRun(run,w);await runner.start(run);assert.equal(run.status,'completed');assert.equal(run.cost,0);assert.equal(f.spawns.length,3);
 assert.ok(run.steps.every(s=>s.artifacts[0].file));assert.equal(f.spawns[2].task.images.length,2);
 run.status='interrupted';const row=run.steps[2];row.status='interrupted';row.phase='submitting';delete row.remoteId;row.artifacts=[];
 await runner.recover(run);assert.equal(run.status,'completed');assert.equal(f.spawns.length,3);assert.ok(row.artifacts[0].file);
});

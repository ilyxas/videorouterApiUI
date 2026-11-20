import * as dataCards from '../public/data-cards.mjs';
import * as characterUI from '../public/character-ui.mjs';
import * as core from '../public/workflow-core.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,mkdtempSync,cpSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {freshRun} from '../engine.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const catalog=JSON.parse(readFileSync(path.join(root,'public/catalog.json')));
const source=readFileSync(path.join(root,'public/app.js'),'utf8').split("document.addEventListener('click'")[0].replace(/^import .*\n/gm,'');
function ui(storage=new Map()){
 const elements=new Map();
 const element=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',style:{},checked:true,focus(){},close(){},showModal(){},scrollIntoView(){}});return elements.get(id)};
 const context=vm.createContext({...core,...dataCards,...characterUI,structuredClone,crypto,URL,console,setTimeout:()=>0,clearTimeout(){},
  window:{scrollY:0,scrollTo(){}},localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},
  document:{querySelector:element,querySelectorAll:()=>[]}});
 vm.runInContext(source,context);
 const run=code=>vm.runInContext(code,context);
 context.catalog=catalog;run('cat=catalog;models=cat.models;configureModelCatalog(cat.models);draftReady=true;render=()=>{};header=()=>{}');
 return {run,context,element,storage};
}
const plain=v=>JSON.parse(JSON.stringify(v));
test('Grok cards expose supported controls, retain selected references, and show local zero-cost execution',()=>{
 const a=ui();a.run(`state={keys:{},flows:[],runs:[],grok:{available:true,credentialsPresent:true}};flow={id:'grok-ui',name:'Grok',groups:[{id:'s',name:'Grok',nodeIds:['v']}],steps:[{id:'v',op:videoOp,action:'reference-to-video',params:{model:'grok-cli/video',prompt:'A scene',duration_secs:6,resolution:'1080p',aspect_ratio:'16:9',provider:{only:['xai']}},media:{input_references:{mode:'list',items:[{mode:'url',url:'https://fixture.invalid/image.png'}]}}}]};applyGrokModel(flow.steps[0]);`);
 assert.equal(a.run('flow.steps[0].params.resolution'),'720p');assert.equal(a.run('flow.steps[0].params.provider'),undefined);assert.equal(a.run('flow.steps[0].media.input_references.items.length'),1);
 const card=a.run('graphCard(flow.steps[0],0,false)');assert.match(card,/grok-cli\/video/);assert.match(card,/Included \(\$0 additional\)/);assert.doesNotMatch(card,/1080p|2160p|input_audio_references/);assert.match(card,/720p/);
 assert.match(a.run('settings()'),/existing Grok login/);
 a.run(`flow.steps[0].params.model='grok-cli/image';flow.steps[0].action='text-to-video'`);assert.doesNotThrow(()=>a.run('graphCard(flow.steps[0],0,false)'));
});
test('character workflow UI renders ordered sources, global graph and API media editor',()=>{
 const a=ui();
 a.run(`state={keys:{},flows:[],runs:[],dataCards:[]};flow={id:'ui',name:'Characters',view:'flow',dataCards:[{id:'kira',kind:'character',name:'Kira',assets:[{id:'front',name:'Front portrait',description:'Front view',type:'image',role:'reference',fileId:'front-file'}]}],groups:[{id:'first',name:'First',nodeIds:['edit'],continueOnSuccess:false}],steps:[{id:'edit',op:'POST /v1/images',action:'image-edit',params:{model:'google/nano-banana-2-edit',prompt:'The same woman outdoors'},media:{input_references:{mode:'list',items:[{mode:'character',dataCardId:'kira',assetId:'front'}]}}}]};`);
 const global=a.run('globalFlowHTML()');assert.match(global,/Workflow Flow/);assert.match(global,/CHARACTER/);assert.match(global,/Pause after Step/);assert.match(global,/Front portrait → input_references/);
 const picker=a.run(`mediaPicker(flow.steps[0],0,'input_references#0',['Image','image'])`);assert.match(picker,/Kira \/ Front portrait/);assert.match(picker,/data-character-source/);assert.match(picker,/\/asset\/front-file/);
 const key=a.run('quoteKey(flow.steps[0])');a.run(`flow.dataCards[0].assets[0].fileId='replacement-file'`);assert.notEqual(a.run('quoteKey(flow.steps[0])'),key);
 a.run(`selectedFlowNode='edit'`);assert.match(a.run('globalFlowHTML()'),/data-node-result="edit"/);
 const mobile=a.run('globalFlowCanvasHTML(507)');assert.match(mobile,/flow-vertical/);assert.match(mobile,/edge-selected/);assert.match(mobile,/flow-selected/);assert.match(mobile,/Selected card connections/);assert.match(mobile,/Front portrait → input_references/);
 assert.match(a.run('workflow()'),/Workflow Flow/);
 a.run(`editIndex=0;selected=flow.steps[0].op;params=copy(flow.steps[0].params)`);assert.match(a.run('explorer()'),/Workflow media inputs/);
});
test('character UI actions attach once, save an independent snapshot and mark removed bindings',async()=>{
 const a=ui();a.run(`state={keys:{},flows:[],runs:[],dataCards:[{id:'kira',kind:'character',name:'Kira',description:'Library description',assets:[{id:'front',name:'Front',description:'Front view',type:'image',role:'reference',fileId:'front-file'}]}]};flow={id:'ui',name:'Test',steps:[],groups:[]};`);
 await a.run(`characterAction('attachCharacter','kira',{})`);await assert.rejects(a.run(`characterAction('attachCharacter','kira',{})`),/already/);
 a.run(`openCharacter(flow.dataCards[0],'workflow');characterDraft.description='Workflow description'`);await a.run(`characterAction('saveCharacter','',{})`);
 assert.equal(a.run('flow.dataCards[0].description'),'Workflow description');assert.equal(a.run('state.dataCards[0].description'),'Library description');
 a.run(`flow.steps=[{id:'edit',op:'POST /v1/images',action:'image-edit',params:{model:'google/nano-banana-2-edit',prompt:'Edit'},media:{input_references:{mode:'list',items:[{mode:'character',dataCardId:'kira',assetId:'front'}]}}}];flow.groups=[{id:'first',name:'First',nodeIds:['edit']}];`);
 await a.run(`characterAction('confirmRemoveWorkflowCharacter','kira',{})`);assert.equal(a.run('flow.dataCards.length'),0);assert.equal(a.run(`editorToWorkflow(flow).steps[0].nodes[0].inputs.input_references[0].missing`),true);
});
test('location UI separates library kinds, creates typed snapshots and binds them beside characters',async()=>{
 const a=ui();a.run(`state={keys:{},flows:[],runs:[],dataCards:[{id:'kira',kind:'character',name:'Kira',assets:[]},{id:'house',kind:'location',name:'House',description:'Exterior and rooms',layout:'Kitchen beside courtyard',assets:[{id:'kitchen',name:'Kitchen',description:'Window on the right',type:'image',role:'reference',fileId:'room-file'}]}]};flow={id:'locations',name:'Same place',view:'flow',steps:[],groups:[]};`);
 const page=a.run("characters('location')");assert.match(page,/Create location/);assert.match(page,/House/);assert.doesNotMatch(page,/Kira/);
 await a.run(`characterAction('attachCharacter','kira',{})`);await a.run(`characterAction('attachCharacter','house',{})`);await assert.rejects(a.run(`characterAction('attachCharacter','house',{})`),/already/);
 a.run(`flow.steps=[{id:'edit',op:'POST /v1/images',action:'image-edit',params:{model:'google/nano-banana-2-edit',prompt:'The same woman in the saved kitchen'},media:{input_references:{mode:'list',items:[{mode:'character',dataCardId:'house',assetId:'kitchen'}]}}}];flow.groups=[{id:'prepare',name:'Prepare scene',nodeIds:['edit']}];`);
 const picker=a.run(`mediaPicker(flow.steps[0],0,'input_references#0',['Image','image'])`);assert.match(picker,/Location · House \/ Kitchen/);assert.match(picker,/Window on the right/);
 const graph=a.run('globalFlowHTML()');assert.match(graph,/>LOCATION</);assert.match(graph,/location-square/);assert.match(graph,/global-edge location/);
 a.run(`openCharacter(flow.dataCards[1],'workflow')`);const form=a.run('characterEditor(characterDraft)');assert.match(form,/Spatial layout/);assert.doesNotMatch(form,/data-character-field="age"/);assert.match(form,/ambient audio/);
 a.run(`characterDraft.layout='Updated courtyard layout'`);await a.run(`characterAction('saveCharacter','',{})`);assert.equal(a.run('flow.dataCards[1].layout'),'Updated courtyard layout');assert.equal(a.run('state.dataCards[1].layout'),'Kitchen beside courtyard');
 await a.run(`characterAction('newWorkflowLocation','',{})`);assert.equal(a.run('characterDraft.kind'),'location');assert.equal(a.run('dataCardAssetRole(characterDraft.kind,"audio")'),'ambience');
 await a.run(`characterAction('confirmRemoveWorkflowCharacter','house',{})`);assert.equal(a.run(`editorToWorkflow(flow).steps[0].nodes[0].inputs.input_references[0].missing`),true);
});
test('draft roundtrip preserves settings, media, IDs, links and incomplete advanced JSON',()=>{
 const a=ui();
 a.run(`flow={name:'Черновик',steps:[{op:speechOp,params:{input:'Текст',model:'tts-1'}},{op:videoOp,wait:true,params:{model:'lightricks/ltx-2.5-fast',duration_secs:5},media:{input_audio_url:{mode:'previous',ref:'{{1.file}}'},start_image_url:{mode:'file',file:'asset-test',name:'frame.png',width:640,height:480}}}]};saveDraft()`);
 const expected=plain(a.run('flow'));
 const b=ui(a.storage);assert.equal(b.run('restoreDraft()'),true);assert.deepEqual(plain(b.run('flow')),expected);
 b.run('page="api";editIndex=1;selected=videoOp;params=copy(flow.steps[1].params);editingJSON=true');b.element('#raw').value='{"prompt":';b.run('saveDraft()');
 const c=ui(a.storage);c.run('restoreDraft();restoreEditor()');assert.equal(c.element('#raw').value,'{"prompt":');assert.deepEqual(plain(c.run('flow')),expected);
});
test('stable IDs and mapping survive legacy load, move, API editing and automatic uploads',async()=>{
 const a=ui();a.run(`flow.steps=[{op:speechOp,params:{input:'Hello',model:'tts-1'}},{op:videoOp,params:{model:'lightricks/ltx-2.5-fast',prompt:'Scene'},media:{input_audio_url:{mode:'previous',ref:'{{1.file}}'}}},{op:uploadOp,params:{file:'local-test'}}];ensureStepIds(flow.steps)`);
 const ids=plain(a.run('flow.steps.map(s=>s.id)'));
 a.run('moveStep(2,0)');assert.deepEqual(plain(a.run('flow.steps.map(s=>s.id)')),[ids[2],ids[0],ids[1]]);
 assert.equal(a.run('flow.steps[2].media.input_audio_url.ref'),'{{2.file}}');
 assert.throws(()=>a.run('moveStep(2,0)'),/зависимость/);
 await assert.rejects(a.run(`act('stepdel',{dataset:{i:'1'}})`),/ссылки/);
 const plan=plain(a.run('compileWorkflow(flow.steps)'));
 assert.deepEqual(plan.map(s=>s.sourceStepId),[ids[2],ids[0],ids[1],ids[1]]);
 assert.equal(plan[2].params.file,'{{2.file}}');assert.equal(plan[3].params.input_audio_url,'{{3.url}}');
 a.run('page="api";editIndex=2;selected=videoOp;params={prompt:"Edited"};editingJSON=true');
 a.element('#raw').value='{"prompt":"Edited"}';a.run('saveDraft()');
 assert.equal(a.run('flow.steps[2].id'),ids[1]);assert.equal(a.run('flow.steps[2].media.input_audio_url.ref'),'{{2.file}}');
});
test('snapshots are independent; history opens a new draft without API execution',async()=>{
 const workflow={id:'saved-flow',name:'Original',steps:[{id:'user-step',op:'POST /v1/audio/speech',params:{input:'Original'}}]};
 const steps=[{id:'request-id',sourceStepId:'user-step',op:'POST /v1/audio/speech',params:{input:'Original'}}];
 const run=freshRun('Run',steps,workflow);workflow.steps[0].params.input='Changed';steps[0].params.input='Changed';
 assert.equal(run.config.workflow.steps[0].params.input,'Original');assert.equal(run.config.steps[0].params.input,'Original');
 const a=ui();a.context.record=run;a.run('api=async p=>{if(p!=="run/test")throw Error("Unexpected request");return record};runId="test"');
 await a.run('act("restoreRun",{dataset:{}})');assert.equal(a.run('flow.id'),undefined);assert.equal(a.run('flow.steps[0].id'),'user-step');
 a.run('flow.steps[0].params.input="New draft"');assert.equal(run.config.workflow.steps[0].params.input,'Original');
 a.context.record={id:'test',name:'Legacy',created:new Date().toISOString(),status:'completed',steps:[],cost:null};
 a.run('page="runs";refresh=async()=>{}');await a.run('detail("test")');assert.match(a.element('#view').innerHTML,/Старая запись/);assert.doesNotMatch(a.element('#view').innerHTML,/data-a="restoreRun"/);
});
test('storage failures are visible and unreadable data is retained',()=>{
 const a=ui(new Map([['videorouter.workflow-draft.v1','broken-json']]));
 assert.equal(a.run('restoreDraft()'),false);a.run('saveDraft()');assert.equal(a.storage.get('videorouter.workflow-draft.v1.unreadable'),'broken-json');
 a.run('localStorage.setItem=()=>{throw Error("Quota")};saveDraft()');assert.match(a.element('#draftStatus').textContent,/Не удалось/);
});
test('server persists resolved request and original workflow across restart, using offline transport',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'videorouter-persistence-'));
 let child;
 try{
  for(const f of ['server.mjs','engine.mjs','artifacts.mjs','graph-engine.mjs','webhooks.mjs','library.mjs','grok-cli.mjs','public'])cpSync(path.join(root,f),path.join(dir,f),{recursive:true});
  writeFileSync(path.join(dir,'fixture.mjs'),`globalThis.fetch=async(url,init)=>{
   const p=JSON.parse(init.body||'{}');
   if(String(url).endsWith('/v1/images'))return Response.json({data:[{url:'https://fixture.invalid/frame.png'}]});
   if(String(url).endsWith('/v1/videos')&&p.start_image_url==='https://fixture.invalid/frame.png')return Response.json({id:'fixture-job',status:'completed',data:[{url:'https://fixture.invalid/movie.mp4'}]});
   throw Error('Unexpected external request blocked');
  };`);
  const port=18793;
  async function start(){
   child=spawn(process.execPath,['--import',path.join(dir,'fixture.mjs'),path.join(dir,'server.mjs')],{env:{...process.env,PORT:String(port),VIDEOROUTER_API_KEY:'fixture-key',VIDEOROUTER_MANAGEMENT_KEY:''},stdio:['ignore','pipe','pipe']});
   let errors='';child.stderr.on('data',chunk=>errors+=chunk);
   await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Fixture server stopped: '+errors)})]);
  }
  const local=async(p,body)=>{
   const response=await fetch('http://127.0.0.1:'+port+'/local/'+p,{method:body===undefined?'GET':'POST',headers:{'X-Studio':'1','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
   const result=await response.json();assert.equal(response.ok,true,JSON.stringify(result));return result;
  };
  await start();
  const steps=[{id:'image-request',sourceStepId:'image-step',op:'POST /v1/images',params:{model:'fixture',prompt:'Frame'}},{id:'video-request',sourceStepId:'video-step',op:'POST /v1/videos',wait:true,params:{model:'fixture',start_image_url:'{{1.data.0.url}}'}}];
  const workflow={name:'Fixture',steps:structuredClone(steps)};
  const ticket=await local('prepare',{name:'Fixture',steps,workflow});const initial=await local('run',ticket);
  let run;
  for(let i=0;i<30;i++){run=await local('run/'+initial.id);if(run.status!=='running')break;await new Promise(r=>setTimeout(r,20))}
  assert.equal(run.status,'completed');assert.deepEqual(run.config.workflow,workflow);
  assert.equal(run.config.steps[1].params.start_image_url,'{{1.data.0.url}}');assert.equal(run.steps[1].request.params.start_image_url,'https://fixture.invalid/frame.png');assert.equal(run.steps[1].sourceStepId,'video-step');
  child.kill();await once(child,'exit');child=null;await start();
  assert.deepEqual(await local('run/'+initial.id),run);
 }finally{if(child&&child.exitCode===null){const stopped=once(child,'exit');child.kill();await stopped}rmSync(dir,{recursive:true,force:true})}
});

test('step IDs work on HTTP phone origins without randomUUID',()=>{
 const a=ui();a.context.crypto={getRandomValues:array=>crypto.getRandomValues(array)};
 const ids=a.run('Array.from({length:20},()=>newStepId())');
 assert.equal(new Set(ids).size,20);assert.ok(ids.every(id=>/^[a-f0-9]{32}$/.test(id)));
});

// Workflow source is evaluated with a small DOM stub; transport integration uses the real server.
test('quote and submission share duration, audio URL, routing and advanced fields',()=>{
 const a=ui();a.run(`flow.steps=[{id:'v',op:videoOp,advanced:true,params:{model:'lightricks/ltx-2.5-fast',duration_secs:5,prompt:'Scene',width:720,height:1280,n:1,provider:{only:['lightricks']},failover:{on_timeout_sec:120}},media:{input_audio_url:{mode:'url',url:'https://fixture.invalid/audio.wav'}}}]`);
 const quote=plain(a.run('stepQuoteParams(flow.steps[0],{audio:8})'));
 const actual=plain(a.run('compileWorkflow(flow.steps)[0].params'));
 assert.equal(quote.duration_secs,5);assert.equal(actual.duration_secs,5);
 const {endpoint,...priced}=quote;assert.equal(endpoint,'/v1/videos');assert.deepEqual(priced,actual);
 a.run('flow.steps[0].quote={key:quoteKey(flow.steps[0]),response:{estimated_cost_usd:1}};flow.steps[0].params.duration_secs=8');
 assert.equal(a.run('flow.steps[0].quote.key===quoteKey(flow.steps[0])'),false);
});
test('image binding: explicit choice, reload, ordering, deletion, compatibility and partial quote',async()=>{
 const a=ui();a.run(`flow.steps=[{id:'image-a',op:imageOp,params:{model:'gpt-image-1',prompt:'Frame',n:2}}]`);
 await a.run(`act('imageToVideo',{dataset:{i:'0',output:'1'}})`);a.run(`flow.steps[1].params.prompt='Animate'`);
 const plan=plain(a.run('compileWorkflow(flow.steps)'));
 assert.deepEqual(plan[1].params.start_image_url,{$artifact:{stepId:'image-a',port:'images',index:1,type:'image'}});
 assert.equal(plan[1].params.input_audio_url,undefined);
 assert.equal(a.run('stepQuoteParams(flow.steps[1]).start_image_url'),undefined);assert.equal(a.run('stepQuoteParams(flow.steps[1]).duration_secs'),5);
 a.run('saveDraft()');const b=ui(a.storage);b.run('restoreDraft()');assert.deepEqual(plain(b.run('flow')),plain(a.run('flow')));
 assert.throws(()=>a.run('moveStep(1,0)'),/предыдущий/);
 await assert.rejects(a.run(`act('stepdel',{dataset:{i:'0'}})`),/ссылки/);
 a.run('flow.steps[1].params.model="unknown"');assert.throws(()=>a.run('compileWorkflow(flow.steps)'),/не подтверждена/);
 assert.equal(a.run('flow.steps[1].media.start_image_url.stepId'),'image-a');
 a.run('flow.steps[1].params.model="lightricks/ltx-2.5-fast";flow.steps[0].params.n=1');assert.throws(()=>a.run('compileWorkflow(flow.steps)'),/номер/);
 a.run('flow.steps[0].op=speechOp');assert.throws(()=>a.run('compileWorkflow(flow.steps)'),/Несовместимые/);
});

test('image actions compile nested typed inputs; insertion and reload preserve selected outputs',async()=>{
 const a=ui();a.run(`flow.steps=[{id:'source',op:imageOp,params:{model:'gpt-image-1',prompt:'Frame',n:2}},{id:'speech',op:speechOp,params:{model:'tts-1',input:'Hi'}},{id:'upload',op:uploadOp,params:{file:'{{2.file}}'}}]`);
 await a.run(`act('imageNext',{dataset:{i:'0',output:'1',mode:'image-edit'}})`);
 a.run(`flow.steps[1].params.prompt='Blue sky'`);
 assert.equal(a.run('flow.steps[3].params.file'),'{{3.file}}');
 await a.run(`act('imageNext',{dataset:{i:'1',output:'0',mode:'image-upscale'}})`);
 await a.run(`act('imageToVideo',{dataset:{i:'2',output:'0'}})`);
 a.run(`flow.steps[3].params.prompt='Animate'`);
 const steps=plain(a.run('compileWorkflow(flow.steps)'));
 assert.equal(steps[1].contractMode,'image-edit');assert.equal(steps[2].contractMode,'image-upscale');
 assert.deepEqual(steps[1].params.input_references[0].image_url.url,{$artifact:{stepId:'source',port:'images',index:1,type:'image'}});
 assert.equal(steps[2].params.input_references[0].image_url.url.$artifact.stepId,a.run('flow.steps[1].id'));
 assert.equal(steps[2].params.prompt,undefined);assert.equal(steps[3].params.start_image_url.$artifact.stepId,a.run('flow.steps[2].id'));
 assert.throws(()=>a.run('moveStep(2,0)'),/предыдущий/);
 a.run('saveDraft()');const b=ui(a.storage);b.run('restoreDraft()');assert.deepEqual(plain(b.run('flow')),plain(a.run('flow')));
});
test('model changes keep user settings and bindings while reporting incompatibility',async()=>{
 const a=ui();a.run(`flow.steps=[{id:'v',op:videoOp,params:{model:'lightricks/ltx-2.5-fast',prompt:'Scene',resolution:'2160p'},media:{input_audio_url:{mode:'url',url:'https://fixture.invalid/a.wav'}}}]`);
 await a.run(`act('selectVideoModel',{dataset:{i:'0',id:'lightricks/ltx-2.5-pro'}})`);
 assert.equal(a.run('flow.steps[0].params.resolution'),'2160p');assert.equal(a.run('flow.steps[0].media.input_audio_url.url'),'https://fixture.invalid/a.wav');
 assert.throws(()=>a.run('compileWorkflow(flow.steps)'),/resolution/);
 assert.deepEqual(plain(a.run('resolutionChoices(flow.steps[0])')),['720p','1080p']);
});

test('changing operation in advanced editor discards the old action contract',()=>{
 const a=ui();
 const result=plain(a.run(`mergeEditorStep({id:'a',op:imageOp,action:'image-edit',media:{reference_image:{mode:'url',url:'https://fixture.invalid/a.png'}},params:{}},{op:speechOp,params:{model:'tts-1',input:'Hi'}})`));
 assert.equal(result.action,undefined);assert.equal(result.media,undefined);assert.equal(result.advanced,true);assert.equal(result.id,'a');
});


test('standalone image price uses explicit format and quality without requiring prompt or other steps',()=>{
 const a=ui();a.run(`flow.steps=[{id:'broken',op:videoOp,params:{model:'unknown'}},{id:'image',op:imageOp,params:{model:'gpt-image-1',prompt:'',n:1}},{id:'later',op:videoOp,params:{}}];waitingFiles.add({})`);
 const p=plain(a.run('stepQuoteParams(flow.steps[1])'));
 assert.deepEqual(p,{model:'gpt-image-1',n:1,size:'1024x1024',quality:'medium',endpoint:'/v1/images'});
 a.run(`flow.steps=[flow.steps[1]];waitingFiles.clear();flow.steps[0].params.prompt='Frame';flow.steps[0].params.size='1024x1536'`);
 const {endpoint,...priced}=plain(a.run('stepQuoteParams(flow.steps[0])'));
 assert.deepEqual(priced,plain(a.run('compileWorkflow(flow.steps)[0].params')));
});
test('partial video quote skips pending media and leaves generation validation strict',()=>{
 const a=ui();a.run(`flow.steps=[{id:'v',op:videoOp,params:{model:'lightricks/ltx-2.5-fast',prompt:'',duration_secs:5,resolution:'720p'},media:{start_image_url:{mode:'previous',stepId:'not-ready',port:'images',index:0},input_audio_url:{mode:'file'}}}]`);
 const p=plain(a.run('stepQuoteParams(flow.steps[0],{audio:8})'));
 assert.equal(p.duration_secs,5);assert.equal(p.start_image_url,undefined);assert.equal(p.input_audio_url,undefined);
 assert.deepEqual(plain(a.run('previewEstimate(flow.steps[0]).omitted')),['prompt','start_image_url','input_audio_url']);
 assert.throws(()=>a.run('compileWorkflow(flow.steps)'),/предыдущий/);
});
test('image and video pickers expose catalog alternatives and image format controls',()=>{
 const a=ui();
 const image=String(a.run(`friendlyField({op:imageOp,params:{model:'gpt-image-1'}},0,'model')`));
 assert.ok((image.match(/<option/g)||[]).length>10);assert.match(image,/dall-e-3/);
 const video=String(a.run(`flow.steps=[{op:videoOp,params:{model:'lightricks/ltx-2.5-fast'}}];videoModelResults('',0,flow.steps[0].params.model)`));
 assert.ok((video.match(/data-a=/g)||[]).length>10);assert.match(video,/kling|veo|seedance/);
 const format=String(a.run(`friendlyField({op:imageOp,params:{model:'gpt-image-1'}},0,'size')`));
 assert.match(format,/1024x1536/);assert.match(format,/1536x1024/);
});

test('empty optional audio picker does not restrict video model list to LTX',()=>{
 const a=ui();a.run(`flow.steps=[{op:videoOp,params:{model:'lightricks/ltx-2.5-fast'},media:{input_audio_url:{mode:'file'}}}]`);
 assert.equal(a.run('modeOf(flow.steps[0])'),'text-to-video');
 assert.match(String(a.run(`videoModelResults('seedance',0,flow.steps[0].params.model)`)),/seedance/);
 a.run(`flow.steps[0].media.input_audio_url={mode:'url',url:'https://fixture.invalid/audio.wav'}`);
 assert.equal(a.run('modeOf(flow.steps[0])'),'audio-to-video');
 assert.doesNotMatch(String(a.run(`videoModelResults('',0,flow.steps[0].params.model)`)),/seedance/);
});

test('library UI previews JSON before importing, then opens a new saved copy without generation',async()=>{
 const a=ui();a.run(`state={keys:{api:false},flows:[],runs:[]};flow={id:'old',name:'Current draft',steps:[]};calls=[];
 api=async(p,b)=>{calls.push(p);if(p==='workflow/import')return {workflow:{...JSON.parse(b.text),id:'new-copy'}};if(p==='state')return state;throw Error('Unexpected API '+p)};showWorkflow=()=>{};`);
 a.run(`previewWorkflowImport(JSON.stringify({name:'Imported',steps:[{id:'image',op:imageOp,params:{model:'gpt-image-1',prompt:'Frame'}}]}))`);
 assert.deepEqual(plain(a.run('calls')),[]);assert.equal(a.run('flow.id'),'old');assert.match(a.element('#dialogBody').innerHTML,/Импортировать копию/);
 await a.run(`act('confirmWorkflowImport',{dataset:{}})`);
 assert.equal(a.run('flow.id'),'new-copy');assert.equal(a.run('flow.name'),'Imported');assert.equal(a.run('flow.activeRunId'),undefined);
 assert.deepEqual(plain(a.run('calls')),['workflow/import','state']);
});

test('history deletion UI reviews effects and only deletes after explicit confirmation',async()=>{
 const a=ui();a.run(`state={keys:{api:false},flows:[],runs:[]};flow={name:'Draft',steps:[],activeRunId:'delete-me',resume:{id:'delete-me'}};page='runs';calls=[];
 api=async(p,b)=>{calls.push(p);if(p==='library/delete-preview')return {ticket:'reviewed',kind:'run',ids:['delete-me'],names:['Paused run'],paused:1,pinnedWorkflows:1};if(p==='library/delete'){if(b.ticket!=='reviewed')throw Error('Missing confirmation');return {kind:'run',deleted:['delete-me']}};if(p==='state')return state;throw Error(p)};`);
 await a.run(`act('deleteRun',{dataset:{id:'delete-me'}})`);assert.deepEqual(plain(a.run('calls')),['library/delete-preview']);
 assert.match(a.element('#dialogBody').innerHTML,/продолжить этот запуск/);assert.match(a.element('#dialogBody').innerHTML,/закреплёнными outputs/);
 await a.run(`act('confirmLibraryDelete',{dataset:{}})`);assert.deepEqual(plain(a.run('calls')),['library/delete-preview','library/delete','state']);
 assert.equal(a.run('flow.activeRunId'),undefined);assert.equal(a.run('flow.resume'),undefined);
});

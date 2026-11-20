import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,cpSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {DataCard,CharacterCard,LocationCard,dataCardFactory,normalizeDataCards,resolveCharacterAsset,resolveCharacterMedia,removeCharacter} from '../public/data-cards.mjs';
import {editorToWorkflow,workflowToEditor,compileGraph,moveGraphStep,layoutWorkflow} from '../public/graph.mjs';
import {portableWorkflow,parseWorkflowJSON} from '../public/workflow-json.mjs';
import {executionPreview,selectReusable} from '../public/workflow-state.mjs';
import {graphRun,createGraphRunner,validateGraphRequests,reviseRun,workflowForStep} from '../graph-engine.mjs';
import {validateWorkflowContract} from '../contracts/workflow/validate.mjs';
import {createLibrary} from '../library.mjs';

const root=new URL('../',import.meta.url),catalog=JSON.parse(readFileSync(new URL('public/catalog.json',root))),routes=new Map(catalog.routes.map(r=>[r.id,r]));
const files=new Map(['front','side','other','room','exterior','voice','base'].map(id=>[id,{id,name:id,type:id==='voice'?'audio/wav':id==='base'?'video/mp4':'image/png',bytes:Buffer.from('fixture-'+id)}]));
const readAsset=id=>{const file=files.get(id);if(!file)throw Error('Missing file '+id);return file};
const ref=(dataCardId,assetId)=>({dataCardId,assetId});
function characters(){return normalizeDataCards([
 {id:'kira',kind:'character',name:'Kira',age:'Adult',appearance:'Brown hair',description:'Lead character',assets:['front','side','voice','base'].map(id=>({id,name:id,description:'Kira '+id,type:id==='voice'?'audio':id==='base'?'video':'image',role:id==='voice'?'voice':id==='base'?'base-video':'reference',fileId:id}))},
 {id:'alex',kind:'character',name:'Alex',description:'Second character',assets:[{id:'front',name:'Alex portrait',description:'Front portrait',type:'image',role:'reference',fileId:'other'}]}
])}
function workflow(){return {version:2,id:'characters-flow',name:'Two characters',view:'flow',dataCards:characters(),steps:[
 {id:'first',name:'Prepare',enabled:true,continueOnSuccess:true,view:'cards',nodes:[{id:'edit',kind:'image',operationId:'image-edit',op:'POST /v1/images',model:'google/nano-banana-2-edit',parameters:{prompt:'The same characters, standing together in a garden.',n:1},inputs:{input_references:[ref('kira','front'),ref('alex','front')]}}],edges:[]},
 {id:'second',name:'Animate',enabled:true,continueOnSuccess:true,view:'flow',nodes:[{id:'video',kind:'video',operationId:'reference-to-video',op:'POST /v1/videos',model:'alibaba/wan-3.0-prime',parameters:{prompt:'In one continuous shot, the two characters walk through the garden.',duration_secs:5},inputs:{input_references:[ref('kira','front'),null,ref('alex','front'),ref('kira','side')]}}],edges:[{id:'generated-to-video',from:{stepId:'first',nodeId:'edit',port:'images',outputIndex:0},to:{nodeId:'video',port:'input_references',slot:1}}]}
]}}
function transport(){
 const calls=[];
 const runner=createGraphRunner({routes,readAsset,storeFile:()=>{throw Error('Unexpected file generation')},save:()=>{},pollDelay:0,call:async(route,params)=>{
  calls.push({path:route.path,params:structuredClone(params)});
  if(route.path==='/v1/pricing/estimate')return {data:{estimated_cost_usd:.02,assumptions:{}},cost:null};
  if(route.path==='/v1/images')return {data:{data:[{url:'https://fixture.invalid/edited.png'}]},cost:.02};
  if(route.path==='/v1/videos')return {data:{id:'fixture-video',status:'completed',data:[{url:'https://fixture.invalid/video.mp4'}]},cost:.1};
  if(route.path==='/v1/audio/transcriptions')return {data:{text:'Fixture transcript'},cost:.01};
  throw Error('Unexpected API '+route.path);
 }});
 return {runner,calls};
}

function location(){return normalizeDataCards([{id:'home',kind:'location',name:'Courtyard house',description:'One house with several rooms and an exterior.',appearance:'Pale stone walls and green shutters.',layout:'The kitchen opens onto the courtyard; the stairs are beside the entrance.',scenario:'Morning visit',assets:[
 {id:'outside',name:'Exterior',description:'View from the courtyard toward the entrance.',type:'image',role:'reference',fileId:'exterior'},
 {id:'kitchen',name:'Kitchen',description:'The doorway is on the left; a table faces the window.',type:'image',role:'reference',fileId:'room'},
 {id:'ambience',name:'Courtyard ambience',description:'Wind and distant birds.',type:'audio',role:'ambience',fileId:'voice'},
 {id:'walkthrough',name:'Walkthrough',description:'Entrance into courtyard.',type:'video',role:'base-video',fileId:'base'}
]}])[0]}
function locatedWorkflow(){const w=workflow();w.dataCards.push(location());w.steps[0].nodes[0].inputs.input_references.push(ref('home','kitchen'));w.steps[1].nodes[0].inputs.input_references[3]=ref('home','outside');return w}

test('LocationCard preserves place identity and validates subtype-specific fields and asset roles',()=>{
 const card=location();assert.ok(new LocationCard(card) instanceof DataCard);assert.ok(dataCardFactory(card) instanceof LocationCard);
 assert.equal(card.kind,'location');assert.match(card.layout,/courtyard/);assert.equal(Object.hasOwn(card,'age'),false);
 assert.equal(resolveCharacterAsset([card],ref('home','ambience'),'audio',{readAsset}).assetId,'voice');
 assert.throws(()=>normalizeDataCards([{...card,age:'22'}]),/age/);
 assert.throws(()=>normalizeDataCards([{...card,assets:[{...card.assets[2],role:'voice'}]}]),/role/);
 assert.throws(()=>normalizeDataCards([{...characters()[0],assets:[{...card.assets[2]}]}]),/role/);
 assert.throws(()=>normalizeDataCards([characters()[0],{...card,id:'kira'}]),/unique/);
});
test('character and location snapshots round-trip, reconnect and validate as distinct sources',()=>{
 const {id,...w}=locatedWorkflow(),text=JSON.stringify(w),context={version:1,cards:w.dataCards,files:[...files.values()].map(({id,type})=>({id,type}))};
 const imported=parseWorkflowJSON(JSON.stringify(portableWorkflow(w,{routes,assetLookup:id=>files.get(id)}).workflow),{routes,assetLookup:id=>files.get(id)}).workflow;
 assert.deepEqual(imported.dataCards,w.dataCards);assert.deepEqual(editorToWorkflow(workflowToEditor(w)).dataCards,w.dataCards);
 const result=validateWorkflowContract(text,{assetContext:context});assert.equal(result.contractVersion,3);assert.equal(result.importValid,true);assert.equal(result.executionPreflight.valid,true);
 const layout=layoutWorkflow(w,{wrapWidth:507});assert.equal(layout.positions.filter(p=>p.kind==='data').length,3);assert.equal(layout.edges.filter(e=>e.kind==='location').length,2);
 const unavailable={...context,files:context.files.filter(f=>f.id!=='room')};assert.equal(validateWorkflowContract(text,{assetContext:unavailable}).executionPreflight.valid,false);
 const removed=removeCharacter(w,'home');assert.equal(removed.steps[0].nodes[0].inputs.input_references[2].missing,true);assert.equal(removed.steps[1].nodes[0].inputs.input_references[3].missing,true);assert.equal(removed.dataCards.length,2);
 const draft=structuredClone(w);draft.dataCards[2].assets.push({id:'unused',name:'Attic',description:'Not attached yet',type:'image',role:'reference',missing:true});assert.equal(validateWorkflowContract(JSON.stringify(draft),{assetContext:context}).executionPreflight.valid,true);
});
test('mixed character/location run resolves ordered sources and keeps quote and execution identical',async()=>{
 const w=locatedWorkflow(),t=transport();validateGraphRequests(w,routes,{readAsset});
 const run=graphRun('Cast in a saved house',w);await t.runner.start(run);assert.equal(run.status,'completed',run.error);assert.equal(run.steps.length,2);
 const posts=t.calls.filter(c=>['/v1/images','/v1/videos'].includes(c.path));assert.equal(posts.length,2);
 const data=id=>'data:image/png;base64,'+files.get(id).bytes.toString('base64');
 assert.deepEqual(posts[0].params.input_references.map(r=>r.image_url.url),[data('front'),data('other'),data('room')]);
 assert.deepEqual(posts[1].params.input_references.map(r=>r.image_url.url),[data('front'),'https://fixture.invalid/edited.png',data('other'),data('exterior')]);
 for(const row of run.steps){const {endpoint,...quote}=row.estimate.request;assert.deepEqual(quote,row.request.params)}
 assert.equal(t.calls.some(c=>c.path==='/v1/uploads'),false);assert.ok(Math.abs(run.cost-.12)<1e-9);
 const before=JSON.stringify(resolveCharacterMedia(workflowToEditor(w).steps[0],w.dataCards));w.dataCards[2].assets[1].fileId='side';assert.notEqual(JSON.stringify(resolveCharacterMedia(workflowToEditor(w).steps[0],w.dataCards)),before);
});

test('DataCard is abstract; character identity and media typing are validated',()=>{
 assert.throws(()=>new DataCard({}),/abstract/);assert.ok(new CharacterCard(characters()[0]) instanceof DataCard);
 assert.throws(()=>normalizeDataCards([characters()[0],characters()[0]]),/unique/);
 const duplicate=characters();duplicate[0].assets.push(duplicate[0].assets[0]);assert.throws(()=>normalizeDataCards(duplicate),/unique/);
 const wrong=workflow();wrong.steps[0].nodes[0].inputs.input_references=[ref('kira','voice')];assert.throws(()=>compileGraph(wrong),/type/);
 const dangling=workflow();dangling.steps[0].nodes[0].inputs.input_references=[ref('absent','front')];assert.throws(()=>compileGraph(dangling),/not found/);
 assert.equal(resolveCharacterAsset(characters(),ref('kira','voice'),'audio',{readAsset}).assetId,'voice');
 assert.throws(()=>resolveCharacterAsset(characters(),ref('kira','front'),'image',{readAsset:()=>({type:'video/mp4'})}),/incompatible/);
});
test('editor, Step operations and global layout preserve workflow-level data and exact bindings',()=>{
 const w=workflow(),round=editorToWorkflow(workflowToEditor(w));assert.deepEqual(round.dataCards,w.dataCards);assert.equal(round.view,'flow');
 assert.deepEqual(JSON.parse(JSON.stringify(round.steps.map(s=>s.nodes.map(n=>n.inputs)))),w.steps.map(s=>s.nodes.map(n=>n.inputs)));
 const independent=structuredClone(w);independent.steps[1].edges=[];independent.steps[1].nodes[0].inputs.input_references.splice(1,1);
 assert.deepEqual(moveGraphStep(workflowToEditor(independent),'first',1).dataCards,w.dataCards);
 const layout=layoutWorkflow(w);assert.equal(layout.positions.length,4);assert.equal(layout.groups.length,2);
 assert.equal(layout.edges.filter(e=>e.kind==='character').length,5);assert.ok(layout.edges.some(e=>e.from==='edit'&&e.to==='video'));
 assert.ok(layout.groups[1].x>layout.groups[0].x+layout.groups[0].width);
 const only={version:2,name:'Draft',dataCards:characters(),steps:[]};assert.equal(compileGraph(only,{allowEmpty:true}).stages.length,0);
});
test('vertical mobile DAG keeps ports, routes and labels clear across branches and long dependencies',()=>{
 const w=workflow();
 for(let i=0;i<8;i++){
  const previous=w.steps[0].nodes.at(-1).id,id='edit-'+i;
  w.steps[0].nodes.push({...structuredClone(w.steps[0].nodes[0]),id,inputs:{}});
  w.steps[0].edges.push({id:'chain-'+i,from:{stepId:'first',nodeId:previous,port:'images',outputIndex:0},to:{nodeId:id,port:'input_references',slot:0}});
 }
 for(let i=0;i<3;i++)w.steps[0].nodes.push({...structuredClone(w.steps[0].nodes[0]),id:'parallel-'+i});
 const before=structuredClone(w),desktop=layoutWorkflow(w);
 for(const phoneWidth of [320,393,430,760]){
  const width=Math.floor((phoneWidth-38)/.7),layout=layoutWorkflow(w,{wrapWidth:width});
  assert.ok(layout.width>=width);assert.equal(layout.direction,'down');assert.deepEqual(layout.edges,desktop.edges);
  assert.equal(layout.positions.length,desktop.positions.length);assert.equal(layout.routes.length,layout.edges.length);
  const obstacles=layout.positions.map(p=>({x:p.x,y:p.y,width:176,height:176}));
  for(const g of layout.groups)obstacles.push({x:g.x+14,y:g.y+14,width:112,height:g.height-28});
  for(const p of layout.positions){
   assert.ok(p.x>=0&&p.y>=0&&p.x+176<=layout.width&&p.y+176<=layout.height,'Every card fits the canvas');
   if(p.kind==='api'){const g=layout.groups.find(g=>g.id===p.stepId);assert.ok(p.x>=g.x+140&&p.x+176<=g.x+g.width&&p.y>=g.y&&p.y+176<=g.y+g.height,'Cards leave room for the Step label');}
   for(const q of layout.positions.filter(q=>q!==p))assert.ok(p.x+176<=q.x||q.x+176<=p.x||p.y+176<=q.y||q.y+176<=p.y,'Cards do not overlap');
  }
  layout.edges.forEach((e,index)=>{
   const a=layout.positions.find(p=>p.id===e.from&&p.kind===(e.fromKind==='data'?'data':'api')),b=layout.positions.find(p=>p.id===e.to&&p.kind==='api'),route=layout.routes[index];
   assert.ok(b.y>a.y,'Every dependency points down');
   assert.equal(route.start.y,a.y+179);assert.equal(route.end.y,b.y-3);
   for(let i=1;i<route.points.length;i++){
    const a=route.points[i-1],b=route.points[i];assert.ok(b.y>=a.y,'Routes never double back');
    assert.ok(a.x===b.x||a.y===b.y,'Routes are orthogonal');
    assert.ok(b.x>=0&&b.x<=layout.width&&b.y<=layout.height);
    for(const o of obstacles){
     const hit=a.x===b.x?a.x>o.x&&a.x<o.x+o.width&&Math.max(a.y,b.y)>o.y&&Math.min(a.y,b.y)<o.y+o.height:a.y>o.y&&a.y<o.y+o.height&&Math.max(a.x,b.x)>o.x&&Math.min(a.x,b.x)<o.x+o.width;
     assert.equal(hit,false,'Edges avoid cards and Step labels');
    }
   }
  });
  for(const g of layout.groups)assert.ok(g.x+g.width<=layout.width&&g.y+g.height<=layout.height);
  assert.ok(layout.groups[1].y>=layout.groups[0].y+layout.groups[0].height,'Step frames remain ordered');
 }
 assert.deepEqual(w,before);
 const simple=layoutWorkflow({...workflow(),dataCards:[],steps:[]},{wrapWidth:507});assert.ok(Number.isFinite(simple.height));
});
test('removing a character or asset preserves slot order and requires explicit reattachment',()=>{
 const w=workflow(),removed=removeCharacter(w,'kira','front');
 assert.equal(removed.steps[1].nodes[0].inputs.input_references[0].missing,true);
 assert.equal(removed.steps[1].nodes[0].inputs.input_references[1],null);
 assert.deepEqual(removed.steps[1].nodes[0].inputs.input_references[2],ref('alex','front'));
 assert.throws(()=>validateGraphRequests(removed,routes),/источник/);
 assert.equal(w.dataCards[0].assets.length,4);
 assert.deepEqual(removeCharacter(w,'kira').dataCards.map(c=>c.id),['alex']);
});
test('portable JSON reconnects known character files only, while ordinary local inputs still need reattachment',()=>{
 const w=workflow();w.steps[1].nodes[0].inputs.input_references.push({assetId:'other',name:'ordinary.png'});
 const exported=portableWorkflow(w,{routes,assetLookup:id=>files.get(id)});
 assert.equal(exported.workflow.dataCards[0].assets[0].fileId,'front');
 assert.equal(exported.workflow.steps[1].nodes[0].inputs.input_references.at(-1).missing,true);
 const imported=parseWorkflowJSON(JSON.stringify(exported.workflow),{routes,assetLookup:id=>files.get(id)});
 assert.equal(imported.workflow.dataCards[0].assets[0].missing,undefined);
 const away=parseWorkflowJSON(JSON.stringify(workflow()),{routes,assetLookup:()=>null});
 assert.equal(away.workflow.dataCards[0].assets[0].missing,true);assert.match(away.warnings[0],/Reattach/);
 assert.throws(()=>validateGraphRequests(away.workflow,routes),/Reattach/);
 const restored=parseWorkflowJSON(JSON.stringify(away.workflow),{routes,assetLookup:id=>files.get(id)});assert.equal(restored.workflow.dataCards[0].assets[0].missing,undefined);
 assert.throws(()=>parseWorkflowJSON(JSON.stringify(workflow()),{routes,assetLookup:()=>({type:'audio/wav'})}),/incompatible/);
});
test('contract reports structural validity separately from supplied local asset availability',()=>{
 const {id,...w}=workflow(),text=JSON.stringify(w),assetContext={version:1,cards:characters(),files:[...files.values()].map(({id,type})=>({id,type}))};
 assert.equal(validateWorkflowContract(text).executionPreflight.valid,false);
 assert.equal(validateWorkflowContract(text,{assetContext}).executionPreflight.valid,true);
 assert.equal(validateWorkflowContract(text,{assetContext:{files:[]}}).executionPreflight.valid,false);
 const wrong=structuredClone(w);wrong.dataCards.push(wrong.dataCards[0]);assert.throws(()=>validateWorkflowContract(JSON.stringify(wrong)),/unique/);
});
test('two-character run sends exact ordered references and prices the same resolved request',async()=>{
 const w=workflow(),t=transport();validateGraphRequests(w,routes,{readAsset});
 const run=graphRun('Characters',w);assert.equal(run.steps.length,2);await t.runner.start(run);assert.equal(run.status,'completed',run.error);
 const posts=t.calls.filter(c=>['/v1/images','/v1/videos'].includes(c.path));assert.equal(posts.length,2);
 const refs=posts[1].params.input_references.map(r=>r.image_url.url);
 assert.deepEqual(refs,['data:image/png;base64,'+files.get('front').bytes.toString('base64'),'https://fixture.invalid/edited.png','data:image/png;base64,'+files.get('other').bytes.toString('base64'),'data:image/png;base64,'+files.get('side').bytes.toString('base64')]);
 assert.equal(t.calls.some(c=>c.path==='/v1/uploads'),false);
 for(const row of run.steps){const {endpoint,...quote}=row.estimate.request;assert.deepEqual(quote,row.request.params)}
 assert.ok(Math.abs(run.cost-.12)<1e-9);
});
test('pause edits and standalone Step execution use updated snapshots without rerunning completed nodes',async()=>{
 const w=workflow();w.steps[0].continueOnSuccess=false;const t=transport(),run=graphRun('Pause',w);await t.runner.start(run);assert.equal(run.status,'paused');
 const changed=structuredClone(w);changed.dataCards[0].assets[0].fileId='side';
 const editor=workflowToEditor(w),before=JSON.stringify(resolveCharacterMedia(editor.steps[0],w.dataCards));
 assert.notEqual(before,JSON.stringify(resolveCharacterMedia(editor.steps[0],changed.dataCards)));
 const completed=selectReusable(changed,[run],readAsset);reviseRun(run,changed,completed);await t.runner.start(run);assert.equal(run.status,'completed',run.error);
 assert.equal(t.calls.filter(c=>c.path==='/v1/images').length,1);
 assert.equal(t.calls.find(c=>c.path==='/v1/videos').params.input_references[0].image_url.url,'data:image/png;base64,'+files.get('side').bytes.toString('base64'));
 const partial=workflowForStep(changed,'second');assert.deepEqual(partial.dataCards,changed.dataCards);
 const reused=selectReusable(partial,[run],readAsset),preview=executionPreview(partial,compileGraph(partial),reused);assert.deepEqual(preview.map(r=>r.status),['reused','waiting']);
 const child=graphRun('Only video',partial,reused);await t.runner.start(child);assert.equal(child.status,'completed');assert.equal(t.calls.filter(c=>c.path==='/v1/images').length,1);
});
test('audio samples and base videos bind through their existing typed operations',async()=>{
 const w=workflow();w.steps=[{id:'media',name:'Media',enabled:true,continueOnSuccess:true,view:'cards',edges:[],nodes:[
  {id:'transcribe',kind:'text',operationId:'transcription',op:'POST /v1/audio/transcriptions',model:'whisper-1',parameters:{},inputs:{file:[ref('kira','voice')]}},
  {id:'animate',kind:'video',operationId:'reference-to-video',op:'POST /v1/videos',model:'alibaba/wan-3.0-prime',parameters:{prompt:'Continue the scene',duration_secs:5},inputs:{input_video_references:[ref('kira','base')],input_audio_references:[ref('kira','voice')]}}
 ]}];
 const t=transport(),run=graphRun('Media',w);validateGraphRequests(w,routes,{readAsset});await t.runner.start(run);assert.equal(run.status,'completed',run.error);
 assert.equal(t.calls.find(c=>c.path==='/v1/audio/transcriptions').params.file,'voice');
 assert.match(t.calls.find(c=>c.path==='/v1/videos').params.input_video_references[0].video_url.url,/^data:video\/mp4/);
});
test('unused missing assets do not block; referenced missing assets fail before execution',()=>{
 const w=workflow();w.dataCards[0].assets.find(a=>a.id==='voice').fileId='absent';assert.doesNotThrow(()=>validateGraphRequests(w,routes,{readAsset}));
 w.dataCards[0].assets[0].fileId='absent';assert.throws(()=>validateGraphRequests(w,routes,{readAsset}),/Missing file/);
 w.steps.forEach(s=>s.enabled=false);assert.doesNotThrow(()=>validateGraphRequests(w,routes,{readAsset}));
});
test('library snapshots and scenario copies remain independent after edit and deletion',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE records(kind TEXT,id TEXT,body TEXT,PRIMARY KEY(kind,id))');
 const all=kind=>db.prepare('SELECT body FROM records WHERE kind=?').all(kind).map(r=>JSON.parse(r.body));
 const get=(kind,id)=>{const row=db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind,id);return row?JSON.parse(row.body):null};
 const save=(kind,item)=>db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)').run(kind,item.id,JSON.stringify(item));
 try{
  const library=createLibrary({db,all,get,save,routes,assetLookup:id=>files.get(id)}),original=library.saveDataCard(characters()[0]),snapshot=structuredClone(original),variant=library.duplicateDataCard(original.id);
  assert.notEqual(variant.id,original.id);assert.equal(variant.assets[0].fileId,original.assets[0].fileId);
  library.saveDataCard({...original,appearance:'Changed library appearance'});assert.equal(snapshot.appearance,'Brown hair');assert.equal(variant.appearance,'Brown hair');
  const saved=library.importJSON(JSON.stringify({...workflow(),dataCards:[snapshot,characters()[1]]}));assert.equal(saved.workflow.dataCards[0].appearance,'Brown hair');
  library.deleteItems(library.deletion({kind:'data-card',id:original.id}));assert.equal(library.dataCards().length,1);assert.equal(get('flow',saved.workflow.id).dataCards[0].name,'Kira');assert.ok(files.has('front'));
  assert.equal(library.dataCardContext().files.length,4);
  const place=library.saveDataCard(location()),placeCopy=library.duplicateDataCard(place.id);assert.equal(placeCopy.kind,'location');assert.notEqual(placeCopy.id,place.id);assert.equal(placeCopy.layout,place.layout);
  assert.throws(()=>library.saveDataCard({...place,id:variant.id}),/cannot change kind/);
 }finally{db.close()}
});

test('isolated HTTP library CRUD, asset import/reconnection and workflow persistence',{timeout:15000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'vr-characters-'));let child;
 try{
  for(const file of ['server.mjs','engine.mjs','graph-engine.mjs','webhooks.mjs','library.mjs','artifacts.mjs','public'])cpSync(new URL(file,root),path.join(dir,file),{recursive:true});
  writeFileSync(path.join(dir,'offline.mjs'),"globalThis.fetch=async()=>{throw Error('External network forbidden in character fixture')};");
  child=spawn(process.execPath,['--import',path.join(dir,'offline.mjs'),path.join(dir,'server.mjs')],{env:{...process.env,PORT:'18819',VIDEOROUTER_API_KEY:'',VIDEOROUTER_MANAGEMENT_KEY:'',VIDEOROUTER_WEBHOOK_ENABLED:'0',VIDEOROUTER_WEBHOOK_SECRET:''},stdio:['ignore','pipe','pipe']});
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Fixture server exited')})]);
  const base='http://127.0.0.1:18819';
  const local=async(p,body)=>{const r=await fetch(base+'/local/'+p,{method:body===undefined?'GET':'POST',headers:{'X-Studio':'1','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data};
  const upload=await fetch(base+'/local/file?name=portrait.png',{method:'POST',headers:{'X-Studio':'1','Content-Type':'image/png'},body:Buffer.from('fixture')});const file=await upload.json();
  const card=characters()[0];card.assets=[{...card.assets[0],fileId:file.file}];await local('data-card',card);
  assert.equal((await local('data-cards')).length,1);assert.equal((await local('data-cards/context')).files[0].id,file.file);
  const place=location();place.assets=[{...place.assets[0],fileId:file.file}];await local('data-card',place);
  const context=await local('data-cards/context');assert.deepEqual(new Set(context.cards.map(c=>c.kind)),new Set(['character','location']));
  const w=workflow();w.dataCards=[card,place];w.steps=w.steps.slice(0,1);w.steps[0].nodes[0].inputs.input_references=[ref('kira','front'),ref('home','outside')];
  const imported=await local('workflow/import',{text:JSON.stringify(w)});assert.equal(imported.workflow.dataCards[0].assets[0].fileId,file.file);
  const exportResult=await local('workflow/export',{workflow:imported.workflow});assert.equal(exportResult.workflow.view,'flow');assert.deepEqual(exportResult.workflow.dataCards,imported.workflow.dataCards);
  const clone=await local('data-card/kira/duplicate',{});assert.notEqual(clone.id,'kira');
  await local('library/delete',await local('library/delete-preview',{kind:'data-card',id:'kira'}));
  const state=await local('state');assert.equal(state.dataCards.length,2);assert.equal(state.flows[0].dataCards[0].id,'kira');assert.equal(state.flows[0].dataCards[1].layout,place.layout);assert.equal(state.runs.length,0);
  const placeCopy=await local('data-card/home/duplicate',{});assert.equal(placeCopy.kind,'location');assert.notEqual(placeCopy.id,'home');
  await local('library/delete',await local('library/delete-preview',{kind:'data-card',id:'home'}));assert.equal((await local('state')).flows[0].dataCards[1].id,'home');
  assert.equal((await fetch(base+'/asset/'+file.file)).status,200);assert.equal((await fetch(base+'/character-ui.mjs')).status,200);
 }finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit')}rmSync(dir,{recursive:true,force:true})}
});

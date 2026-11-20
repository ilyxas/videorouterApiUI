// Real, opt-in Grok stress suite. No VideoRouter credentials or production writes.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {cpSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync,renameSync,statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';

const cases=[
 ['01-text-minimum','text-to-video',0,1,'480p','1:1'],
 ['02-text-maximum','text-to-video',0,15,'720p','16:9'],
 ['03-single-frame','image-to-video',1,3,'480p','9:16'],
 ['04-portrait-detail','image-to-video',1,6,'720p','9:16'],
 ['05-pinned-endpoints','image-to-video',2,5,'720p','16:9'],
 ['06-two-references','reference-to-video',2,5,'720p','16:9'],
 ['07-four-references','reference-to-video',4,8,'720p','16:9'],
 ['08-eight-references','reference-to-video',8,10,'720p','16:9'],
 ['09-fourteen-references','reference-to-video',14,15,'720p','16:9'],
 ['10-reversed-fourteen','reference-to-video',14,6,'480p','16:9'],
 ['11-portrait-references','reference-to-video',4,6,'720p','2:3'],
 ['12-landscape-references','reference-to-video',6,8,'480p','3:2'],
 ['13-active-and-reused','reference-to-video',4,12,'720p','16:9'],
 ['14-pause-edit-resume','reference-to-video',4,6,'720p','16:9'],
 ['15-missing-source','reference-to-video',4,5,'480p','16:9']
].map(([id,mode,references,duration,resolution,ratio])=>({id,mode,references,duration,resolution,ratio}));
if(!process.argv.includes('--run-live')){
 console.log(JSON.stringify({usage:'node tests/live-grok-stress.mjs --run-live [--resume=/absolute/report-directory] [--normalize-large-test-images]',videoJobs:15,seedImages:5,extraImageOperations:'Active edit plus pause/standalone edit; the Grok agent may make its own intermediates.',cases},null,2));process.exit(0);
}
const source=fileURLToPath(new URL('../',import.meta.url));
const resume=process.argv.find(a=>a.startsWith('--resume='))?.slice(9);
const root=resume?path.resolve(resume):path.join(source,'data/grok-stress',new Date().toISOString().replaceAll(':','-'));
const studio=path.join(root,'studio'),reportFile=path.join(root,'report.json');
const port=18832,base='http://127.0.0.1:'+port,production=process.env.STUDIO_URL||'http://127.0.0.1:8791';
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(production));assert.notEqual(base,production);
mkdirSync(root,{recursive:true});
let report=resume?JSON.parse(readFileSync(reportFile,'utf8')):{started:new Date().toISOString(),root,port,cases:[],limits:[],samples:[],seedWorkflowId:'grok-stress-seeds',plan:cases};
const checkpoint=()=>{writeFileSync(reportFile+'.tmp',JSON.stringify(report,null,2));renameSync(reportFile+'.tmp',reportFile)};
const log=value=>console.log(JSON.stringify(value));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const headers={'X-Studio':'1','Content-Type':'application/json'};
async function api(route,body,url=base){
 const response=await fetch(url+'/local/'+route,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const result=await response.json();if(!response.ok)throw Error(route+': '+result.error);return result;
}
function productionFingerprint(){
 const db=new DatabaseSync(path.join(source,'data/studio.sqlite'),{readOnly:true});
 try{return {records:sha(JSON.stringify(db.prepare("SELECT kind,id,body FROM records WHERE kind IN ('flow','run','data-card') ORDER BY kind,id").all())),assets:sha(JSON.stringify(db.prepare('SELECT * FROM assets ORDER BY id').all()))}}finally{db.close()}
}
const node=(id,mode,parameters,inputs={})=>({id,kind:mode.includes('video')?'video':'image',operationId:mode,op:mode.includes('video')?'POST /v1/videos':'POST /v1/images',model:mode.includes('video')?'grok-cli/video':'grok-cli/image',parameters,inputs});
const step=(id,nodes,edges=[],enabled=true,cont=true)=>({id,name:id,view:'cards',enabled,continueOnSuccess:cont,nodes,edges});
const edge=(id,from,fromStep,to,port,slot=0)=>({id,from:{stepId:fromStep,nodeId:from,port:'images',outputIndex:0},to:{nodeId:to,port,slot}});
const imageParams=prompt=>({prompt,aspect_ratio:'16:9'});
const seeds={version:2,id:report.seedWorkflowId,name:'Grok stress reference assets',view:'flow',steps:[
 step('stadium',[node('stadium','text-to-image',imageParams('Photorealistic empty neighborhood football stadium in soft afternoon light. Green grass pitch, white field markings, blue spectator seats, low concrete stands, a running track, and a wooden bench beside the sideline. Eye-level wide view. No people, no writing, no logos.'))]),
 step('stadium-side',[node('stadium-side','image-edit',imageParams('Show the same empty football stadium from a low sideline angle facing diagonally across the field. Preserve the blue seats, concrete stands, track, wooden bench, field markings, afternoon lighting and architecture. No people, no text.'))],[edge('side-source','stadium','stadium','stadium-side','input_references')]),
 step('stadium-bench',[node('stadium-bench','image-edit',imageParams('Show a closer eye-level view of the wooden sideline bench in this same football stadium. The green pitch, running track and blue spectator seats remain visible behind it. Preserve the same architecture and afternoon lighting. No people, no text.'))],[edge('bench-source','stadium','stadium','stadium-bench','input_references')]),
 step('phone',[node('phone','text-to-image',imageParams('Product reference photograph of a plain dark-blue smartphone, three-quarter rear view, on a neutral light-gray surface. Rounded corners, two small rear cameras, no brand, no text. Soft realistic light.'))]),
 step('ball',[node('ball','text-to-image',imageParams('Product reference photograph of a bright orange football with thin black panel seams, on a neutral light-gray surface. No brand, no text. Soft realistic light.'))])
]};
let child,monitor,context,card,refs;
const runDetails=new Map();
async function begin(workflow,name,options={}){
 await api('workflow',workflow);const prep=await api('prepare',{workflow,name,...options});
 const result=await api('run',{ticket:prep.ticket});return {runId:result.id,preview:prep.preview,started:new Date().toISOString()};
}
async function settle(id,{pause}={}){
 let previous='',pauseHandled=false;
 for(let i=0;i<2400;i++){
  const r=await api('run/'+id+'?view=workflow'),signature=JSON.stringify([r.status,r.steps.map(s=>[s.id,s.status,s.progress])]);
  if(signature!==previous){log({run:id,status:r.status,nodes:r.steps.map(s=>({id:s.id,status:s.status,progress:s.progress,error:s.error}))});previous=signature}
  if(r.status==='paused'&&pause&&!pauseHandled){pauseHandled=true;await pause(await api('run/'+id));continue}
  if(r.status!=='running')return api('run/'+id);
  await sleep(2000);
 }
 throw Error('Run is still active after the bounded observation period; do not resubmit.');
}
function binding(ref){return ref.character?{dataCardId:card.id,assetId:ref.assetId}:{assetId:ref.file}}
function grounding(selected){return selected.map((r,i)=>'<IMAGE_'+i+'>: '+r.description).join('\n')+'\nAll Kira views depict one adult woman; use them for identity and wardrobe, not multiple people or mandatory poses. Stadium images depict different views of one place.'}
function scenario(c){
 let selected=[];
 if(c.id==='03-single-frame')selected=[refs[0]];
 else if(c.id==='04-portrait-detail')selected=[refs[1]];
 else if(c.id==='05-pinned-endpoints')selected=[refs[9],refs[10]];
 else if(c.id==='06-two-references')selected=[refs[0],refs[9]];
 else if(['07-four-references','11-portrait-references'].includes(c.id))selected=[refs[0],refs[1],refs[9],refs[13]];
 else if(c.id==='08-eight-references')selected=[...refs.slice(0,5),refs[9],refs[11],refs[12]];
 else if(c.id==='09-fourteen-references')selected=refs;
 else if(c.id==='10-reversed-fourteen')selected=refs.toReversed();
 else if(c.id==='12-landscape-references')selected=[refs[0],refs[2],refs[3],refs[9],refs[10],refs[13]];
 else selected=[refs[0],refs[9],refs[12],refs[13]];
 let prompt=c.mode==='reference-to-video'?grounding(selected)+'\nOne continuous natural shot of Kira at the stadium. Preserve her long dark hair, beige top, brown leggings and shoes, and the stadium architecture. She walks a few paces along the sideline and turns toward the field. Where the ball is supplied, it rests beside the bench; where the phone is supplied, she holds it in her right hand throughout. Smooth camera movement, no cuts, no duplicate people.':
 c.id==='01-text-minimum'?'A blue rubber ball makes one small bounce on a plain white tabletop, locked camera, one continuous shot.':
 c.id==='02-text-maximum'?'One continuous wide shot in an empty football stadium. An adult athlete in blue sportswear holds a phone in the right hand, begins a controlled turn, completes three full rotations with gradually increasing speed, then releases the phone toward a shallow pool beside the pitch. The phone follows a visible arc and splashes into the water. Preserve the same athlete, hand occupancy, stadium and camera position. No cuts or teleportation.':
 c.id==='05-pinned-endpoints'?'A smooth continuous camera move through this empty stadium from the supplied starting view toward the supplied ending view. Preserve the stadium architecture and afternoon light. No new people or objects.':
 'Animate the adult woman in the supplied image with a natural breath, gentle blink and slight head turn. Preserve her identity, hair, clothing, framing and background in one continuous shot.';
 const inputs=c.mode==='reference-to-video'?{input_references:selected.map(binding)}:c.mode==='image-to-video'?{start_image_url:[binding(selected[0])],...(selected.length===2?{end_image_url:[binding(selected[1])]}:{})}:{};
 const video=node('video',c.mode,{prompt,duration_secs:c.duration,resolution:c.resolution,aspect_ratio:c.ratio},inputs);
 const w={version:2,id:'stress-'+c.id,name:'Grok stress · '+c.id,view:'flow',dataCards:[card],steps:[step('video',[video])]};
 if(['13-active-and-reused','14-pause-edit-resume','15-missing-source'].includes(c.id)){
  w.steps=seeds.steps.map(s=>({...structuredClone(s),enabled:false}));
  for(const s of w.steps)for(const n of s.nodes)n.reuse={mode:'pinned',workflowId:seeds.id,runId:report.seed.runId};
  if(c.id==='13-active-and-reused')w.steps.find(s=>s.id==='stadium-side').enabled=true;
  if(c.id==='14-pause-edit-resume'){
   w.steps.push(step('compose',[node('compose','image-edit',imageParams('Place the same adult woman from the first reference beside the bench in the stadium from the second reference. Preserve her face, clothing, stadium and lighting. She stands naturally facing the camera.'),{input_references:[binding(refs[0]),null]})],[edge('compose-place','stadium','stadium','compose','input_references',1)],true,false));
  }
  video.inputs={input_references:[binding(refs[0]),null,null,null]};
  const from=c.id==='13-active-and-reused'?'stadium-side':c.id==='14-pause-edit-resume'?'compose':'stadium';
  const edges=[edge('place',from,from,'video','input_references',1),edge('phone','phone','phone','video','input_references',2),edge('ball','ball','ball','video','input_references',3)];
  if(c.id==='15-missing-source'){
   w.steps.push(step('missing',[node('missing','text-to-image',imageParams('An unused yellow cone.'))],[],false));
   video.inputs.input_references.unshift(null);edges.forEach(e=>e.to.slot++);
   edges.push(edge('absent','missing','missing','video','input_references',0));
   video.parameters.prompt=video.parameters.prompt.replace(/<IMAGE_(\d+)>/g,(_,n)=>'<IMAGE_'+(+n+1)+'>');
  }
  w.steps.push(step('video',[video],edges));
 }
 return w;
}
function sessionEvidence(row){
 if(!row.idempotencyKey)return {};
 const folder=path.join(studio,'data/grok-attempts',row.idempotencyKey),file=path.join(folder,'state.json');if(!existsSync(file))return {};
 const job=JSON.parse(readFileSync(file,'utf8')),session=path.join(process.env.HOME,'.grok/sessions',encodeURIComponent(job.cwd),job.id);
 const calls=Object.values(job.calls||{}),given=[...(job.task?.images||[]),job.task?.first_frame,job.task?.last_frame].filter(Boolean),used=calls.map(c=>JSON.stringify(c.input));
 let titles=[];const journal=path.join(session,'updates.jsonl');
 if(existsSync(journal))for(const line of readFileSync(journal,'utf8').split('\n')){try{const u=JSON.parse(line).params?.update;if(u?.sessionUpdate==='tool_call')titles.push(u.title)}catch{}}
 return {sessionId:job.id,status:job.status,end:job.end,error:job.error,stagedReferences:given.length,referenceHashes:given.map(f=>sha(readFileSync(f))),referencesUsedByMediaTools:given.map(f=>used.some(s=>s.includes(f))),toolNames:titles,tools:calls.map(c=>({tool:c.tool,status:c.status,input:c.input,output:c.output})),intermediates:row.result?.intermediates?.length||0};
}
function inspect(record,run){
 const row=run.steps.find(r=>r.id==='video');record.status=run.status;record.error=run.error||row?.error;record.cost=run.cost;record.finished=new Date().toISOString();record.wallSeconds=(Date.parse(record.finished)-Date.parse(record.started))/1000;
 record.nodes=run.steps.map(r=>({id:r.id,status:r.status,omitted:r.omitted,reusedFrom:r.reusedFrom?.runId,submitted:!!r.request,cost:r.cost}));
 record.evidence=sessionEvidence(row);record.artifacts=row.artifacts||[];
 record.checks={zeroCost:run.cost===0,noUpload:run.steps.every(s=>s.technical.length===0),reusedNeverSubmitted:run.steps.filter(r=>r.status==='reused'||r.status==='skipped').every(r=>!r.request),toolsAllowed:record.evidence.toolNames?.every(t=>['image_gen','image_edit','reference_to_video','read_file'].includes(t))};
 if(row.artifacts?.[0]?.file){
  const output=path.join(studio,'data/files',row.artifacts[0].file);record.output=output;
  record.media=JSON.parse(execFileSync('/opt/homebrew/bin/ffprobe',['-v','error','-show_entries','stream=codec_type,codec_name,width,height,r_frame_rate:format=duration,size','-of','json',output],{encoding:'utf8'}));
  const expected=cases.find(c=>c.id===record.id);record.checks.durationWithinOneFrame=Math.abs(Number(record.media.format.duration)-expected.duration)<=.09;
  record.checks.hasVideo=record.media.streams.some(s=>s.codec_type==='video');
  record.checks.allStagedReferencesUsed=record.evidence.referencesUsedByMediaTools.every(Boolean);
  const frames=path.join(root,'frames',record.id);mkdirSync(frames,{recursive:true});
  for(const [index,at] of [0,expected.duration/2,Math.max(0,expected.duration-.15)].entries())execFileSync('/opt/homebrew/bin/ffmpeg',['-v','error','-ss',String(at),'-i',output,'-frames:v','1','-vf','scale=480:-2','-y',path.join(frames,index+'.jpg')]);
 }
 record.passed=run.status==='completed'&&Object.values(record.checks).every(Boolean);
 runDetails.set(record.id,run);checkpoint();log({finished:record.id,status:record.status,passed:record.passed,error:record.error,checks:record.checks,media:record.media});
}
async function executeCase(c){
 let record=report.cases.find(r=>r.id===c.id);
 if(record?.finished)return record;
 const w=scenario(c);
 if(!record){record={id:c.id,requested:c,...await begin(w,w.name)};report.cases.push(record);checkpoint()}
 const run=await settle(record.runId,{pause:c.id==='14-pause-edit-resume'?async paused=>{
  record.pauseObserved=true;checkpoint();const revision=structuredClone(paused.config.workflow);
  revision.steps.find(s=>s.id==='compose').nodes[0].parameters.prompt+=' She now raises her left hand in a small greeting; her right hand remains relaxed.';
  const childRun=await begin(revision,'Grok stress · standalone edit',{stepId:'compose',parentRunId:paused.id,parentRevision:paused.revision});
  record.childRun=childRun;checkpoint();const done=await settle(childRun.runId);assert.equal(done.status,'completed',done.error);
  const parent=await api('run/'+paused.id);assert.equal(parent.status,'paused');
  const prep=await api('prepare',{workflow:revision,runId:parent.id,revision:parent.revision});await api('run/'+parent.id+'/resume',{ticket:prep.ticket});
 }:undefined});inspect(record,run);return record;
}
function gallery(){
 const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
 const relative=f=>path.relative(root,f).split(path.sep).join('/');
 const html='<!doctype html><meta charset="utf-8"><title>Grok stress results</title><style>body{font:16px system-ui;max-width:1100px;margin:30px auto;padding:16px;background:#f6f5fa}article{background:white;padding:20px;margin:20px 0;border-radius:12px}video{max-width:100%;max-height:480px}.frames{display:flex;gap:6px}.frames img{width:32%;object-fit:contain}pre{white-space:pre-wrap}</style><h1>Grok stress test</h1><p>'+esc(report.status)+' · '+report.cases.filter(c=>c.status==='completed').length+'/15 videos completed. No automatic retries.</p>'+report.cases.map(r=>'<article><h2>'+esc(r.id)+'</h2><p>'+esc(r.status)+' · '+esc(r.wallSeconds)+' seconds elapsed · '+esc(JSON.stringify(r.requested))+'</p>'+(r.output?'<video controls preload="metadata" src="'+esc(relative(r.output))+'"></video><div class="frames">'+[0,1,2].map(i=>'<img src="frames/'+r.id+'/'+i+'.jpg">').join('')+'</div>':'')+'<pre>'+esc(JSON.stringify({error:r.error,checks:r.checks,media:r.media,visualReview:r.visualReview},null,2))+'</pre></article>').join('');
 writeFileSync(path.join(root,'gallery.html'),html);
}
try{
 const prod=await api('state',undefined,production);assert.equal(prod.grok?.available,true);assert.equal(prod.grok.active,0,'A production Grok card is active');
 report.productionBefore||=productionFingerprint();
 if(!resume){
  for(const f of ['server.mjs','engine.mjs','graph-engine.mjs','webhooks.mjs','library.mjs','artifacts.mjs','grok-cli.mjs','public'])cpSync(path.join(source,f),path.join(studio,f),{recursive:true});
  context=await api('data-cards/context',undefined,production);writeFileSync(path.join(root,'source-context.json'),JSON.stringify(context,null,2));
 }else context=JSON.parse(readFileSync(path.join(root,'source-context.json'),'utf8'));
 child=spawn(process.execPath,[path.join(studio,'server.mjs')],{env:{...process.env,PORT:String(port),VIDEOROUTER_API_KEY:'',VIDEOROUTER_MANAGEMENT_KEY:'',VIDEOROUTER_WEBHOOK_ENABLED:'0',VIDEOROUTER_WEBHOOK_SECRET:'',XAI_API_KEY:''},stdio:['ignore','pipe','pipe']});
 let errors='';child.stderr.on('data',x=>errors=(errors+x).slice(-4000));child.stdout.on('data',()=>{});
 let ready=false;for(let i=0;i<40;i++){try{await api('state');ready=true;break}catch{}await sleep(200)}assert(ready,errors);
 assert.deepEqual((await api('state')).keys,{api:false,management:false});
 monitor=setInterval(()=>{try{
  const lines=execFileSync('ps',['-axo','pid=,ppid=,rss=,pcpu=,comm='],{encoding:'utf8'}).trim().split('\n').map(s=>s.trim().split(/\s+/));
  const children=lines.filter(a=>+a[1]===child.pid),parent=lines.find(a=>+a[0]===child.pid);
  report.samples.push({time:new Date().toISOString(),serverRssKiB:+parent?.[2],children:children.map(a=>({pid:+a[0],rssKiB:+a[2],cpu:+a[3],command:a.slice(4).join(' ')}))});checkpoint();
 }catch{}},10000);monitor.unref();
 if(!report.character){
  card=structuredClone(context.cards.find(c=>c.kind==='character'&&c.name==='Kira'));assert(card,'Kira is required for this saved scenario suite');card.assets=card.assets.filter(a=>a.type==='image');assert.equal(card.assets.length,9,'This suite expects the nine described Kira views');
  for(const asset of card.assets){const response=await fetch(production+'/asset/'+asset.fileId);assert(response.ok);const bytes=Buffer.from(await response.arrayBuffer());const uploaded=await fetch(base+'/local/file?name='+encodeURIComponent(asset.name),{method:'POST',headers:{'X-Studio':'1','Content-Type':response.headers.get('content-type')},body:bytes});assert(uploaded.ok);asset.fileId=(await uploaded.json()).file}
  report.character=card;checkpoint();
 }else card=report.character;
 if(process.argv.includes('--normalize-large-test-images'))for(const asset of card.assets){
  const original=path.join(studio,'data/files',asset.fileId);if(statSync(original).size<=20*1024*1024)continue;
  const jpeg=path.join(root,'normalized-'+asset.fileId+'.jpg');
  execFileSync('/opt/homebrew/bin/ffmpeg',['-v','error','-i',original,'-frames:v','1','-q:v','2','-y',jpeg]);
  const bytes=readFileSync(jpeg);assert(bytes.length<=20*1024*1024);
  const response=await fetch(base+'/local/file?name='+encodeURIComponent(asset.name+'.jpg'),{method:'POST',headers:{'X-Studio':'1','Content-Type':'image/jpeg'},body:bytes});assert(response.ok);
  const file=(await response.json()).file;
  const conversion={assetId:asset.id,originalFile:asset.fileId,originalBytes:statSync(original).size,originalSHA256:sha(readFileSync(original)),file,bytes:bytes.length,sha256:sha(bytes),method:'JPEG q=2, original dimensions retained; isolated test copy only'};
  (report.assetNormalization||=[]).push(conversion);asset.fileId=file;checkpoint();log({normalized:conversion});
 }
 if(!report.seed){report.seed=await begin(seeds,seeds.name);checkpoint()}
 const seeded=await settle(report.seed.runId);report.seed.status=seeded.status;checkpoint();assert.equal(seeded.status,'completed',seeded.error);
 refs=[...card.assets.map(a=>({character:true,assetId:a.id,description:a.description,file:a.fileId})),...seeded.steps.map(r=>({file:r.artifacts[0].file,description:({stadium:'Wide view of the empty blue-seat football stadium','stadium-side':'Sideline view of the same stadium','stadium-bench':'The wooden bench at the same stadium',phone:'Plain dark-blue smartphone',ball:'Orange football with black seams'})[r.id]}))];
 assert.equal(refs.length,14);writeFileSync(path.join(root,'manifest.json'),JSON.stringify(await Promise.all(cases.map(async c=>({case:c,workflow:report.cases.some(r=>r.id===c.id)?(await api('run/'+report.cases.find(r=>r.id===c.id).runId)).config.workflow:scenario(c)}))),null,2));
 if(!report.limits.length){
  for(const [name,change] of [['16-seconds',w=>w.steps[0].nodes[0].parameters.duration_secs=16],['1080p',w=>w.steps[0].nodes[0].parameters.resolution='1080p'],['15-references',w=>w.steps[0].nodes[0].inputs.input_references.push(binding(refs[0]))]]){
   const w=scenario(cases[8]);change(w);let error;try{await api('prepare',{workflow:w,name})}catch(e){error=e.message}assert(error,'Invalid request was accepted: '+name);report.limits.push({name,rejected:true,error});checkpoint();
  }
 }
 if(report.error){(report.stops||=[]).push({resumed:new Date().toISOString(),error:report.error});delete report.error}
 report.status='running';checkpoint();log({reportFile,gallery:path.join(root,'gallery.html'),videoJobs:15,referenceFiles:14});
 // The first three workflows are submitted together to exercise the provider queue.
 const first=await Promise.allSettled(cases.slice(0,3).filter(c=>!report.cases.some(r=>r.id===c.id&&r.finished)).map(executeCase));for(const r of first)if(r.status==='rejected')throw r.reason;
 let failures=first.map(r=>r.value).filter(r=>!r.passed).length;
 if(failures>=2)throw Error('Two queued cases failed; scheduling paused for inspection. Resume never resubmits finished cases.');
 for(const c of cases.slice(3)){
  if(report.cases.some(r=>r.id===c.id&&r.finished))continue;
  const result=await executeCase(c);failures=result.passed?0:failures+1;
  if(failures>=2)throw Error('Two consecutive cases failed; scheduling paused for inspection.');
 }
 report.status=report.cases.every(r=>r.passed)?'passed':'completed-with-failures';
}catch(error){report.status='stopped';report.error=error.message;log({stopped:error.message,reportFile});process.exitCode=1}
finally{
 clearInterval(monitor);report.finished=new Date().toISOString();report.productionAfter=productionFingerprint();report.productionUnchanged=JSON.stringify(report.productionBefore)===JSON.stringify(report.productionAfter);checkpoint();gallery();
 if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve))}
 log({status:report.status,completed:report.cases.filter(c=>c.status==='completed').length,passed:report.cases.filter(c=>c.passed).length,productionUnchanged:report.productionUnchanged,reportFile,gallery:path.join(root,'gallery.html')});
}

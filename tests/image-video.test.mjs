import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const root=fileURLToPath(new URL('../',import.meta.url));
test('image → selected base64 → quote → async video; failures never create dependent videos',{timeout:20000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'videorouter-chain-')),port=18796,callsFile=path.join(dir,'calls.jsonl');let child;
 try{
  for(const f of ['server.mjs','engine.mjs','artifacts.mjs','graph-engine.mjs','webhooks.mjs','library.mjs','public'])cpSync(path.join(root,f),path.join(dir,f),{recursive:true});
  child=spawn(process.execPath,['--import',path.join(root,'tests/offline-transport.mjs'),path.join(dir,'server.mjs')],{env:{...process.env,PORT:String(port),VIDEOROUTER_API_KEY:'fixture',VIDEOROUTER_MANAGEMENT_KEY:'',FIXTURE_CALLS:callsFile},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',chunk=>errors+=chunk);
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error(errors)})]);
  async function local(p,body){const response=await fetch('http://127.0.0.1:'+port+'/local/'+p,{method:body===undefined?'GET':'POST',headers:{'X-Studio':'1','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();assert.equal(response.ok,true,JSON.stringify(value));return value}
  const calls=()=>readFileSync(callsFile,'utf8').trim().split('\n').map(JSON.parse);
  async function run(prompt){
   const steps=[{id:'image-op',sourceStepId:'image',op:'POST /v1/images',params:{model:'gpt-image-1',prompt,n:2},quoteBeforeRun:true},{id:'video-op',sourceStepId:'video',op:'POST /v1/videos',params:{model:'lightricks/ltx-2.5-fast',prompt:'Animate',duration_secs:5,start_image_url:{$artifact:{stepId:'image',index:1,port:'images',type:'image'}}},wait:true,quoteBeforeRun:true}];
   const ticket=await local('prepare',{name:'Fixture chain',steps,workflow:{name:'Fixture chain',steps}});const started=await local('run',ticket);
   let result;
   for(let i=0;i<150;i++){result=await local('run/'+started.id);if(result.status!=='running')return result;await new Promise(r=>setTimeout(r,40))}
   throw Error('Fixture timed out');
  }
  const completed=await run('Frame');assert.equal(completed.status,'completed');
  const recorded=calls();assert.deepEqual(recorded.map(c=>c.path),['/api/v1/pricing/estimate','/api/v1/images','/api/v1/pricing/estimate','/api/v1/videos','/api/v1/videos/fixture-video']);
  const {endpoint,...quote}=recorded[2].params;assert.equal(endpoint,'/v1/videos');assert.deepEqual(quote,recorded[3].params);
  assert.match(quote.start_image_url,/^data:image\/png;base64,/);assert.equal(quote.duration_secs,5);
  assert.equal(completed.steps[0].artifacts.length,2);assert.equal(completed.steps[1].request.params.start_image_url,quote.start_image_url);
  assert.deepEqual(completed.steps[1].estimate.request,recorded[2].params);assert.equal(completed.steps[0].result.data[1].b64_json,undefined);
  for(const prompt of ['source-fail','missing-output','expired','quote-fail']){
   const count=calls().length,result=await run(prompt),added=calls().slice(count);
   assert.equal(result.status,'failed',prompt);assert.ok(result.steps.every(s=>s.status!=='waiting'),prompt);
   assert.equal(added.filter(c=>c.path==='/api/v1/videos').length,0,prompt);
   assert.ok(added.filter(c=>c.path==='/api/v1/images').length<=1,prompt);
   if(['source-fail','quote-fail'].includes(prompt))assert.equal(result.steps[1].status,'blocked');
  }
  // New image actions use the same adapters, including a selected base64 result.
  const typed=(stepId,index=0)=>({$artifact:{stepId,index,port:'images',type:'image'}});
  const ref=url=>[{type:'image_url',image_url:{url}}];
  const chain=[
   {id:'a',op:'POST /v1/images',contractMode:'text-to-image',params:{model:'gpt-image-1',prompt:'Frame',n:2}},
   {id:'b',op:'POST /v1/images',contractMode:'image-edit',params:{model:'gemini-2.5-flash-image',prompt:'Blue sky',n:1,input_references:ref(typed('a',1))}},
   {id:'c',op:'POST /v1/images',contractMode:'image-upscale',params:{model:'fal/recraft-crisp-upscale',n:1,input_references:ref(typed('b'))}},
   {id:'d',op:'POST /v1/videos',contractMode:'image-to-video',wait:true,params:{model:'lightricks/ltx-2.5-fast',prompt:'Animate',duration_secs:5,start_image_url:typed('c')}}
  ].map(s=>({...s,sourceStepId:s.id,quoteBeforeRun:true}));
  async function executeChain(steps){
   const ticket=await local('prepare',{steps}),start=await local('run',ticket);
   for(let i=0;i<150;i++){const r=await local('run/'+start.id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,40))}
   throw Error('Image action chain timed out');
  }
  const before=calls().length,result=await executeChain(chain),records=calls().slice(before);
  assert.equal(result.status,'completed',JSON.stringify(result));
  assert.match(records[2].params.input_references[0].image_url.url,/^data:image\/png;base64,/);
  for(let i=0;i<8;i+=2){const {endpoint,...priced}=records[i].params;assert.deepEqual(priced,records[i+1].params);assert.ok(endpoint)}
  assert.equal(result.steps[2].request.params.prompt,undefined);
  const adjusted=structuredClone(chain);adjusted[3].params.prompt='quote-adjust';
  const offset=calls().length,stopped=await executeChain(adjusted);
  assert.equal(stopped.status,'failed');assert.match(stopped.error,/5 → 8/);
  assert.equal(calls().slice(offset).filter(c=>c.path==='/api/v1/videos').length,0);
  const invalid=structuredClone(chain);invalid[2].params.n=2;
  const count=calls().length;
  const response=await fetch('http://127.0.0.1:'+port+'/local/prepare',{method:'POST',headers:{'X-Studio':'1','Content-Type':'application/json'},body:JSON.stringify({steps:invalid})});
  assert.equal(response.status,400);assert.equal(calls().length,count);
 }finally{if(child&&child.exitCode===null){const stopped=once(child,'exit');child.kill();await stopped}rmSync(dir,{recursive:true,force:true})}
});

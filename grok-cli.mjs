import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,realpathSync,statSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {grokMode,grokQuote,isGrok,validateGrok} from './public/grok-profile.mjs';
import {publicMediaURL} from './public/workflow-core.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const mediaTypes={ImageGen:'image',ImageEdit:'image',ReferenceToVideo:'video'};
const mediaTools=new Set(['image_gen','image_edit','reference_to_video']);
const inside=(root,file)=>file.startsWith(root+path.sep);
function mime(bytes){
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
 if(bytes.toString('ascii',4,8)==='ftyp')return 'video/mp4';
 throw Error('Grok returned an unsupported media file.');
}
const writeJSON=(file,value)=>{writeFileSync(file+'.tmp',JSON.stringify(value),{mode:0o600});renameSync(file+'.tmp',file)};
export function createGrokProvider({directory,readAsset,storeFile,binary=process.env.GROK_CLI_PATH||path.join(os.homedir(),'.grok/bin/grok'),home=os.homedir(),spawnProcess=spawn,request=fetch,timeoutMs=15*60*1000}){
 const root=path.resolve(directory);let queue=Promise.resolve();const active=new Set();
 const info=()=>({available:existsSync(binary),credentialsPresent:existsSync(path.join(home,'.grok/auth.json')),additionalCost:0,active:active.size});
 const location=id=>{if(!uuid.test(id))throw Error('Invalid Grok attempt ID.');return path.join(root,id)};
 const load=id=>JSON.parse(readFileSync(path.join(location(id),'state.json'),'utf8'));
 const save=job=>writeJSON(path.join(location(job.id),'state.json'),job);
 function collect(job){
  if(job.result)return job.result;
  const outputs=Object.values(job.calls||{}).filter(c=>c.status==='completed'&&mediaTypes[c.output?.type]);
  const finals=outputs.filter(c=>mediaTypes[c.output.type]===job.kind);
  if(job.end!=='end_turn'||job.error||!finals.length)throw Error(job.error||'Grok has no completed result yet. Recover can inspect the existing attempt; it never starts another generation.');
  if(job.kind==='video'&&finals.length!==1||job.kind==='image'&&finals.length!==1)throw Error('Grok returned an unexpected number of final outputs.');
  const finalCall=finals[0];
  if(job.kind==='image'&&finalCall.tool!==(job.mode==='image-edit'?'image_edit':'image_gen'))throw Error('Grok used the wrong image operation.');
  if(job.kind==='video'&&job.task){
   const args=finalCall.input||{};
   if(args.duration!==job.task.duration||(args.resolution_name||'480p')!==job.task.resolution_name||args.aspect_ratio!==job.task.aspect_ratio)throw Error('Grok did not preserve the requested video duration, resolution, or aspect ratio. The existing output was retained in its session.');
  }
  const sessionRoot=realpathSync(path.join(home,'.grok/sessions',encodeURIComponent(realpathSync(job.cwd)),job.id));
  const validated=outputs.map(c=>{
   const file=realpathSync(c.output.path);if(!inside(sessionRoot,file))throw Error('Grok output is outside this attempt’s session.');
   const stat=statSync(file);if(!stat.isFile()||stat.size>200*1024*1024||stat.size===0)throw Error('Grok output is missing or too large.');
   const bytes=readFileSync(file),type=mime(bytes);if(!type.startsWith(mediaTypes[c.output.type]+'/'))throw Error('Grok output type does not match its file.');
   return {bytes,name:path.basename(file),type,tool:c.tool};
  });
  const imported=validated.map(v=>({...storeFile(v.bytes,v.name,v.type),grokTool:v.tool}));
  const final=imported[outputs.indexOf(finals[0])];
  job.result={data:{id:'grok-cli:'+job.id,status:'completed',data:[final],execution_provider:'grok-cli',session_id:job.id,intermediates:imported.filter(v=>v!==final),tool_calls:outputs.map(c=>({tool:c.tool,parameters:c.input})),cost_usd:0},cost:0};job.status='completed';save(job);return job.result;
 }
 function apply(job,event,onEvent=()=>{}){
  const id=event.toolCallId;
  if(event.type==='tool_call'&&mediaTools.has(event.toolName)){
   job.calls[id]={tool:event.toolName,input:event.rawInput,status:event.status};
   const calls=Object.values(job.calls),videos=calls.filter(c=>c.tool==='reference_to_video').length;
   if(videos>1||calls.length>(job.kind==='video'?4:1))throw Error('Grok exceeded this card’s media-operation limit.');
   onEvent('Grok: '+event.toolName);
  }
  if(id&&job.calls[id]&&event.type==='tool_call_update'){
   const call=job.calls[id];if(event.status)call.status=event.status;
   if(event.rawInput)call.input=event.rawInput;
   if(mediaTypes[event.rawOutput?.type])call.output=event.rawOutput;
   if(event.status==='failed')job.error='Grok media generation failed; no automatic retry was started.';
  }
  if(event.type==='end'){job.end=event.stopReason;if(event.error)job.error=String(event.error).slice(0,500)}
  if(event.type==='error')job.error=String(event.message||'Grok failed.').slice(0,500);
  save(job);
 }
 async function inputFile(value,job,index){
  let bytes;
  if(value?.file)bytes=readAsset(value.file).bytes;
  else if(typeof value==='string'&&value.startsWith('data:image/')){
   const match=/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(value);if(!match)throw Error('Invalid inline Grok reference.');bytes=Buffer.from(match[1],'base64');
  }else{
   let url=publicMediaURL(value),response;
   for(let i=0;i<4;i++){
    response=await request(url,{redirect:'manual',signal:AbortSignal.timeout(30000)});
    if(response.status<300||response.status>=400)break;
    const next=response.headers.get('location');await response.body?.cancel();url=publicMediaURL(new URL(next,url).href);
   }
   if(!response?.ok)throw Error('Could not download the Grok reference.');
   const chunks=[];let length=0;
   for await(const chunk of response.body){length+=chunk.length;if(length>20*1024*1024)throw Error('Grok image reference exceeds 20 MiB.');chunks.push(chunk)}bytes=Buffer.concat(chunks);
  }
  if(bytes.length>20*1024*1024)throw Error('Grok image reference exceeds 20 MiB.');
  const type=mime(bytes);if(!type.startsWith('image/'))throw Error('Grok requires image references.');
  const file=path.join(job.cwd,'reference-'+index+'.'+type.split('/')[1]);writeFileSync(file,bytes,{mode:0o600});return file;
 }
 async function execute(p,onEvent){
  const mode=grokMode(p),kind=p.model==='grok-cli/image'?'image':'video';
  const id=p.$headers?.['Idempotency-Key']||randomUUID(),clean={...p};delete clean.$headers;
  validateGrok(mode,clean,{complete:true});
  const folder=location(id);
  if(existsSync(path.join(folder,'state.json')))return collect(load(id));
  if(!info().available)throw Error('Grok CLI is not installed. Set GROK_CLI_PATH or install it at ~/.grok/bin/grok.');
  mkdirSync(path.join(folder,'workspace'),{recursive:true,mode:0o700});
  const job={id,kind,mode,cwd:realpathSync(path.join(folder,'workspace')),status:'preparing',created:new Date().toISOString(),calls:{}};save(job);
  let index=0;
  const refs=[];for(const ref of p.input_references||[])refs.push(await inputFile(ref.image_url.url,job,index++));
  const first=p.start_image_url?await inputFile(p.start_image_url,job,index++):undefined;
  const last=p.end_image_url?await inputFile(p.end_image_url,job,index++):undefined;
  const task={operation:mode,prompt:p.prompt,aspect_ratio:p.aspect_ratio||'16:9',...(kind==='video'?{duration:p.duration_secs??6,resolution_name:p.resolution||'720p'}:{}),...(refs.length?{images:refs}:{}),...(first?{first_frame:first}:{}),...(last?{last_frame:last}:{})};
  job.task=task;save(job);
  const instructions=`Execute one VideoRouter Studio media card. The JSON below is the complete task, not a request to edit code or manage a workflow. Preserve its user prompt and requested duration, resolution, aspect ratio, and ordered references. For text-to-image call image_gen once; for image-edit call image_edit once with the supplied images. For video, produce exactly one final video using reference_to_video. Text-to-video may first generate and optionally edit its own source image. Other video modes must use the supplied references; you may compose a source image if needed, preserving all supplied identities and environments. At most three intermediate image operations and one video operation. Do not retry a failed or blocked generation. Do not split into clips, use shell commands, change settings, or spawn agents. Do not ask questions. Stop after the final media tool returns and report its saved path.\nTASK JSON:\n${JSON.stringify(task)}`;
  const args=['--no-auto-update','--no-plan','--no-subagents','--max-turns','8','--tools','image_gen,image_edit,reference_to_video,read_file','--disallowed-tools','run_terminal_cmd,task,search_tool,use_tool','--disable-web-search','--always-approve','--session-id',id,'--cwd',job.cwd,'--output-format','streaming-json','-p',instructions];
  const env=Object.fromEntries(['PATH','TMPDIR','USER','LOGNAME','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  Object.assign(env,{HOME:home,GROK_DISABLE_AUTOUPDATER:'1',GROK_MEMORY:'0',GROK_WORKFLOWS:'0',GROK_MANAGED_MCPS_ENABLED:'0',GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED:'0'});
  active.add(id);job.status='running';save(job);onEvent?.('Grok: starting '+mode);
  try{
   await new Promise((resolve,reject)=>{
    const proc=spawnProcess(binary,args,{cwd:job.cwd,env,stdio:['ignore','pipe','pipe'],shell:false});
    proc.stdout.setEncoding('utf8');proc.stderr.setEncoding('utf8');
    let buffer='',stderr='',total=0,failure,killTimer;
    const stop=error=>{if(failure)return;failure=error;proc.kill('SIGTERM');killTimer=setTimeout(()=>proc.kill('SIGKILL'),20000);killTimer.unref?.()};
    const timer=setTimeout(()=>stop(Error('Grok timed out. Recover checks the existing attempt without generating again.')),timeoutMs);timer.unref?.();
    const line=text=>{if(!text.trim())return;let event;try{event=JSON.parse(text)}catch{throw Error('Invalid JSON event from Grok CLI.')}apply(job,event,onEvent)};
    proc.stdout.on('data',chunk=>{if(failure)return;try{total+=chunk.length;if(total>64*1024*1024)throw Error('Grok output exceeded the event limit.');buffer+=chunk.toString();if(buffer.length>4*1024*1024)throw Error('Grok event is too large.');let at;while((at=buffer.indexOf('\n'))>=0){line(buffer.slice(0,at));buffer=buffer.slice(at+1)}}catch(error){stop(error)}});
    proc.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-16000);if(/--tools[^\n]*names no tool/.test(stderr))stop(Error('Installed Grok CLI does not support the configured media tool allowlist.'))});
    proc.on('error',error=>{failure=Error('Could not start Grok CLI: '+error.message)});
    proc.on('close',code=>{clearTimeout(timer);clearTimeout(killTimer);try{if(buffer.trim()&&!failure)line(buffer);if(failure)throw failure;if(code!==0)throw Error('Grok CLI exited with code '+code+'. Check the local Grok login and usage limits.');if(job.end!=='end_turn')throw Error('Grok ended without completing the card: '+(job.end||'missing final event'));resolve()}catch(error){reject(error)}});
   });
   return collect(job);
  }catch(error){job.status='failed';job.error=error.message;save(job);throw error}
  finally{active.delete(id)}
 }
 async function recover(remoteId){
  const id=String(remoteId).replace(/^grok-cli:/,''),job=load(id);
  if(active.has(id))throw Error('Grok is still running.');
  if(job.result)return job.result;
  // A server interruption may leave a completed CLI session. Replay only its tool metadata.
  const log=path.join(home,'.grok/sessions',encodeURIComponent(job.cwd),id,'updates.jsonl');
  if(existsSync(log)&&statSync(log).size<64*1024*1024){
   for(const line of readFileSync(log,'utf8').split('\n')){if(!line)continue;let e;try{e=JSON.parse(line).params?.update}catch{continue}if(!e)continue;
    if(e.sessionUpdate==='tool_call')apply(job,{...e,type:'tool_call',toolName:e.title});
    else if(e.sessionUpdate==='tool_call_update')apply(job,{...e,type:'tool_call_update'});
   }
  }
  if(Object.values(job.calls).some(c=>c.status==='completed'&&mediaTypes[c.output?.type]===job.kind)){job.end='end_turn';delete job.error;return collect(job)}
  return collect(job);
 }
 return {info,recover,quote:grokQuote,execute(p,onEvent){if(!isGrok(p.model))throw Error('Unknown Grok model.');const task=queue.then(()=>execute(p,onEvent));queue=task.catch(()=>{});return task}};
}

import http from 'node:http';
import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';

export const webhookPaths=new Set(['/v1/videos','/v1/lipsync','/v1/face-swap','/v1/jobs']);
const success=new Set(['completed','succeeded','success']);
const failure=new Set(['failed','cancelled','canceled','expired','error']);
const terminal=status=>success.has(status)||failure.has(status);
const statusGroup=status=>success.has(status)?'completed':status==='canceled'?'cancelled':status;
const price=res=>Number.isFinite(res?.data?.cost_usd)?res.data.cost_usd:Number.isFinite(res?.cost)?res.cost:null;

export function webhookURL(value){
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||isIP(url.hostname)||!url.hostname.includes('.')||url.hostname.endsWith('.localhost')||url.pathname.replace(/\/$/,'')!=='/webhooks/videorouter')throw Error('Укажите публичный HTTPS URL с путём /webhooks/videorouter, без параметров');
 return url.origin+'/webhooks/videorouter';
}

// Only the runner advances Steps. This inbox supplies one terminal response per
// attempt to that runner, regardless of whether polling or a webhook wins.
export function createWebhookBridge({db,settings,fetchStatus,onCost=()=>{},pollDelay=4000}){
 db.exec(`CREATE TABLE IF NOT EXISTS webhook_attempts(
  id TEXT PRIMARY KEY,run_id TEXT NOT NULL,node_id TEXT NOT NULL,path TEXT NOT NULL,
  remote_id TEXT,winner TEXT,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS webhook_inbox(
  attempt_id TEXT NOT NULL,job_id TEXT NOT NULL,event TEXT NOT NULL,body TEXT NOT NULL,received INTEGER NOT NULL,
  PRIMARY KEY(attempt_id,job_id,event));`);
 const lookup=db.prepare('SELECT * FROM webhook_attempts WHERE id=?');
 const listeners=new Map(),costTimers=new Map();let closed=false;
 const get=row=>row?.webhookAttempt?lookup.get(row.webhookAttempt):null;
 const result=row=>{const a=get(row);return a?.winner?JSON.parse(a.winner):null};
 function publish(id){for(const fn of [...(listeners.get(id)||[])])fn()}
 function subscribe(id,fn){let set=listeners.get(id);if(!set)listeners.set(id,set=new Set());set.add(fn);return ()=>{set.delete(fn);if(!set.size)listeners.delete(id)}}
 function report(a,res){if(Number.isFinite(res.cost))onCost({runId:a.run_id,attemptId:a.id,cost:res.cost})}
 function watchCost(id){
  if(closed||costTimers.has(id)||!fetchStatus)return;
  const deadline=Date.now()+3600000;
  const schedule=()=>{const timer=setTimeout(tick,pollDelay);timer.unref();costTimers.set(id,timer)};
  async function tick(){
   const a=lookup.get(id),winner=a?.winner&&JSON.parse(a.winner);
   if(closed||!winner||Number.isFinite(winner.cost)||Date.now()>deadline){costTimers.delete(id);return}
   try{claim({webhookAttempt:id},await fetchStatus(a.path,a.remote_id),'poll')}catch{/* Existing job only; credentials/network can recover later. */}
   if(!closed&& !Number.isFinite(JSON.parse(lookup.get(id).winner).cost))schedule();else costTimers.delete(id);
  }
  schedule();
 }
 function claim(row,res,source='poll'){
  const a=get(row);if(!a||!a.remote_id)return res;
  if(res.data?.id&&res.data.id!==a.remote_id)throw Error('Job ID ответа не соответствует попытке');
  let winner=a.winner&&JSON.parse(a.winner);
  if(terminal(res.data?.status)){
   if(!winner){winner={data:res.data,cost:price(res),source};db.prepare('UPDATE webhook_attempts SET winner=? WHERE id=?').run(JSON.stringify(winner),a.id)}
   else if(statusGroup(winner.data.status)===statusGroup(res.data.status)&&!Number.isFinite(winner.cost)&&Number.isFinite(price(res))){
    winner.cost=price(res);winner.data.cost_usd=winner.cost;
    db.prepare('UPDATE webhook_attempts SET winner=? WHERE id=?').run(JSON.stringify(winner),a.id);
   }
  }
  if(winner){report(a,winner);publish(a.id);if(!Number.isFinite(winner.cost))watchCost(a.id)}
  return winner||res;
 }
 function prepare(run,row,route,params){
  const config=settings();
  if(!config.ready||route.method!=='POST'||!webhookPaths.has(route.path))return params;
  if(Object.hasOwn(params,'webhook_url')&&params.webhook_url!==config.url)return params;
  row.webhookAttempt||=randomUUID();
  db.prepare('INSERT OR IGNORE INTO webhook_attempts(id,run_id,node_id,path,created) VALUES(?,?,?,?,?)').run(row.webhookAttempt,run.id,row.id,route.path,Date.now());
  return {...params,webhook_url:config.url+'/'+row.webhookAttempt};
 }
 function bind(row){
  const a=get(row);if(!a||!row.remoteId)return;
  if(a.remote_id&&a.remote_id!==row.remoteId)throw Error('Job ID попытки уже сохранён');
  db.prepare('UPDATE webhook_attempts SET remote_id=? WHERE id=?').run(row.remoteId,a.id);
  const events=db.prepare('SELECT body FROM webhook_inbox WHERE attempt_id=? AND job_id=? ORDER BY received,rowid').all(a.id,row.remoteId);
  for(const event of events)claim(row,{data:JSON.parse(event.body)},'webhook');
 }
 function recover(row){
  const a=get(row);if(!a)return;
  if(!row.remoteId){
   const jobs=db.prepare('SELECT DISTINCT job_id FROM webhook_inbox WHERE attempt_id=?').all(a.id);
   row.remoteId=a.remote_id||(jobs.length===1?jobs[0].job_id:undefined);
  }
  bind(row);
 }
 function accept(id,event,delivery,body){
  const a=lookup.get(id);if(!a)return 404;
  const data=JSON.parse(body);
  const prefix=a.path==='/v1/jobs'?'job.':'video.';
  if(!data||typeof data.id!=='string'||!data.id||data.id.length>256||!terminal(data.status)||event!==prefix+statusGroup(data.status)||delivery!==data.id)return 400;
  if(a.remote_id&&a.remote_id!==data.id)return 409;
  db.prepare('INSERT OR IGNORE INTO webhook_inbox VALUES(?,?,?,?,?)').run(id,data.id,event,body,Date.now());
  // Use the first saved delivery even if a duplicate has a different body.
  const saved=db.prepare('SELECT body FROM webhook_inbox WHERE attempt_id=? AND job_id=? AND event=?').get(id,data.id,event);
  if(a.remote_id)claim({webhookAttempt:id},{data:JSON.parse(saved.body)},'webhook');
  return 204;
 }
 async function next(row,delay,request){
  if(!get(row)){await new Promise(resolve=>setTimeout(resolve,delay));return request()}
  if(result(row))return result(row);
  await new Promise(resolve=>{
   let timer;const done=()=>{clearTimeout(timer);off();resolve()};
   const off=subscribe(row.webhookAttempt,done);timer=setTimeout(done,delay);
  });
  if(result(row))return result(row);
  return poll(row,request);
 }
 async function poll(row,request){
  if(!get(row))return request();
  if(result(row))return result(row);
  let off;
  const event=new Promise(resolve=>{off=subscribe(row.webhookAttempt,()=>{const cached=result(row);if(cached)resolve(cached)})});
  // An in-flight GET may finish after a webhook: it can fill missing cost,
  // but never changes the winning output or executes any Step.
  const query=Promise.resolve().then(request).then(res=>claim(row,res),error=>{const cached=result(row);if(cached)return cached;throw error});
  try{return await Promise.race([query,event])}finally{off()}
 }
 function restore(){
  for(const a of db.prepare('SELECT * FROM webhook_attempts WHERE remote_id IS NOT NULL').all()){
   bind({webhookAttempt:a.id,remoteId:a.remote_id});
   const winner=result({webhookAttempt:a.id});if(winner){report(a,winner);if(!Number.isFinite(winner.cost))watchCost(a.id)}
  }
 }
 return {prepare,bind,recover,claim,next,poll,result,accept,restore,
  stats:()=>({received:db.prepare('SELECT count(*) AS n FROM webhook_inbox').get().n,lastReceived:db.prepare('SELECT max(received) AS date FROM webhook_inbox').get().date}),
  close(){closed=true;for(const timer of costTimers.values())clearTimeout(timer);costTimers.clear()}};
}

export function applyWebhookCost(run,attemptId,cost){
 if(!Number.isFinite(cost))return false;
 let row=run.steps.find(r=>r.webhookAttempt===attemptId),archived=false;
 if(!row){row=run.revisions?.flatMap(r=>r.steps||[]).find(r=>r.webhookAttempt===attemptId);archived=true}
 if(!row||row.status==='reused'||row.cost===cost)return false;
 const previous=Number.isFinite(row.cost)?row.cost:0;row.cost=cost;
 if(archived)run.carriedCost=(run.carriedCost||0)+cost-previous;
 const prices=[run.carriedCost,...run.steps.map(r=>r.cost)].filter(Number.isFinite);
 run.cost=prices.length?prices.reduce((sum,n)=>sum+n,0):null;return true;
}

export function createWebhookReceiver({bridge,secret}){
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  try{
   if(req.method==='GET'&&req.url==='/health')return res.writeHead(200,{'Content-Type':'text/plain'}).end('Webhook receiver OK\n');
   const match=/^\/webhooks\/videorouter\/([a-f0-9-]{36})$/.exec(req.url);
   if(req.method!=='POST'||!match)return res.writeHead(404).end();
   const key=secret();if(!key)return res.writeHead(503).end();
   const signature=req.headers['x-videorouter-signature'];
   if(typeof signature!=='string'||!/^([a-f0-9]{64})$/i.test(signature))return res.writeHead(401).end();
   let length=0;const chunks=[];
   for await(const chunk of req){length+=chunk.length;if(length>2*1024*1024){res.writeHead(413).end();return}chunks.push(chunk)}
   const raw=Buffer.concat(chunks),expected=createHmac('sha256',key).update(raw).digest();
   if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))return res.writeHead(401).end();
   res.writeHead(bridge.accept(match[1],req.headers['x-videorouter-event'],req.headers['x-videorouter-delivery'],raw.toString('utf8'))).end();
  }catch(error){if(!res.headersSent)res.writeHead(error instanceof SyntaxError?400:500);res.end()}
 });
 server.requestTimeout=10000;server.headersTimeout=10000;
 return server;
}

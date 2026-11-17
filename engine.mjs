import {randomUUID} from 'node:crypto';

export const asyncPaths = new Set(['/v1/videos','/v1/lipsync','/v1/meshes','/v1/jobs','/v1/batches','/v1/face-swap','/v1/avatars/videos']);
const forbidden = new Set(['__proto__','constructor','prototype']);

export function resolveFields(value, previous) {
  if (Array.isArray(value)) return value.map(v => resolveFields(v, previous));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k,v]) => {
      if (forbidden.has(k)) throw Error('Недопустимое имя поля');
      return [k, resolveFields(v, previous)];
    }));
  }
  if (typeof value !== 'string') return value;
  const match = /^\{\{(\d+)((?:\.[\w-]+)*)\}\}$/.exec(value);
  if (!match) return value;
  let item = previous[Number(match[1])-1];
  for (const key of match[2].split('.').slice(1)) item = item && Object.hasOwn(item,key) ? item[key] : undefined;
  if (item === undefined) throw Error('Ссылка на результат не найдена: '+value);
  return item;
}

export function buildRequest(route, params, key, readFile) {
  const fields = {...params};
  const path = route.path.replace(/\{(\w+)\}/g, (_,k) => {
    const v = fields[k];
    if (typeof v !== 'string' || !v.trim() || /^\.{1,2}$/.test(v) || /[/\\?#\x00-\x1f]/.test(v)) throw Error('Проверьте параметр пути '+k);
    delete fields[k];
    return encodeURIComponent(v);
  });
  const url = new URL('https://videorouter.sh/api'+path);
  const init = {method:route.method,headers:{Authorization:'Bearer '+key},redirect:'error'};
  const extraHeaders=fields.$headers;
  delete fields.$headers;
  const allowed=new Set(['http-referer','x-title','x-openrouter-title','x-openrouter-cache-ttl','x-openrouter-cache-clear','x-session-id','idempotency-key']);
  for(const [name,value] of Object.entries(extraHeaders||{})){
    if(!allowed.has(name.toLowerCase())) throw Error('Неподдерживаемый заголовок '+name);
    init.headers[name]=String(value);
  }
  if (route.method === 'GET' || route.method === 'DELETE' || route.method === 'WS') {
    for (const [k,v] of Object.entries(fields)) url.searchParams.set(k,String(v));
  } else if (route.encoding === 'multipart') {
    const form = new FormData();
    for (const [k,v] of Object.entries(fields)) {
      if (k==='file') {
        const file = readFile(v);
        form.append(k, new Blob([file.bytes],{type:file.type}),file.name);
      } else form.append(k,typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    if (!form.has('file')) throw Error('Выберите локальный файл');
    init.body = form;
  } else {
    init.headers['Content-Type']='application/json';
    init.body=JSON.stringify(fields);
  }
  return {url,init};
}

export async function execute({route,params,key,readFile,storeFile,request=fetch,onEvent}) {
  const {url,init}=buildRequest(route,params,key,readFile);
  init.signal=AbortSignal.timeout(15*60*1000);
  const response=await request(url,init);
  const type=(response.headers.get('content-type')||'application/octet-stream').split(';')[0];
  if (!response.ok) {
    const detail=(await response.text()).slice(0,1800);
    throw Error('VideoRouter HTTP '+response.status+': '+detail.replaceAll(key,'[key]'));
  }
  let data;
  if (type.includes('json') && !type.includes('ndjson')) data=await response.json();
  else if (type==='text/event-stream') {
    const stream=response.body.pipeThrough(new TextDecoderStream());
    let fragment='', result='';
    for await (const chunk of stream) {
      fragment+=chunk; result+=chunk;
      if (result.length>16*1024*1024) throw Error('Поток превысил 16 МБ');
      const lines=fragment.split('\n'); fragment=lines.pop();
      for (const line of lines) if(line.startsWith('data:')) onEvent?.(line.slice(5).trim().slice(0,2000));
    }
    data=storeFile(Buffer.from(result),'events.txt','text/plain');
  } else if (type.startsWith('text/') && !type.includes('csv')) data={text:await response.text()};
  else {
    const ext=({'audio/mpeg':'mp3','audio/wav':'wav','audio/ogg':'ogg','audio/flac':'flac','audio/mp4':'m4a','video/mp4':'mp4','application/x-ndjson':'jsonl','image/png':'png','image/jpeg':'jpg'})[type]||'bin';
    data=storeFile(Buffer.from(await response.arrayBuffer()),'result.'+ext,type);
  }
  const charge=response.headers.get('x-llmrouter-cost-usd');
  return {data,cost:charge!=null ? Number(charge) : data?.cost_usd ?? data?.usage?.cost ?? null};
}

export function checkSteps(steps,routes) {
  if (!Array.isArray(steps)||!steps.length||steps.length>100) throw Error('Workflow должен содержать от 1 до 100 шагов');
  for (const [i,step] of steps.entries()) {
    const route=routes.get(step.op);
    if (!route || route.method==='WS') throw Error('Операция недоступна в workflow: '+step.op);
    if (!step.params || typeof step.params!=='object' || Array.isArray(step.params)) throw Error('Укажите объект параметров');
    const visit=(value,key,path=key)=>{
      if(!value||typeof value!=='object')return;
      if(Object.hasOwn(value,'$artifact')){
        const ref=value.$artifact,source=steps.slice(0,i).find(s=>(s.sourceStepId||s.id)===ref?.stepId&&s.op==='POST /v1/images');
        const targetOK=step.op==='POST /v1/videos'&&path==='start_image_url'||step.op==='POST /v1/images'&&/^input_references\.0\.image_url\.url$/.test(path);
        if(!targetOK||ref?.type!=='image'||ref?.port!=='images'||!source||!Number.isInteger(ref.index)||ref.index<0||ref.index>=(source.params.n??1))throw Error('Неверная связь изображения со стартовым кадром');
      }else for(const [k,v] of Object.entries(value))visit(v,k,path?path+'.'+k:k);
    };visit(step.params);
    for(const match of JSON.stringify(step.params).matchAll(/"\{\{(\d+)(?:\.[\w-]+)*\}\}"/g))
      if (+match[1]<1 || +match[1]>i) throw Error('Шаг '+(i+1)+': ссылка должна указывать на предыдущий шаг');
  }
}

export function freshRun(name,steps,workflow) {
  const config={version:1,steps:structuredClone(steps)};
  if(workflow)config.workflow=structuredClone(workflow);
  return {id:randomUUID(),name,created:new Date().toISOString(),status:'running',config,
    steps:steps.map(({id,op,sourceStepId})=>({id:id||randomUUID(),op,sourceStepId,status:'waiting'})),cost:null};
}

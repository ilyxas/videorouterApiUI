import {videoProfile,modeOf,imageSizing} from './contracts.mjs';
export * from './graph.mjs';
export * from './workflow-state.mjs';
export * from './operations.mjs';
export {actionMatrix,lipProfiles,videoProfile,modeOf,contractFor,contractError,assertContract,assertQuoteMatches,contractDate,configureModelCatalog,modelsForAction,modelSupportsAction,imageSizing} from './contracts.mjs';
// Verified against VideoRouter API reference (images, video, pricing), 2026-11-17.
export const imageOperation='POST /v1/images';
export const videoOperation='POST /v1/videos';
export function normalizeRequest(operation,parameters){
 const p=structuredClone(parameters);
 if(operation===imageOperation){
  if(p.n==null)p.n=1;
  const defaults=imageSizing(p.model).defaults;
  if(p.quality==null&&defaults.quality)p.quality=defaults.quality;
  if(!p.size&&!p.resolution&&!p.aspect_ratio&&defaults.size)p.size=defaults.size;
  if(!Number.isInteger(p.n)||p.n<1)throw Error('Количество изображений должно быть положительным целым числом');
 }
 // Never substitute measured audio length for the requested video duration.
 return p;
}
export function hasPendingInput(value){
 if(typeof value==='string')return /^\{\{\d+(?:\.[\w-]+)*\}\}$/.test(value);
 if(value&&typeof value==='object')return Object.hasOwn(value,'$artifact')||Object.values(value).some(hasPendingInput);
 return false;
}
export function estimateRequest(operation,parameters,facts={}){
 const p=normalizeRequest(operation,parameters);
 if(hasPendingInput(p))throw Error('Оценка отложена: вход ещё не готов. Перед генерацией цена будет рассчитана по фактическому запросу.');
 if(operation==='POST /v1/lipsync'){
  if(!Number.isFinite(facts.audio)||facts.audio<=0)throw Error('Укажите длительность записи для оценки');
  if(p.video_url&&(!Number.isFinite(facts.video)||facts.video<=0))throw Error('Укажите длительность исходного видео');
  p.audio_secs=Math.max(facts.audio,facts.video||0);
 }
 return {...p,endpoint:operation.slice(operation.indexOf(' ')+1)};
}
// Preview never compiles/uploads/runs preceding steps. Omitted media is explicit.
export function previewEstimate(step,facts={}){
 const omitted=[];
 function clean(value,path){
  if(value==null||value===''||hasPendingInput(value)){if(value!=null)omitted.push(path);return undefined}
  return structuredClone(value);
 }
 const p={};for(const [key,value] of Object.entries(step.params)){
  const v=clean(value,key);if(v!==undefined)p[key]=v;
 }
 for(const [key,src] of Object.entries(step.media||{})){
  const actual=key==='reference_image'?'input_references':key;delete p[actual];
  if(src.mode==='none')continue;
  if(src.mode==='list'){
   const type=key==='input_video_references'?'video':key==='input_audio_references'?'audio':'image';
   const ready=src.items.filter(v=>v?.mode==='url'&&v.url?.trim()).map(v=>({type:type+'_url',[type+'_url']:{url:v.url.trim()}}));
   if(ready.length)p[actual]=ready;if(ready.length<src.items.length)omitted.push(actual);continue;
  }
  if(src.mode==='url'&&src.url?.trim()){
   if(key==='reference_image')p.input_references=[{type:'image_url',image_url:{url:src.url.trim()}}];
   else p[key]=src.url.trim();
  }else omitted.push(actual);
 }
 const request={...normalizeRequest(step.op,p),endpoint:step.op.slice(step.op.indexOf(' ')+1)};
 for(const [key,value] of Object.entries(facts))if(['input_video_secs','input_width','input_height','reference_video_secs'].includes(key)&&Number.isFinite(value)&&value>0)request[key]=value;
 if(step.op==='POST /v1/lipsync'){
  if(Number.isFinite(facts.audio)&&facts.audio>0)request.audio_secs=Math.max(facts.audio,facts.video||0);
  else omitted.push('audio_secs');
 }
 return {request,omitted:[...new Set(omitted)]};
}
export function supportsImageInput(model,catalog){
 if(videoProfile(model))return true;
 const m=catalog.find(m=>m.id===model);
 if(typeof m?.capabilities?.start_image_url==='boolean')return m.capabilities.start_image_url;
 return (m?.cap||'').split(' ').includes('image-to-video');
}
export function validateImageBindings(steps,catalog){
 for(const [i,s] of steps.entries())for(const [key,src] of Object.entries(s.media||{})){
  if(src.mode!=='previous'||!src.stepId)continue;
  const index=steps.findIndex(row=>row.id===src.stepId),origin=steps[index];
  if(index<0||index>=i)throw Error('Шаг '+(i+1)+': связь должна указывать на существующий предыдущий шаг');
  const targetOK=s.op===videoOperation&&key==='start_image_url'||s.op===imageOperation&&['image-edit','image-upscale'].includes(modeOf(s))&&key==='reference_image';
  if(origin.op!==imageOperation||src.port!=='images'||!targetOK)throw Error('Несовместимые типы: изображение можно связать со стартовым кадром видео');
  if(!Number.isInteger(src.index)||src.index<0||src.index>=(origin.params.n??1))throw Error('Выберите доступный номер изображения');
  if(s.op===videoOperation&&!supportsImageInput(s.params.model,catalog))throw Error('Поддержка стартового изображения этой моделью не подтверждена. Связь сохранена; выберите совместимую модель.');
 }
}
export function publicMediaURL(value){
 let url;try{url=new URL(value)}catch{throw Error('Результат не содержит корректную HTTPS-ссылку')}
 if(url.protocol!=='https:'||url.username||url.password||/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(url.hostname)||url.hostname.endsWith('.local'))throw Error('Для передачи модели требуется публичная HTTPS-ссылка');
 return url.href;
}

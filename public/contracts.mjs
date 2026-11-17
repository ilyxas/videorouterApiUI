// Supported Studio subset. Unknown profiles/settings stay unavailable, not inferred from prices.
export const contractDate='2026-11-17';
const image='POST /v1/images',video='POST /v1/videos',lip='POST /v1/lipsync';
export const actionMatrix={
 'text-to-image':{name:'Создать изображение',op:image,models:['gpt-image-1','openai/gpt-image-1'],fields:['prompt','model','n'],input:null,output:'image',source:'api-reference-images'},
 'image-edit':{name:'Редактировать изображение',op:image,models:['gemini-2.5-flash-image'],fields:['prompt','model'],input:'input_references',output:'image',source:'image-edit'},
 'image-upscale':{name:'Увеличить изображение',op:image,models:['fal/recraft-crisp-upscale'],fields:['model'],input:'input_references',output:'image',source:'image-upscaling'},
 'text-to-video':{name:'Видео по тексту',op:video,output:'video',source:'api-reference-video'},
 'image-to-video':{name:'Видео по изображению',op:video,input:'start_image_url',output:'video',source:'api-reference-video'},
 'audio-to-video':{name:'Видео по аудио',op:video,input:'input_audio_url',output:'video',source:'api-reference-video'},
 'reference-to-video':{name:'Видео по референсам',op:video,unavailable:'Нужны проверенные лимиты и роли нескольких референсов для конкретной модели.'},
 'video-edit':{name:'Редактировать видео',op:video,unavailable:'Контракт модели и метаданные исходного видео ещё не подключены к удобному редактору.'},
 'video-extend':{name:'Продлить видео',op:video,unavailable:'Требуется отдельный контракт продолжения выбранной модели.'},
 'motion-control':{name:'Перенести движение',op:video,unavailable:'Не подключены ограничения управляющего видео и визуального источника.'},
 'video-upscale':{name:'Увеличить видео',op:video,unavailable:'Нужны проверенные размеры и длительность исходного видео.'}
};
export const lipProfiles={
 'vidu/s1-avatar-offline':{input:'image_url',resolutions:['540p','720p']},
 'atlascloud/infinitetalk':{input:'image_url',resolutions:['480p','720p']},
 'fal/h3-max-lipsync':{input:'image_url',resolutions:[]},
 'fal/sync-lipsync-v3-image':{input:'image_url'},
 'fal/heygen-avatar4-image-to-video':{input:'image_url'},
 'fal/omnihuman-v2':{input:'image_url',prompt:true,audioMin:4,audioMax:300},
 'atlascloud/omnihuman-v2':{input:'image_url',prompt:true,resolutions:['720p'],audioMin:4,audioMax:300},
 'boson/higgs-avatar':{input:'image_url',resolutions:['640x640','640x480','480x640'],ratios:['1:1','4:3','3:4'],audioMax:60},
 ...Object.fromEntries(['fal/sync-lipsync-v3','fal/sync-lipsync-react-1','fal/sync-lipsync-v2-pro','fal/sync-lipsync','fal/sync-lipsync-v2','fal/veed-lipsync-v2','fal/heygen-v3-lipsync-precision','fal/heygen-v3-lipsync-speed'].map(id=>[id,{input:'video_url',...(id==='fal/sync-lipsync-react-1'?{audioMax:15,videoMax:15}:{})}]))
};
export function videoProfile(model=''){
 const match=/^(?:(lightricks|fal)\/)?ltx-2\.5-(fast|pro)(?:\/(lightricks|fal))?$/.exec(model);
 if(!match)return null;
 return {inputs:['start_image_url','end_image_url',...(match[1]==='fal'||match[3]==='fal'?[]:['input_audio_url'])],resolutions:match[2]==='fast'?['720p','1080p','1440p','2160p']:['720p','1080p'],ratios:['16:9','9:16','1:1'],hosts:['lightricks','fal'],source:'https://videorouter.sh/video/lightricks/ltx-2.5-'+match[2]};
}
// Endpoint catalog is shared by the browser and server; profiles supplement it.
let modelCatalog=new Map();
export function configureModelCatalog(...lists){
 modelCatalog=new Map();
 for(const row of lists.flat())modelCatalog.set(row.id,{...modelCatalog.get(row.id),...row});
}
export function imageSizing(model=''){
 if(/^(?:openai\/)?gpt-image-(?:1(?:\.5|-mini)?)(?:\/openai)?$/.test(model))return {sizes:['1024x1024','1024x1536','1536x1024'],qualities:['low','medium','high'],defaults:{size:'1024x1024',quality:'medium'}};
 if(/^(?:openai\/)?dall-e-3(?:\/openai)?$/.test(model))return {sizes:['1024x1024','1024x1792','1792x1024'],qualities:['standard','hd'],defaults:{size:'1024x1024',quality:'standard'}};
 if(/^(?:openai\/)?dall-e-2(?:\/openai)?$/.test(model))return {sizes:['256x256','512x512','1024x1024'],qualities:[],defaults:{size:'1024x1024'}};
 return {sizes:[],qualities:[],defaults:{}};
}
export function modelSupportsAction(id,mode){
 const a=actionMatrix[mode];if(!a||a.unavailable)return false;
 if(a.models?.includes(id))return true;
 const profile=videoProfile(id);
 if(profile&&a.op===video)return !a.input||profile.inputs.includes(a.input);
 const row=modelCatalog.get(id);if(!row)return false;
 const endpoint=row.endpoint?.replace('/api/v1/','/v1/');
 if(endpoint&&endpoint!==a.op.slice(5))return false;
 if(!endpoint&&(row.category||row.type)!==(a.op===image?'image':'video'))return false;
 const caps=(row.cap||'').split(' ').filter(Boolean);
 if(mode==='image-to-video'&&typeof row.capabilities?.start_image_url==='boolean')return row.capabilities.start_image_url;
 if(mode==='audio-to-video')return false; // API documents single audio input only for LTX.
 if(caps.length)return caps.includes(mode);
 // Bare endpoint rows use its default text mode, excluding explicitly specialized slugs.
 return ['text-to-image','text-to-video'].includes(mode)&&!/(?:edit|upscal|try.?on|inpaint|keyframe|image-to-video|i2v)/i.test(id);
}
export function modelsForAction(mode){
 const a=actionMatrix[mode],rows=new Map(modelCatalog);
 for(const id of a?.models||[])if(!rows.has(id))rows.set(id,{id});
 if(a?.op===video)for(const id of ['lightricks/ltx-2.5-fast','lightricks/ltx-2.5-pro'])if(!rows.has(id))rows.set(id,{id});
 return [...rows.values()].filter(row=>modelSupportsAction(row.id,mode)).sort((a,b)=>a.id.localeCompare(b.id));
}
function catalogVideoProfile(model,mode){
 if(!modelSupportsAction(model,mode))return null;
 const row=modelCatalog.get(model),caps=row?.capabilities||{};
 return {inputs:[...(caps.start_image_url===true||modelSupportsAction(model,'image-to-video')?['start_image_url']:[]),...(caps.end_image_url===true?['end_image_url']:[])],resolutions:['480p','540p','720p','1080p','1440p','2160p','4k'],ratios:['16:9','9:16','1:1','4:3','3:4','21:9'],hosts:null,source:'api-reference-video',catalog:true};
}
export function modeOf(step){
 if(step.action)return step.action;
 if(step.op===image)return step.params.input_references?'image-edit':'text-to-image';
 const active=key=>{const src=step.media?.[key];if(!src)return Boolean(step.params[key]);return src.mode==='url'?Boolean(src.url?.trim()):src.mode==='file'?Boolean(src.file):src.mode==='previous'?Boolean(src.stepId||src.ref):src.mode==='speech'?Boolean(src.text?.trim()):false};
 if(step.op===video)return active('input_audio_url')?'audio-to-video':active('start_image_url')?'image-to-video':'text-to-video';
 return step.op;
}
export function contractFor(step){
 const mode=modeOf(step),action=actionMatrix[mode];
 if(action?.unavailable)return {unavailable:action.unavailable};
 if(step.op===image){
  if(!action||!modelSupportsAction(step.params.model,mode))return {unavailable:'Для этого действия контракт модели не проверен.'};
  return {...action,mode,allowed:['model','n',...action.fields,...(mode==='image-upscale'?[]:['size','quality','aspect_ratio','resolution']),...(action.input?[action.input]:[])],required:[...(mode==='image-upscale'?[]:['prompt']),...(action.input?[action.input]:[])],...imageSizing(step.params.model),resolutions:['512','1K','2K','4K','1k','2k','4k'],ratios:['1:1','16:9','9:16','4:3','3:4','3:2','2:3','21:9'],maxReferences:action.input?1:0};
 }
 if(step.op===video){
  const profile=videoProfile(step.params.model)||catalogVideoProfile(step.params.model,mode);
  if(!profile)return {unavailable:'Режим этой видеомодели не подтверждён каталогом. Выберите модель для текущего действия.'};
  return {...profile,mode,allowed:['model','prompt','duration_secs','resolution','aspect_ratio','n','provider','failover',...profile.inputs],required:['prompt',...(action?.input?[action.input]:[])]};
 }
 if(step.op===lip){
  const profile=lipProfiles[step.params.model];
  if(!profile)return {unavailable:'Контракт этой lip-sync модели не проверен.'};
  return {...profile,allowed:['model','audio_url',profile.input,...(profile.prompt?['prompt']:[]),...(profile.resolutions?.length?['resolution']:[]),...(profile.ratios?['aspect_ratio']:[])],required:['audio_url',profile.input],source:'lip-sync'};
 }
 if(step.op==='POST /v1/audio/speech')return ['tts-1','tts-1-hd'].includes(step.params.model)?{allowed:['model','input','voice','response_format','speed'],required:['input'],formats:['mp3','opus','aac','flac','wav','pcm'],source:'api-reference-audio'}:{unavailable:'Словарь голосов этой модели не проверен. Доступны tts-1 и tts-1-hd.'};
 if(step.op==='POST /v1/audio/transcriptions')return step.params.model==='whisper-1'?{allowed:['model','file','response_format'],required:['file'],formats:['json','text','verbose_json'],source:'api-reference-audio'}:{unavailable:'Контракт модели расшифровки не проверен.'};
 if(step.op==='POST /v1/uploads')return {allowed:['file'],required:['file'],source:'api-reference'};
 return null; // Explicit API Explorer operations keep their raw API contract.
}
function locatorOK(value,imageOnly=false){
 if(value&&typeof value==='object')return Boolean(value.$artifact);
 if(typeof value!=='string')return false;
 if(/^\{\{\d+(?:\.[\w-]+)*\}\}$/.test(value))return true;
 if(imageOnly&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value))return true;
 try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/.test(url.hostname)&&!url.hostname.endsWith('.local')}catch{return false}
}
export function contractError(step,parameters=step.params,{complete=false,facts={}}={}){
 const c=contractFor(step),p=parameters;
 if(!c)return '';
 if(c.unavailable)return c.unavailable;
 const error=message=>'Шаг «'+(actionMatrix[modeOf(step)]?.name||step.op)+'»: '+message;
 for(const key of Object.keys(p))if(!c.allowed.includes(key))return error('поле '+key+' не подтверждено для этой модели/действия. Значение сохранено; исправьте в параметрах.');
 for(const key of c.required)if(complete&&(p[key]==null||p[key]===''||(Array.isArray(p[key])&&!p[key].length)))return error('заполните '+key);
 if(p.prompt!=null&&(typeof p.prompt!=='string'||!p.prompt.trim())&&complete)return error('заполните описание');
 if(p.n!=null&&(!Number.isInteger(p.n)||p.n<1||(step.op===image&&modeOf(step)!=='text-to-image'&&p.n!==1)))return error('недопустимое количество результатов');
 for(const [key,values] of [['resolution',c.resolutions],['aspect_ratio',c.ratios],['response_format',c.formats]])if(p[key]!=null&&!values?.includes(p[key]))return error('значение '+key+' = '+p[key]+' не подтверждено');
 if(p.size!=null&&(typeof p.size!=='string'||!/^\d+x\d+$/.test(p.size)||(c.sizes?.length&&!c.sizes.includes(p.size))))return error('неподдерживаемый размер изображения');
 if(p.quality!=null&&c.qualities?.length&&!c.qualities.includes(p.quality))return error('неподдерживаемое качество изображения');
 if(p.duration_secs!=null&&(!Number.isFinite(p.duration_secs)||p.duration_secs<=0))return error('длительность должна быть положительным числом');
 if(step.op===image&&p.input_references){
  if(!Array.isArray(p.input_references)||p.input_references.length!==1)return error('нужно ровно одно исходное изображение');
  if(p.input_references.some(v=>v?.type!=='image_url'||!v.image_url?.url))return error('неверная структура ссылки на изображение');
 }
 for(const key of ['start_image_url','end_image_url','input_audio_url','audio_url','image_url','video_url'])if(p[key]!=null&&!locatorOK(p[key],['start_image_url','end_image_url'].includes(key)))return error('некорректный тип или адрес '+key);
 if(p.input_references?.some(v=>!locatorOK(v.image_url.url,true)))return error('некорректный адрес исходного изображения');
 if(p.file!=null&&(typeof p.file!=='string'||!p.file))return error('нужен ID локального файла');
 if(p.input!=null&&(typeof p.input!=='string'||!p.input.trim()))return error('нужен текст для озвучки');
 if(p.speed!=null&&(!Number.isFinite(p.speed)||p.speed<0.25||p.speed>4))return error('speed должен быть от 0.25 до 4');
 if(step.op===video&&p.input_audio_url&&p.provider?.only?.every(host=>host==='fal'))return error('аудиовход LTX недоступен при ограничении только fal');
 if(p.provider!=null){
  if(typeof p.provider!=='object'||Array.isArray(p.provider))return error('provider должен быть объектом');
  for(const key of Object.keys(p.provider))if(!['only','order','ignore','allow_fallbacks'].includes(key))return error('непроверенная настройка provider.'+key);
  for(const key of ['only','order','ignore'])if(p.provider[key]!=null&&(!Array.isArray(p.provider[key])||!p.provider[key].length||p.provider[key].some(v=>typeof v!=='string'||!v||(c.hosts&&!c.hosts.includes(v)))))return error('провайдер не подтверждён');
  if(p.provider.allow_fallbacks!=null&&typeof p.provider.allow_fallbacks!=='boolean')return error('allow_fallbacks должен быть boolean');
 }
 if(p.failover&&(typeof p.failover!=='object'||Array.isArray(p.failover)||Object.keys(p.failover).some(k=>k!=='on_timeout_sec')||!Number.isFinite(p.failover.on_timeout_sec)||p.failover.on_timeout_sec<=0))return error('неверная настройка failover');
 if(step.op==='POST /v1/audio/speech'&&p.voice&&!['alloy','nova','shimmer','echo','onyx','fable'].includes(p.voice))return error('голос не подтверждён для OpenAI TTS');
 if(step.op===lip&&complete){
  for(const key of ['audio','video']){
   if((c[key+'Min']||c[key+'Max'])&&(!Number.isFinite(facts[key])||facts[key]<=0))return error('укажите длительность '+key+' в оценке шага');
   if(facts[key]!=null&&((c[key+'Min']&&facts[key]<c[key+'Min'])||(c[key+'Max']&&facts[key]>c[key+'Max'])))return error('длительность '+key+' вне ограничений модели');
  }
 }
 return '';
}
export function assertContract(step,parameters,options){const error=contractError(step,parameters,options);if(error)throw Error(error)}
export function assertQuoteMatches(parameters,quote){
 for(const key of ['duration_secs','resolution','aspect_ratio','n','size','width','height']){
  if(parameters[key]!=null&&quote.assumptions?.[key]!=null&&String(parameters[key]).toLowerCase()!==String(quote.assumptions[key]).toLowerCase())throw Error('Оценка изменила '+key+': '+parameters[key]+' → '+quote.assumptions[key]+'. Генерация остановлена; исправьте параметры.');
 }
}

import {grokModels,isGrok,validateGrok} from './grok-profile.mjs';
import {modeOf, modelSupportsAction, imageSizing} from './contracts.mjs';

const image='POST /v1/images', video='POST /v1/videos', chat='POST /v1/chat/completions';
const input=(type,required=false,multiple=false)=>({type,required,multiple});
const imageRefs=input('image',true,true), videoRefs=input('video',true,true);
const define=(kind,op,name,fields,inputs={},extra={})=>({kind,op,name,fields,inputs,...extra});
export const operations={
 'text-to-image':define('image',image,'Создать изображение',['prompt','model','n','size','quality','resolution','aspect_ratio']),
 'image-edit':define('image',image,'Редактировать изображение',['prompt','model','n','size','quality'],{input_references:imageRefs}),
 'image-upscale':define('image',image,'Увеличить изображение',['model','scale_factor'],{input_references:imageRefs},{maxReferences:1,promptOptional:true}),
 'virtual-try-on':define('image',image,'Примерить одежду',['model','prompt'],{input_references:imageRefs},{minReferences:2,promptOptional:true}),
 'text-to-video':define('video',video,'Видео по тексту',['prompt','model','duration_secs','resolution','aspect_ratio']),
 'image-to-video':define('video',video,'Видео по изображению',['prompt','model','duration_secs','resolution','aspect_ratio'],{start_image_url:input('image',true),end_image_url:input('image')}),
 'audio-to-video':define('video',video,'Видео по аудио',['prompt','model','duration_secs','resolution','aspect_ratio'],{input_audio_url:input('audio',true),start_image_url:input('image'),end_image_url:input('image')}),
 'reference-to-video':define('video',video,'Видео по референсам',['prompt','model','duration_secs','resolution','aspect_ratio','task_type'],{input_references:input('image',false,true),input_video_references:input('video',false,true),input_audio_references:input('audio',false,true)}),
 'video-edit':define('video',video,'Редактировать видео',['prompt','model'],{input_video_url:input('video',true)}),
 'video-extend':define('video',video,'Продлить видео',['prompt','model','duration_secs','resolution'],{input_video_references:videoRefs},{maxReferences:1}),
 'motion-control':define('video',video,'Перенести движение',['model','prompt'],{start_image_url:input('image',true),input_video_url:input('video'),input_video_references:input('video',false,true)},{promptOptional:true,maxReferences:1}),
 'video-upscale':define('video',video,'Увеличить видео',['model','scale_factor','resolution','fps'],{input_video_url:input('video',true)},{promptOptional:true}),
 'keyframes':define('video',video,'Видео по ключевым кадрам',['model','prompt','duration_secs','resolution','keyframes'],{},{}),
 'draft-final':define('video',video,'Финал из draft',['model','draft_id'],{},{promptOptional:true}),
 'lip-sync':define('video','POST /v1/lipsync','Синхронизация губ',['model','resolution','prompt'],{audio_url:input('audio',true),image_url:input('image'),video_url:input('video')},{promptOptional:true,urlOnly:true}),
 'face-swap':define('video','POST /v1/face-swap','Замена лица',['model','source_face_consent','resolution'],{video_url:input('video',true),face_image_url:input('image',true)},{promptOptional:true,urlOnly:true}),
 'avatar':define('video','POST /v1/avatars/videos','Говорящий аватар',['model','avatar_id','script','voice_id','source_face_consent','resolution','aspect_ratio'],{image_url:input('image'),audio_url:input('audio')},{promptOptional:true,urlOnly:true}),
 'speech':define('audio','POST /v1/audio/speech','Озвучить текст',['model','input','voice','response_format','speed']),
 'music':define('audio','POST /v1/audio/music','Музыка',['model','prompt','lyrics','instrumental','duration','response_format']),
 'sfx':define('audio','POST /v1/audio/sfx','Звуковые эффекты',['model','prompt','duration'],{video_url:input('video')},{urlOnly:true}),
 'chat-image':define('image',chat,'Изображение через Chat',['model','messages','modalities']),
 'chat-audio':define('audio',chat,'Аудио через Chat',['model','messages','modalities','audio']),
 'transcription':define('text','POST /v1/audio/transcriptions','Расшифровать запись',['model','response_format'],{file:input('audio',true)},{multipart:true}),
 'chat-text':define('text',chat,'Текст через Chat',['model','messages']),
 'api':define('api',null,'API запрос',[])
};
let catalog=[];
export function configureOperations(rows){const merged=new Map();for(const row of [...(rows||[]),...grokModels])merged.set(row.id,{...merged.get(row.id),...row});catalog=[...merged.values()]}
export function operationIdFor(s){
 if(s.operationId)return s.operationId;
 if(s.action&&operations[s.action])return s.action;
 if(s.op===image){if(s.params?.input_references)return /upscal|aura-sr/.test(s.params.model)?'image-upscale':/try.?on|vto/.test(s.params.model)?'virtual-try-on':'image-edit';return modeOf(s)}
 if(s.op===video){const p=s.params||{};if(p.draft_id)return 'draft-final';if(p.keyframes)return 'keyframes';if(/motion-control/.test(p.model))return 'motion-control';if(p.input_video_url)return /upscal/.test(p.model)?'video-upscale':'video-edit';if(p.input_video_references?.length&&(/extend/.test(p.model)||p.task_type==='extend'))return 'video-extend';if(p.input_references?.length||p.input_video_references?.length||p.input_audio_references?.length)return 'reference-to-video';return modeOf(s)}
 if(s.op===chat)return s.params?.modalities?.includes('image')?'chat-image':s.params?.modalities?.includes('audio')?'chat-audio':'chat-text';
 return Object.keys(operations).find(k=>operations[k].op===s.op)||'api';
}
export function operationFor(node){return operations[node.operationId]||operations.api}
export function modelChoices(operationId,rows=catalog){
 const d=operations[operationId];if(!d)return [];
 return [...new Map([...rows,...grokModels].map(m=>[m.id,m])).values()].filter(m=>{
  const endpoint=m.endpoint?.replace(/^\/api\//,'/');
  const cap=(m.cap||'').split(' ');
  if(endpoint&&endpoint!==d.op?.slice(5))return false;
  if(['chat-image','chat-audio'].includes(operationId))return operationId==='chat-image'?/gemini.*(?:image|banana)/.test(m.id):/gpt-audio/.test(m.id);
  if(d.op===image||d.op===video){
   if(m.capabilities?.[({ 'image-to-video':'start_image_url','reference-to-video':'input_references','keyframes':'keyframes' })[operationId]]===false)return false;
   const documentedEdit=operationId==='image-edit'&&/^(?:openai\/)?gpt-image-(?:1(?:\.5|-mini)?|2(?:\.5-[\w-]+)?)(?:\/openai)?$/.test(m.id);
   const documentedReferences=operationId==='reference-to-video'&&/^(?:fal\/|bytedance\/)?seedance-2\.(?:0|5)(?:-(?:fast|mini))?(?:\/fal)?$/.test(m.id);
   return documentedEdit||documentedReferences||cap.includes(operationId)||modelSupportsAction(m.id,operationId)||operationId==='draft-final'&&/seedance-2\.5/.test(m.id)||operationId==='keyframes'&&m.capabilities?.keyframes===true;
  }
  return endpoint===d.op?.slice(5)||(m.type||m.category)===({speech:'speech',music:'music',sfx:'sfx',transcription:'transcription','lip-sync':'lipsync','face-swap':'face_swap',avatar:'avatar','chat-text':'chat'})[operationId]||cap.includes(operationId)||operationId==='avatar'&&cap.includes('talking-avatar');
 });
}
export function validateOperation(node,p,{complete=false}={}){
 const d=operationFor(node);if(d.kind==='api')return;
 if(isGrok(p.model)){validateGrok(node.operationId,p,{complete});return}
 const required=key=>{if(complete&&(p[key]==null||p[key]===''||Array.isArray(p[key])&&!p[key].length))throw Error('Заполните '+key)};
 required('model');
 if(d.fields.includes('prompt')&&!d.promptOptional&&!(node.operationId==='sfx'&&p.video_url))required('prompt');
 if(node.operationId==='speech')required('input');
 if(node.operationId.startsWith('chat-'))required('messages');
 if(node.operationId==='draft-final')required('draft_id');
 for(const [key,port] of Object.entries(d.inputs)){
  if(port.required)required(key);
  if(p[key]!=null&&port.multiple){
   if(!Array.isArray(p[key]))throw Error(key+': требуется массив');
   if(d.maxReferences&&p[key].length>d.maxReferences)throw Error(key+': слишком много референсов');
   for(const x of p[key])if(x?.type!==port.type+'_url'||!x[port.type+'_url']?.url)throw Error(key+': неверный тип референса');
  }
 }
 if(p.n!=null&&(!Number.isInteger(p.n)||p.n<1))throw Error('Количество результатов должно быть положительным целым');
 if(node.operationId==='reference-to-video'&&complete){
  const counts=['input_references','input_video_references','input_audio_references'].map(k=>p[k]?.length||0);
  if(!counts.some(Boolean))throw Error('Добавьте хотя бы один референс');
  if(counts[0]>9||counts[1]>3||counts[2]>3||counts.reduce((a,b)=>a+b,0)>12)throw Error('Превышен лимит референсов');
  if(p.start_image_url||p.input_video_url)throw Error('Референсы нельзя смешивать со стартовым кадром или video edit');
  if(/machgen/.test(p.model)&&!/seedance/.test(p.model)&&(counts[0]>7||counts[1]||counts[2]))throw Error('Этот reference-профиль MachGen принимает до 7 изображений');
 }
 if(node.operationId==='virtual-try-on'&&complete&&(p.input_references?.length||0)<2)throw Error('Нужны фото человека и одежды, в таком порядке');
 if(node.operationId==='lip-sync'&&complete&&Boolean(p.image_url)===Boolean(p.video_url))throw Error('Выберите портрет или видео для lip-sync');
 if(node.operationId==='motion-control'&&complete&&Boolean(p.input_video_url)===Boolean(p.input_video_references?.length))throw Error('Выберите один вариант управляющего видео');
 if(node.operationId==='avatar'&&complete){if(Boolean(p.avatar_id)===Boolean(p.image_url))throw Error('Выберите avatar_id или изображение');if(Boolean(p.script)===Boolean(p.audio_url))throw Error('Выберите script или аудио');if(p.script)required('voice_id')}
 if((node.operationId==='face-swap'||node.operationId==='avatar'&&p.image_url)&&complete&&p.source_face_consent!==true)throw Error('Подтвердите право использования лица: source_face_consent');
 if(node.operationId==='audio-to-video'&&(!/ltx-2\.5/.test(p.model)||p.provider?.only?.every(h=>h==='fal')))throw Error('Одиночный аудиовход доступен у LTX 2.5 вне fal-only');
 if(d.op===video&&['video-edit','video-upscale'].includes(node.operationId)&&['start_image_url','input_references','input_video_references','input_audio_references','input_audio_url'].some(k=>p[k]))throw Error('Несовместимые входы video edit/upscale');
 if(d.op===video&&p.duration_secs!=null&&(!Number.isFinite(p.duration_secs)||p.duration_secs<=0))throw Error('Некорректная длительность');
 const sizes=imageSizing(p.model);if(d.op===image&&sizes.qualities.length&&p.quality&&!sizes.qualities.includes(p.quality))throw Error('Недопустимое качество изображения');
 const known=catalog.find(m=>m.id===p.model);
 for(const k of Object.keys(d.inputs))if(p[k]!=null&&known?.capabilities?.[k]===false)throw Error('Модель не поддерживает '+k);
 // Catalog action facts are authoritative when present; endpoint-only rows remain usable.
 if(known?.cap&&[image,video].includes(d.op)&&!modelChoices(node.operationId,[known]).length)throw Error('Каталог не подтверждает выбранный режим модели');
}

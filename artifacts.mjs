import {publicMediaURL} from './public/workflow-core.mjs';
function imageType(bytes){
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
 throw Error('Неподдерживаемый или повреждённый формат изображения');
}
export function imageArtifacts(result,runId,stepId,storeFile){
 if(!Array.isArray(result?.data)||!result.data.length)throw Error('Ответ генерации не содержит изображений');
 return result.data.map((item,index)=>{
  const artifact={id:runId+':'+stepId+':'+index,type:'image',runId,stepId,port:'images',index};
  if(item.b64_json){
   if(typeof item.b64_json!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(item.b64_json)||item.b64_json.length>20*1024*1024)throw Error('Некорректное или слишком большое изображение base64');
   const bytes=Buffer.from(item.b64_json,'base64'),mime=imageType(bytes);
   Object.assign(artifact,storeFile(bytes,'image-'+(index+1)+'.'+mime.split('/')[1],mime),{type:'image',mime});
   // Keep the response useful without duplicating the base64 payload in SQLite.
   delete item.b64_json;Object.assign(item,{file:artifact.file,local_url:artifact.local_url});
  }else artifact.url=publicMediaURL(item.url);
  const expires=item.output_expires_at??result.output_expires_at;
  if(expires!=null)artifact.expiresAt=typeof expires==='number'?expires*1000:Date.parse(expires);
  return artifact;
 });
}
export function resolveArtifacts(value,artifacts,readFile){
 if(Array.isArray(value))return value.map(v=>resolveArtifacts(v,artifacts,readFile));
 if(!value||typeof value!=='object')return value;
 if(Object.hasOwn(value,'$artifact')){
  const ref=value.$artifact,artifact=artifacts.get(ref.stepId)?.[ref.index];
  if(!artifact||artifact.type!=='image')throw Error('Выбранное изображение не получено; зависимый шаг заблокирован');
  if(artifact.expiresAt!=null&&(!Number.isFinite(artifact.expiresAt)||artifact.expiresAt<=Date.now()))throw Error('Срок доступности изображения истёк');
  if(artifact.file){
   const file=readFile(artifact.file),mime=imageType(file.bytes);
   return 'data:'+mime+';base64,'+file.bytes.toString('base64');
  }
  return publicMediaURL(artifact.url);
 }
 return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,resolveArtifacts(v,artifacts,readFile)]));
}

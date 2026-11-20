const clone=value=>structuredClone(value);
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
const roles={image:'reference',audio:'voice',video:'base-video'};
export function dataCardAssetRole(kind,type){return kind==='location'&&type==='audio'?'ambience':roles[type]}

export class DataCard {
 constructor(definition){if(new.target===DataCard)throw Error('DataCard is abstract');this.definition=clone(definition)}
 get id(){return this.definition.id}
 get assets(){return this.definition.assets}
 toJSON(){return clone(this.definition)}
}
export class CharacterCard extends DataCard {}
export class LocationCard extends DataCard {}
export function dataCardFactory(definition){
 if(definition.kind==='character')return new CharacterCard(definition);
 if(definition.kind==='location')return new LocationCard(definition);
 throw Error('Unsupported DataCard kind');
}
export function normalizeDataCards(cards=[]){
 if(!Array.isArray(cards))throw Error('dataCards must be an array');
 const seen=new Set();
 return cards.map(card=>{
  if(!card||!validId(card.id)||seen.has(card.id))throw Error('DataCard IDs must be unique');seen.add(card.id);
  if(!['character','location'].includes(card.kind)||typeof card.name!=='string'||!card.name.trim()||card.name.length>150)throw Error('A DataCard needs a name and supported kind');
  if(!Array.isArray(card.assets))throw Error('DataCard assets must be an array');
  const ids=new Set(),result={id:card.id,kind:card.kind,name:card.name};
  const exclusive=card.kind==='character'?'layout':'age';if(card[exclusive]!=null)throw Error(exclusive+' is not a field of '+card.kind);
  for(const key of ['description',card.kind==='character'?'age':'layout','appearance','scenario']){
   if(card[key]!=null&&typeof card[key]!=='string')throw Error('DataCard '+key+' must be text');
   result[key]=card[key]||'';
  }
  result.assets=card.assets.map(asset=>{
   if(!asset||!validId(asset.id)||ids.has(asset.id))throw Error('Asset IDs must be unique within a DataCard');ids.add(asset.id);
   if(!Object.hasOwn(roles,asset.type)||asset.role!==dataCardAssetRole(card.kind,asset.type))throw Error('Asset media type and role must agree with the DataCard kind');
   if(typeof asset.name!=='string'||!asset.name.trim()||typeof asset.description!=='string')throw Error('Assets need a name and description');
   if(asset.fileId!=null&&!validId(asset.fileId))throw Error('Invalid local file ID');
   const item={id:asset.id,name:asset.name,description:asset.description,type:asset.type,role:asset.role};
   if(asset.fileId)item.fileId=asset.fileId;
   if(asset.missing||!asset.fileId)item.missing=true;
   for(const key of ['width','height','duration'])if(asset[key]!=null){if(!Number.isFinite(asset[key])||asset[key]<=0)throw Error('Invalid asset '+key);item[key]=asset[key]}
   return item;
  });
  return dataCardFactory(result).toJSON();
 });
}
export function characterAsset(cards,binding,type){
 const card=cards?.find(c=>c.id===binding.dataCardId);
 const asset=card?.assets.find(a=>a.id===binding.assetId);
 if(!asset)throw Error('DataCard asset not found: '+binding.dataCardId+'/'+binding.assetId);
 if(type&&type!=='*'&&asset.type!==type)throw Error('DataCard asset type does not match input: '+asset.name);
 return asset;
}
export function resolveCharacterAsset(cards,binding,type,{readAsset}={}){
 const asset=characterAsset(cards,binding,type);
 if(asset.missing||!asset.fileId)throw Error('Reattach DataCard asset: '+asset.name);
 if(readAsset){const stored=readAsset(asset.fileId);if(!stored.type?.startsWith(asset.type+'/'))throw Error('Stored DataCard asset has an incompatible media type: '+asset.name)}
 return {assetId:asset.fileId,name:asset.name,...(asset.width?{width:asset.width,height:asset.height}:{}),...(asset.duration?{duration:asset.duration}:{})};
}
export function reconnectDataCards(cards,lookup,warnings=[]){
 return normalizeDataCards(cards).map(card=>({...card,assets:card.assets.map(asset=>{
  if(!asset.fileId){warnings.push('Reattach DataCard asset: '+card.name+' / '+asset.name);return asset}
  if(!lookup)return asset;
  let stored;try{stored=lookup(asset.fileId)}catch{ /* Missing files remain explicit draft inputs. */ }
  if(stored&&!stored.type?.startsWith(asset.type+'/'))throw Error('Stored DataCard asset has an incompatible media type: '+asset.name);
  if(!stored){warnings.push('Reattach DataCard asset: '+card.name+' / '+asset.name);return {...asset,missing:true}}
  const result={...asset};delete result.missing;return result;
 })}));
}
export function characterUsage(workflow,cardId,assetId){
 return workflow.steps.flatMap(step=>step.nodes.flatMap(node=>Object.entries(node.inputs||{}).flatMap(([port,bindings])=>bindings.flatMap((binding,slot)=>binding?.dataCardId===cardId&&(!assetId||binding.assetId===assetId)?[{nodeId:node.id,port,slot}]:[]))));
}
export function removeCharacter(workflow,cardId,assetId){
 const result=clone(workflow);
 for(const use of characterUsage(result,cardId,assetId)){
  const node=result.steps.flatMap(s=>s.nodes).find(n=>n.id===use.nodeId);
  const binding=node.inputs[use.port][use.slot],asset=characterAsset(result.dataCards,binding);
  node.inputs[use.port][use.slot]={missing:true,name:asset.name};
 }
 if(assetId)result.dataCards.find(c=>c.id===cardId).assets=result.dataCards.find(c=>c.id===cardId).assets.filter(a=>a.id!==assetId);
 else result.dataCards=result.dataCards.filter(c=>c.id!==cardId);
 return result;
}
// Browser estimates use the same resolved file IDs as the runner.
export function resolveCharacterMedia(step,cards,{tolerateMissing=false}={}){
 const result=clone(step);
 const resolve=source=>{
  if(source?.mode==='list')return {...source,items:source.items.map(resolve)};
  if(source?.mode!=='character')return source;
  try{const asset=resolveCharacterAsset(cards,source);return {mode:'file',file:asset.assetId,...asset}}
  catch(error){if(!tolerateMissing)throw error;return {mode:'file',name:'Missing DataCard asset'}}
 };
 result.media=Object.fromEntries(Object.entries(result.media||{}).map(([key,value])=>[key,resolve(value)]));
 return result;
}

// Generic entry points; existing CharacterCard callers remain compatible.
export {characterAsset as dataCardAsset,resolveCharacterAsset as resolveDataCardAsset,characterUsage as dataCardUsage,removeCharacter as removeDataCard,resolveCharacterMedia as resolveDataCardMedia};

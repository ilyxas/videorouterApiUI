import {normalizeDataCards,reconnectDataCards} from './public/data-cards.mjs';
import {randomUUID} from 'node:crypto';
import {parseWorkflowJSON,portableWorkflow} from './public/workflow-json.mjs';

const clearable=new Set(['completed','failed','interrupted']);
export function createLibrary({db,all,get,save,routes,assetLookup,isBusy=()=>false,afterDelete=()=>{}}){
 const remove=db.prepare('DELETE FROM records WHERE kind=? AND id=?');
 function runBusy(run){return run.status==='running'||isBusy(run.id)||all('run').some(r=>r.parentRunId===run.id&&(r.status==='running'||isBusy(r.id)))}
 function deletion(body){
  if(body.kind==='data-card'){const card=get('data-card',body.id);if(!card)throw Error('DataCard not found');return {kind:'data-card',ids:[card.id],names:[card.name],paused:0,pinnedWorkflows:0}}
  if(!['run','flow'].includes(body.kind))throw Error('Неизвестный тип удаления');
  if(body.kind==='flow'){
   const item=get('flow',body.id);if(!item)throw Error('Workflow не найден');
   if(all('run').some(r=>r.config?.workflow?.id===item.id&&(r.status==='running'||isBusy(r.id))))throw Error('Дождитесь завершения активного workflow');
   return {kind:'flow',ids:[item.id],names:[item.name],paused:0,pinnedWorkflows:0};
  }
  let runs;
  if(body.clearCompleted===true)runs=all('run').filter(r=>clearable.has(r.status)&&!runBusy(r));
  else{
   const run=get('run',body.id);if(!run)throw Error('Запуск не найден');
   if(runBusy(run))throw Error('Выполняющийся запрос нельзя удалить');runs=[run];
  }
  const ids=runs.map(r=>r.id),selected=new Set(ids);
  const references=value=>value&&typeof value==='object'&&(value.mode==='pinned'&&selected.has(value.runId)||Object.values(value).some(references));
  return {kind:'run',ids,names:runs.map(r=>r.name),paused:runs.filter(r=>r.status==='paused').length,pinnedWorkflows:all('flow').filter(references).length};
 }
 function deleteItems(plan){
  // Recheck the exact reviewed IDs; never add newly completed runs to a clear.
  for(const id of plan.ids)deletion({kind:plan.kind,id});
  db.exec('BEGIN IMMEDIATE');
  try{
   for(const id of plan.ids){
    if(plan.kind==='run'){
     db.prepare('DELETE FROM webhook_inbox WHERE attempt_id IN (SELECT id FROM webhook_attempts WHERE run_id=?)').run(id);
     db.prepare('DELETE FROM webhook_attempts WHERE run_id=?').run(id);
    }
    remove.run(plan.kind,id);
   }
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error}
  afterDelete(plan);return {deleted:plan.ids,kind:plan.kind};
 }
 function importJSON(text){
  const parsed=parseWorkflowJSON(text,{routes,assetLookup}),workflow={...parsed.workflow,id:randomUUID()};save('flow',workflow);return {workflow,warnings:parsed.warnings};
 }
 function dataCards(){return reconnectDataCards(all('data-card'),assetLookup)}
 function saveDataCard(input){
  const [card]=normalizeDataCards([{...input,id:input.id||randomUUID()}]);
  const existing=get('data-card',card.id);if(existing&&existing.kind!==card.kind)throw Error('A saved DataCard cannot change kind');
  const [bound]=reconnectDataCards([card],assetLookup);save('data-card',bound);return bound;
 }
 function duplicateDataCard(id){const card=get('data-card',id);if(!card)throw Error('DataCard not found');return saveDataCard({...card,id:randomUUID(),name:(card.name+' · copy').slice(0,150)})}
 function dataCardContext(){
  const cards=dataCards(),files=new Map();
  for(const card of cards)for(const asset of card.assets)if(asset.fileId&&!asset.missing){const info=assetLookup?.(asset.fileId);if(info)files.set(asset.fileId,{id:asset.fileId,type:info.type})}
  return {version:1,cards,files:[...files.values()]};
 }
 return {deletion,deleteItems,importJSON,dataCards,saveDataCard,duplicateDataCard,dataCardContext,exportJSON:workflow=>portableWorkflow(workflow,{routes,assetLookup})};
}

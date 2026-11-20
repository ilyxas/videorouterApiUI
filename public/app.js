import {dataCardAssetRole,normalizeDataCards,characterAsset,characterUsage,removeCharacter,resolveCharacterMedia} from './data-cards.mjs';
import {characterList,workflowCharacters,characterEditor,characterSourcePicker,assetPreview} from './character-ui.mjs';
import {normalizeRequest,estimateRequest,validateImageBindings,actionMatrix,lipProfiles,videoProfile,modeOf,contractFor,contractError,assertContract,assertQuoteMatches,configureModelCatalog,modelsForAction,modelSupportsAction,imageSizing,previewEstimate,editorToWorkflow,workflowToEditor,compileGraph,operations,operationIdFor,operationFor,configureOperations,modelChoices,nodePort,moveGraphStep,deleteGraphStep,layoutStep,layoutWorkflow,executionPreview,parseWorkflowJSON,workflowJSONLimit} from './workflow-core.mjs';
const $ = s => document.querySelector(s);
const h = v => String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const at = (o,p) => p.split('.').reduce((v,k)=>v?.[k],o);
const fmt = x => JSON.stringify(x,null,2);
const copy = x => structuredClone(x);
const date = s => new Date(s).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
const usd = x => typeof x==='number' ? '$'+x.toLocaleString('en-US',{maximumFractionDigits:5}) : '—';
const labels={dashboard:'Обзор',api:'API Explorer',models:'Модели',workflow:'Workflow',runs:'История запусков',docs:'Документация',settings:'Подключение',characters:'Characters',locations:'Locations'};
const icons=['◫','⌘','⊞','⑂','◷','≡','⚙','♙','⌂'];
const statuses={running:'В работе',completed:'Готово',failed:'Ошибка',waiting:'Ожидание',interrupted:'Прерван',blocked:'Заблокирован',reused:'Сохранённый результат',skipped:'Пропущен',saved:'Результат из истории',paused:'Пауза — можно продолжить'};
const asyncOps=new Set(['videos','lipsync','face-swap','meshes','avatars/videos','batches','jobs'].map(v=>'POST /v1/'+v));
const groupIcons={'Видео':'▷','Изображения':'▧','Аудио':'≋','Чат':'≣','3D':'⬡','Live':'◉','Каталог':'⊞','Аватары':'◌','Аккаунт':'◍','Realtime':'⌁','Batch':'▤','Задания':'≡','Файлы':'▱'};
const groups=Object.keys(groupIcons);
const action=(a,text,cls='btn',extra='')=>'<button type="button" class="'+cls+'" data-a="'+a+'" '+extra+'>'+text+'</button>';
const tag=t=>'<span class="tag">'+h(t)+'</span>';
const docsLink=slug=>'<a target="_blank" rel="noreferrer" href="https://videorouter.sh/docs/'+h(slug)+'">Справочник ↗</a>';
const title=(name,buttons='')=>'<div class="title"><h1>'+h(name)+'</h1><div class="actions">'+buttons+'</div></div>';
const hint=t=>'<p class="help">'+t+'</p>';
const no=t=>'<p class="empty">'+h(t)+'</p>';
const chips=items=>items.map(tag).join(' ');
let cat,state,models,modelPage=0,selected='POST /v1/videos',page='dashboard',filter='',group='',modelFilter='',modelGroup='',docFilter='',runId='',socketId='',timer,toastTimer;
let priceSort='', priceUnit='', budgetVariants=[];
let inlineRun=null,lastStepRun=null,workflowOutputCache={nodes:{}},selectedFlowNode='';
let params={}, flow={name:'Новый workflow',steps:[]}, editIndex=-1, ticket='',pending=null, editingJSON=false;
let pendingDeletion=null,pendingImport=null;
let characterDraft=null,characterScope='library',characterRemoved=new Set();
const draftKey='videorouter.workflow-draft.v1';
let draftReady=false,draftMessage='',restoredEditor=null,unreadableDraft=null;
function newStepId(){
 return crypto.randomUUID?.()||Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
function ensureStepIds(steps){
 const seen=new Set();
 for(const s of steps){if(typeof s.id!=='string'||!s.id||seen.has(s.id))s.id=newStepId();seen.add(s.id)}
 return steps;
}
function mergeEditorStep(old,updated){
 const merged={...old,...updated,id:old.id};
 if(old.op===updated.op){
  if(old.media)merged.media=Object.fromEntries(Object.entries(old.media).filter(([key])=>updated.params[key==='reference_image'?'input_references':key]===undefined));
 }else{delete merged.media;delete merged.inactiveMedia;delete merged.action;merged.advanced=true}
 return merged;
}
function saveDraft(){
 if(!draftReady)return;
 try{
  ensureStepIds(flow.steps);
  let editor=null;
  if(page==='api'&&editIndex>=0){
   const fields=[...document.querySelectorAll('[data-field]')].filter(e=>e.type!=='file').map(e=>({field:e.dataset.field,value:e.value}));
   const raw=editingJSON?$('#raw')?.value:null;
   editor={stepId:flow.steps[editIndex].id,selected,params:copy(params),editingJSON,raw,fields,workflowScroll};
   try{flow.steps[editIndex]=mergeEditorStep(flow.steps[editIndex],step());editor.params=copy(params)}catch{ /* Preserve incomplete JSON/number input for reload. */ }
  }
  if(unreadableDraft!==null){localStorage.setItem(draftKey+'.unreadable',unreadableDraft);unreadableDraft=null}
  localStorage.setItem(draftKey,JSON.stringify({version:flow.groups?2:1,savedAt:new Date().toISOString(),flow:flow.groups?editorToWorkflow(flow):flow,editor,resume:flow.resume,activeRunId:flow.activeRunId}));
  draftMessage='Черновик сохранён в этом браузере';
 }catch{draftMessage='Не удалось сохранить черновик в браузере. Сохраните workflow вручную.'}
 const status=$('#draftStatus');if(status)status.textContent=draftMessage;
}
function restoreDraft(){
 try{
  const raw=localStorage.getItem(draftKey);if(!raw)return false;
  unreadableDraft=raw;
  const saved=JSON.parse(raw);
  if(![1,2].includes(saved.version)||!saved.flow||!Array.isArray(saved.flow.steps))throw Error();
  if(saved.version===1&&saved.flow.steps.some(s=>!s||typeof s.op!=='string'||!s.params||typeof s.params!=='object'))throw Error();
  unreadableDraft=null;flow=workflowToEditor(saved.flow);if(saved.resume)flow.resume=saved.resume;if(saved.activeRunId)flow.activeRunId=saved.activeRunId;ensureStepIds(flow.steps);restoredEditor=saved.editor;
  draftMessage='Черновик восстановлен';return true;
 }catch{draftMessage='Сохранённый черновик не прочитан; исходная копия оставлена в браузере.';return false}
}
function restoreEditor(){
 const saved=restoredEditor;restoredEditor=null;
 const index=flow.steps.findIndex(s=>s.id===saved?.stepId);
 if(index<0||!op(saved.selected))return false;
 workflowScroll=saved.workflowScroll||0;editIndex=index;selected=saved.selected;params=saved.params;editingJSON=saved.editingJSON;show('api');
 if(editingJSON)$('#raw').value=saved.raw??fmt(params);
 else for(const e of document.querySelectorAll('[data-field]')){
  const field=saved.fields?.find(f=>f.field===e.dataset.field);if(field&&e.type!=='file')e.value=field.value;
 }
 return true;
}
const op=id=>cat.routes.find(r=>r.id===id);
async function api(path,body) {
 const response=await fetch('/local/'+path,{method:body===undefined?'GET':'POST',headers:{'X-Studio':'1',...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await response.json();if(!response.ok)throw Error(data.error||response.status);return data;
}
function toast(s){$('#toast').textContent=s;$('#toast').style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').style.display='none',4500)}
function dialog(html){$('#dialogBody').innerHTML=html;if(!$('#dialog').open)$('#dialog').showModal()}
const close=()=>$('#dialog').close();
function header(){
 $('#nav').innerHTML=Object.entries(labels).map(([id,label],i)=>action('nav','<i class="ico">'+icons[i]+'</i>'+label,id===page?'active':'','data-id="'+id+'"')).join('');
 $('#crumb').textContent=labels[page];
 $('#connection').innerHTML='<i class="dot '+(state.keys.api?'green':'')+'"></i>'+(state.keys.api?'Ключ подключён':'Подключить ключ');
}
function show(which){clearTimeout(timer);page=which;header();render()}
function toApi(id,p={}){editIndex=-1;selected=id;params=copy(p);editingJSON=false;group='';filter='';show('api')}
function runRows(rows){
 return rows.length?'<div class="list">'+rows.map(r=>'<div class="managed-row"><button class="listrow" data-a="openrun" data-id="'+h(r.id)+'"><i class="symbol">◷</i><span><b>'+h(r.name)+'</b><br><small>'+date(r.created)+' · '+r.steps.length+' шаг.</small></span><small>'+h(statuses[r.status])+' · '+usd(r.cost)+'</small></button>'+action('deleteRun','Удалить','small','data-id="'+h(r.id)+'" '+(r.status==='running'?'disabled':'')+' aria-label="Удалить запуск '+h(r.name)+'"')+'</div>').join('')+'</div>':'<div class="list">'+no('История пуста. Здесь появятся запросы и результаты workflow.')+'</div>';
}
function workflowLibraryHTML(){
 return '<h2>Сохранённые workflows</h2><div class="list compact">'+(state.flows.map(f=>'<div class="managed-row">'+action('loadone',h(f.name)+'<small>'+f.steps.length+' шаг.</small>','listrow','data-id="'+h(f.id)+'"')+action('deleteFlow','Удалить','small','data-id="'+h(f.id)+'" aria-label="Удалить workflow '+h(f.name)+'"')+'</div>').join('')||no('Пока нет сохранённых workflows.'))+'</div>';
}
function downloadJSON(value,name){
 const url=URL.createObjectURL(new Blob([fmt(value)+'\n'],{type:'application/json'})),link=document.createElement('a');
 link.href=url;link.download=String(name||'workflow').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,120)+'.workflow.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function previewDeletion(body){
 pendingDeletion=await api('library/delete-preview',body);const p=pendingDeletion;
 if(!p.ids.length){toast('Нет завершённых записей для удаления');return}
 dialog('<h2>'+(p.kind==='flow'?'Удалить workflow?':'Удалить '+p.ids.length+' записей истории?')+'</h2>'+hint(p.names.slice(0,4).map(h).join('<br>'))+
  hint(p.kind==='data-card'?'The library entry will be deleted. Workflow snapshots and local files remain.':p.kind==='flow'?'Сохранённая схема будет удалена. Её история и файлы останутся. Если workflow открыт сейчас, редактор будет очищен.':'Запросы и результаты этих запусков исчезнут из истории и выбора outputs. Локальные файлы останутся. Удаление истории не отменяет задания и списания VideoRouter.')+
  (p.paused?hint('Будет удалена пауза: продолжить этот запуск после удаления нельзя.'):'')+
  (p.pinnedWorkflows?hint('Сохранённых workflows с закреплёнными outputs этих запусков: '+p.pinnedWorkflows+'. Такие источники станут недоступны.'):'')+
  hint('Действие нельзя отменить.')+'<div class="actions">'+action('confirmLibraryDelete','Удалить','danger')+action('cancelLibrary','Отмена')+'</div>');
}
function previewWorkflowImport(text){
 const parsed=parseWorkflowJSON(text,{routes:new Map(cat.routes.map(r=>[r.id,r]))});
 pendingImport={text:fmt(parsed.workflow),warnings:parsed.warnings};const w=parsed.workflow;
 dialog('<h2>Импортировать workflow?</h2>'+hint(h(w.name)+' · Steps: '+w.steps.length+' · Карточек: '+w.steps.reduce((n,s)=>n+s.nodes.length,0))+
  hint('Будет сохранена и открыта отдельная копия. Генерация не запускается. Сохраните текущий черновик перед импортом, если он нужен.')+
  (parsed.warnings.length?'<ul>'+parsed.warnings.map(v=>'<li>'+h(v)+'</li>').join('')+'</ul>':'')+
  '<div class="actions">'+action('confirmWorkflowImport','Импортировать копию','primary')+action('cancelLibrary','Отмена')+'</div>');
}
function dashboard(){
 const wallet=state.account, sum=state.runs.reduce((v,r)=>v+(r.cost??0),0);
 const metrics=[['Доступный баланс',usd(wallet?.available_usd),wallet?date(wallet.date):'Кошелёк'],['Методы API',cat.routes.length,'API'],['Workflow',state.flows.length,'Локально'],['Запуски',state.runs.length,state.runs.length?'Учтено '+usd(sum):'История']];
 return title('Обзор',action('nav','Открыть API Explorer ↗','btn','data-id="api"'))+
 '<div class="stats">'+metrics.map(([l,v,k])=>'<div class="metric"><small>'+l+'</small><span class="mini">'+h(k)+'</span><strong>'+h(v)+'</strong></div>').join('')+'</div>'+
 '<section class="hero"><div class="herotext"><h2>Workflow с LTX 2.5</h2><p>Выберите запись с компьютера, вставьте ссылку или озвучьте текст. Добавьте описание сцены и стартовый кадр.</p>'+action('template','Открыть в редакторе →','primary')+'</div><div class="graph" aria-label="Аудио → LTX → видео"><div class="node">Аудио</div><i class="wire"></i><div class="node core">LTX 2.5</div><i class="wire"></i><div class="node">Видео</div></div></section>'+
 '<div class="sectionhead"><h2>Инструменты API</h2>'+action('nav','Все методы →','linkbtn','data-id="api"')+'</div><div class="cards">'+['Видео','Изображения','Аудио','Чат','3D','Live'].map(g=>'<button class="item" data-a="group" data-id="'+g+'"><span class="symbol">'+groupIcons[g]+'</span><span><strong>'+g+'</strong><small>'+cat.routes.filter(r=>r.group===g).length+' метод.</small></span><span class="arrow">→</span></button>').join('')+'</div>'+
 '<div class="sectionhead"><h2>Последние запуски</h2>'+action('nav','Вся история →','linkbtn','data-id="runs"')+'</div>'+runRows(state.runs.slice(0,4));
}
function options(list,current,empty){
 return (empty?'<option value="">'+h(empty)+'</option>':'')+list.map(x=>'<option '+(x===current?'selected':'')+' value="'+h(x)+'">'+h(x)+'</option>').join('');
}
function routeList(){
 const q=filter.toLowerCase();
 const list=cat.routes.filter(r=>(!group||r.group===group)&&(r.id+' '+r.group).toLowerCase().includes(q));
 return list.map(r=>'<button class="listrow '+(r.id===selected?'sel':'')+'" data-a="pick" data-id="'+h(r.id)+'"><b class="method '+r.method+'">'+r.method+'</b><code>'+h(r.path.replace('/v1/','/'))+'</code></button>').join('')||no('Совпадений нет.');
}
function editor(r){
 const known=r.fields.map(f=>{
  const val=at(params,f.name),isobj=/array|object|\[\]/i.test(f.type),type=f.type.toLowerCase();
  let attrs='data-field="'+h(f.name)+'" data-type="'+h(type)+'"';
  let control;
  if(type.startsWith('file'))control='<input type="file" '+attrs+'>'+(val?'<small>'+h(val)+'</small>':'')+'<input aria-label="ID файла или результат шага" '+attrs+' placeholder="{{1.file}}" type="text" value="'+h(val??'')+'">';
  else if(type==='boolean')control='<select '+attrs+'>'+options(['true','false'],val==null?'':String(val),'По умолчанию')+'</select>';
  else if(isobj || ['prompt','input','script','instructions','query'].includes(f.name))control='<textarea rows="'+(isobj?3:2)+'" '+attrs+' placeholder="'+(type.includes('array')?'[]':type.includes('object')?'{}':'')+'">'+h(typeof val==='object'?fmt(val):val??'')+'</textarea>';
  else control='<input type="text" '+attrs+' value="'+h(typeof val==='object'?fmt(val):val??'')+'" '+(f.name==='model'?'list="modelHints"':'')+'>';
  const lipHelp={audio_url:'Обязательно для каждой модели',image_url:'Обязательно для модели, которая оживляет фото',video_url:'Обязательно для модели, которая озвучивает видео'};
  const help=(r.id===portraitOp && lipHelp[f.name])||(r.id===videoOp && f.name==='input_audio_url' && 'Одна звуковая дорожка, только LTX-2.5')||f.type;
  return '<label class="field '+(isobj||['prompt','input','file','script'].includes(f.name)?'full':'')+'"><span class="mono">'+h(f.name)+(f.required?' *':'')+'</span>'+control+'<span class="hint">'+h(help)+'</span></label>';
 }).join('');
 const modelTerm=String(params.model||'').split('/')[0].toLowerCase();
 const candidates=models.filter(m=>modelOp(m)===r.id&&(!modelTerm||m.id.toLowerCase().includes(modelTerm))).slice(0,400);
 return '<div class="toolbar">'+action('fields','Поля',editingJSON?'btn':'primary')+action('json','JSON',editingJSON?'primary':'btn')+docsLink(r.doc)+'</div>'+
 (editIndex>=0&&flow.groups?'<section class="api-character-inputs"><h3>Workflow media inputs</h3>'+graphMedia(flow.steps[editIndex],editIndex)+'</section>':'')+
 (editingJSON?'<label class="field">Все параметры запроса<textarea rows="13" id="raw" class="mono">'+h(fmt(params))+'</textarea></label>':
 '<div class="formgrid">'+(known||hint('Метод вызывается без обязательных параметров. Дополнительные параметры доступны в JSON.'))+'</div>')+
 '<datalist id="modelHints">'+candidates.map(m=>'<option value="'+h(m.id)+'">').join('')+'</datalist>'+
 (asyncOps.has(r.id)?'<p class="check"><label><input id="waitJob" type="checkbox" '+((editIndex>=0?flow.steps[editIndex].wait:waitJob)?'checked':'')+'> Дождаться готового результата</label></p>':'');
}
let waitJob=true;
function explorer(){
 const r=op(selected);
 return title(editIndex>=0?'Параметры шага':'API Explorer',editIndex>=0?action('backworkflow','К workflow','btn'):'')+
 '<div class="split"><div><div class="filters"><input id="routeQ" aria-label="Поиск метода" placeholder="Найти метод…" value="'+h(filter)+'"></div><div class="filters"><select id="routeGroup">'+options(groups,group,'Все разделы')+'</select></div><div class="list scroll" id="routeList">'+routeList()+'</div></div>'+
 '<section class="panel"><div class="chips">'+tag(r.group)+tag(r.encoding==='multipart'?'Multipart':r.method==='WS'?'WebSocket':r.method==='GET'?'Query':'JSON')+tag(r.group==='Аккаунт'&&r.path!=='/v1/balance'?'Management key':'API key')+'</div><h2 class="compact break">'+h(r.id)+'</h2>'+editor(r)+
 '<div class="toolbar">'+(editIndex>=0?action('apply','Сохранить шаг','primary'):action('single',r.method==='WS'?'Открыть сессию':'Выполнить','primary'))+(r.method==='WS'||editIndex>=0?'':action('append','В workflow'))+(r.method==='POST'&&['Видео','Аудио','Изображения','Чат','3D','Аватары','Live'].includes(r.group)?action('estimate','Оценить стоимость'):'')+'</div></section></div>';
}
function commit(){
 if(editingJSON){const o=JSON.parse($('#raw').value);if(!o||typeof o!=='object'||Array.isArray(o))throw Error('Нужен объект JSON');params=o;return}
 for(const e of document.querySelectorAll('[data-field]')){
  if(e.type==='file')continue;
  const parts=e.dataset.field.split('.'),k=parts.pop(),v=e.value,t=e.dataset.type;
  if(!v.trim()&&at(params,e.dataset.field)===undefined)continue;
  let dest=params;for(const p of parts){if(!dest[p]||typeof dest[p]!=='object')dest[p]={};dest=dest[p]}
  if(!v.trim()){delete dest[k];continue}
  if(/^\{\{\d+(?:\.[\w-]+)*\}\}$/.test(v)){dest[k]=v;continue}
  if(/array|object|\[\]/.test(t)&&!(t.includes('string or array')&&!v.trim().startsWith('['))){
   try{dest[k]=JSON.parse(v)}catch{throw Error('Проверьте JSON в поле '+e.dataset.field)}
  }else if(/^(integer|number|float)/.test(t)){const n=Number(v);if(!Number.isFinite(n))throw Error('Введите число в поле '+e.dataset.field);dest[k]=n}
  else if(t==='boolean')dest[k]=v==='true';
  else dest[k]=v;
 }
}
function step(){commit();return {...(editIndex<0?{advanced:true}:{}),id:editIndex>=0?flow.steps[editIndex].id:newStepId(),op:selected,params:copy(params),wait:!!$('#waitJob')?.checked}}
function editorFor(index){
 workflowScroll=window.scrollY;const s=flow.steps[index];editIndex=index;selected=s.op;params=copy(s.params);editingJSON=false;filter='';group='';show('api');window.scrollTo(0,0);
}
const imageOp = 'POST /v1/images';
const speechOp = 'POST /v1/audio/speech';
const videoOp = 'POST /v1/videos';
const estimateOp = 'POST /v1/pricing/estimate';
const uploadOp = 'POST /v1/uploads';
const friendlySteps = {
 [imageOp]: {name:'Создать изображение',output:'Изображения',defaults:{model:'gpt-image-1',prompt:'',n:1},fields:['prompt','model','n'],media:{}},
 [videoOp]: {name:'Создать видео', output:'Видео', defaults:{model:'lightricks/ltx-2.5-fast',prompt:'',resolution:'720p',aspect_ratio:'9:16',duration_secs:5}, fields:['prompt','duration_secs','aspect_ratio','resolution'], media:{input_audio_url:['Звуковая дорожка','audio'],start_image_url:['Стартовое изображение','image'],end_image_url:['Последний кадр','image'],input_video_url:['Исходное видео','video']}},
 [speechOp]: {name:'Озвучить текст', output:'Аудиофайл', defaults:{input:'',model:'tts-1',voice:'alloy',response_format:'mp3'}, fields:['input','voice','response_format','model'],media:{}},
 'POST /v1/lipsync': {name:'Синхронизировать губы с речью',output:'Видео',defaults:{model:'vidu/s1-avatar-offline'}, fields:['model'],media:{audio_url:['Запись речи','audio'],image_url:['Портрет','image'],video_url:['Исходное видео','video']}},
 'POST /v1/audio/transcriptions': {name:'Расшифровать запись',output:'Текст',defaults:{model:'whisper-1'},fields:['model'],media:{file:['Запись для расшифровки','audio']}},
 [uploadOp]: {name:'Передать файл в VideoRouter',output:'Ссылка на файл',defaults:{},fields:[],media:{file:['Файл','*']}}
};
const fieldNames={size:'Формат изображения',quality:'Качество',n:'Количество изображений',prompt:'Описание сцены',duration_secs:'Длительность, с',aspect_ratio:'Формат кадра',resolution:'Разрешение',model:'Модель',input:'Текст для озвучки',voice:'Голос',response_format:'Формат аудио'};
const mediaModes={none:'Пропустить',file:'С компьютера',url:'По ссылке',previous:'Из шага',speech:'Озвучить текст',character:'Card asset'};
const specFor=s=>s.op===imageOp&&actionMatrix[modeOf(s)]?{...friendlySteps[imageOp],name:actionMatrix[modeOf(s)].name,fields:actionMatrix[modeOf(s)].fields,media:actionMatrix[modeOf(s)].input?{reference_image:['Исходное изображение','image']}:{}}:friendlySteps[s.op];
const stageName=s=>actionMatrix[modeOf(s)]?.name||specFor(s)?.name||s.op;
let insertionIndex=null,workflowScroll=0,selectedGroupId=null;
function insertStep(index,newStep){
 const shifted=flow.steps.map(s=>JSON.parse(JSON.stringify(s).replace(/"\{\{(\d+)((?:\.[\w-]+)*)\}\}"/g,(_,n,path)=>'"{{'+(+n>index?+n+1:+n)+path+'}}"')));
 shifted.splice(index,0,newStep);flow.steps=shifted;
 if(flow.groups){const g=flow.groups.find(g=>g.id===selectedGroupId)||flow.groups.find(g=>g.nodeIds.includes(shifted[index-1]?.id))||flow.groups[0];if(g)g.nodeIds.push(newStep.id);selectedGroupId=null}
}
function newImageAction(mode){
 const s=makeStep(imageOp);s.action=mode;s.params={model:actionMatrix[mode].models[0],...(mode==='image-upscale'?{}:{prompt:''}),n:1};return s;
}
function actionMenu(){
 dialog('<h2>Добавить действие</h2><h3>Изображения и видео</h3><div class="list compact">'+Object.entries(actionMatrix).map(([key,v])=>v.unavailable?'<div class="listrow"><span>'+h(v.name)+'<small>Недоступно · '+h(v.unavailable)+'</small></span></div>':action('addAction',h(v.name),'listrow','data-id="'+key+'"')).join('')+'</div><h3>Аудио и файлы</h3><div class="list">'+Object.entries(friendlySteps).filter(([key])=>![imageOp,videoOp].includes(key)).map(([key,v])=>action('addfriendly',h(v.name),'listrow','data-id="'+h(key)+'"')).join('')+'</div><div class="toolbar">'+action('otherstep','Расширенный API Explorer','linkbtn')+'</div>');
}

const waitingFiles=new Set();

function sourceOf(s,key){
 if(key.includes('#')){const [port,slot]=key.split('#');return s.media?.[port]?.items?.[+slot]||{mode:'none'}}
 if(s.media?.[key])return s.media[key];
 const original=key==='reference_image'?s.params.input_references?.[0]?.image_url?.url:s.params[key];
 if(!original)return {mode:'none'};
 if(typeof original==='string'&&original.startsWith('{{'))return {mode:'previous',ref:original};
 if(key==='file')return {mode:'file',file:original,name:'Сохранённый файл'};
 return {mode:'url',url:original};
}
function sourceChoices(index,kind,key){
 if(flow.groups){
  const current=flow.groups.findIndex(g=>g.nodeIds.includes(flow.steps[index]?.id));
  return flow.steps.flatMap((s,i)=>{
   const stage=flow.groups.findIndex(g=>g.nodeIds.includes(s.id)),type=operations[operationIdFor(s)].kind;
   if(i===index||stage>current&&current>=0||!(kind==='*'||type===kind))return [];
   return Array.from({length:Math.min(s.params.n||1,100)},(_,n)=>({ref:'media:'+s.id+':'+nodePort(type)+':'+n,label:'Step '+(stage+1)+' · '+stageName(s)+' → '+type+' '+(n+1)}));
  });
 }
 const choices=[];
 for(let i=0;i<index;i++){
  const s=flow.steps[i];
  let path;
  if(s.op===imageOp&&kind==='image'&&['start_image_url','reference_image'].includes(key)){
   for(let n=0;n<Math.min(s.params.n||1,100);n++)choices.push({ref:'image:'+s.id+':'+n,label:'Шаг '+(i+1)+' → Изображение '+(n+1)});
  }
  if(s.op===speechOp && ['audio','*'].includes(kind))path='file';
  else if(s.op===uploadOp && key!=='file')path='url';
  else if([videoOp,'POST /v1/lipsync'].includes(s.op)&&s.wait&&kind==='video'&&key!=='file')path='data.0.url';
  if(path)choices.push({ref:'{{'+(i+1)+'.'+path+'}}',label:'Шаг '+(i+1)+' · '+stageName(s)});
 }
 return choices;
}
function mediaPicker(s,index,key,[label,kind]){
 const src=sourceOf(s,key),choices=sourceChoices(index,kind,key);
 const selectedRef=src.stepId?(flow.groups?'media:'+src.stepId+':'+src.port+':'+src.index:'image:'+src.stepId+':'+src.index):src.ref;
 const canSkip=s.op===videoOp || (s.op===portraitOp && key!=='audio_url' && lipSource(s.params.model)!==key);
 const modes=[...(canSkip?['none']:[]),'file',...(flow.groups?['character']:[]),...(key==='file'?[]:['url']),...(choices.length||src.mode==='previous'?['previous']:[]),...(kind==='audio'&&key!=='file'?['speech']:[])];
 const mode=src.mode==='none'&&!canSkip?'file':src.mode;
 const attrs='data-i="'+index+'" data-key="'+key+'"';
 const buttons=modes.map(m=>action('mediaMode',mediaModes[m],m===mode?'source active':'source',attrs+' data-mode="'+m+'" aria-pressed="'+(m===mode)+'"')).join('');
 let body='';
 if(mode==='character'){body=characterSourcePicker(flow.dataCards||[],src,kind,attrs)}
 else if(mode==='file'){
  const accepted=kind==='*'?'':' accept="'+kind+'/*"';
  body='<label class="pickfile"><span>'+h(src.name||'Выбрать файл…')+'</span><input type="file" data-wf-file '+attrs+accepted+'></label>';
 } else if(mode==='url'){
  body='<label class="field">Ссылка на '+({audio:'аудиофайл',image:'изображение',video:'видеофайл'}[kind]||'файл')+'<input type="url" data-src-value="url" '+attrs+' value="'+h(src.url||'')+'" placeholder="https://…"></label>';
 } else if(mode==='previous'){
  const choicesHtml=choices.map(c=>'<option value="'+h(c.ref)+'" '+(selectedRef===c.ref?'selected':'')+'>'+h(c.label)+'</option>').join('');
  const legacy=selectedRef&&!choices.some(c=>c.ref===selectedRef)?'<option selected value="'+h(selectedRef)+'">Связь требует проверки'+'</option>':'';
  body='<label class="field">Источник результата<select data-src-value="ref" '+attrs+'><option value="">Выберите шаг</option>'+choicesHtml+legacy+'</select></label>';
 } else if(mode==='speech'){
  body='<label class="field">Текст для озвучки<textarea data-src-value="text" '+attrs+' placeholder="Введите текст, который прозвучит в ролике">'+h(src.text||'')+'</textarea></label><label class="field">Голос<select data-src-value="voice" '+attrs+'>'+options(['alloy','nova','shimmer','echo','onyx','fable'],src.voice||'alloy')+'</select></label>';
 }
 return '<fieldset class="mediafield"><legend>'+label+'</legend><div class="sources">'+buttons+'</div><div class="mediaentry">'+body+'</div></fieldset>';
}
const portraitOp='POST /v1/lipsync';
// Models and input modes listed in VideoRouter's lip-sync guide.
const lipModels=Object.fromEntries(['image_url','video_url'].map(key=>[key,Object.keys(lipProfiles).filter(id=>lipProfiles[id].input===key)]));
function lipSource(model){return lipProfiles[model]?.input}
const videoModes={'text-to-video':'По тексту','image-to-video':'По изображению','audio-to-video':'По аудио','reference-to-video':'По референсам','video-edit':'Редактирование видео','video-extend':'Продление видео','video-upscale':'Увеличение разрешения','motion-control':'Перенос движения'};
function videoModel(id){
 const live=models.find(m=>m.id===id);
 const saved=cat.models.find(m=>m.id===id);
 return live||saved;
}
function videoInputAvailable(m,key){return videoProfile(m?.id)?.inputs.includes(key)||m?.capabilities?.[key]===true||key==='start_image_url'&&modelSupportsAction(m?.id,'image-to-video')}
function videoModelResults(query,index,current){
 const entries=new Map(modelsForAction(modeOf(flow.steps[index]||{op:videoOp,params:{model:current}})).map(m=>[m.id,m]));
 const terms=query.trim().toLowerCase().split(/\s+/);
 const rows=[...entries.values()].filter(m=>{
  const searchable=[m.id,m.owned_by,m.hosts,m.cap,...(m.cap||'').split(' ').map(c=>videoModes[c])].join(' ').toLowerCase();
  return terms.every(term=>searchable.includes(term));
 }).sort((a,b)=>a.id.localeCompare(b.id));
 return rows.map(m=>action('selectVideoModel',h(m.id)+(m.id===current?' ✓':''),'listrow','data-i="'+index+'" data-id="'+h(m.id)+'"')).join('')||no('Модели не найдены');
}
function videoModelPicker(s,index){
 const id=s.params.model||'',m=videoModel(id);
 const modes=(m?.cap||'').split(' ').map(c=>videoModes[c]).filter(Boolean);
 const info=[m?.hosts||m?.owned_by,...modes].filter(Boolean).join(' · ');
 return '<details class="videopicker" data-picker="'+index+'"><summary>Модель · '+h(id||'Выберите модель')+'</summary><div class="stack compact"><input type="search" aria-label="Поиск видеомодели" data-video-query="'+index+'" placeholder="Поиск по модели, провайдеру или режиму"><div class="list modelchoices">'+videoModelResults('',index,id)+'</div></div></details>'+(info?hint(h(info)):'');
}
function workflowMedia(s){
 const media=specFor(s).media;
 return Object.entries(media).filter(([key])=>{
  if(sourceOf(s,key).mode!=='none')return true;
  if(s.op===videoOp)return videoInputAvailable(videoModel(s.params.model),key);
  if(s.op===portraitOp && key!=='audio_url')return !lipSource(s.params.model)||lipSource(s.params.model)===key;
  return true;
 });
}
function ltxVariant(model=''){
 return /(?:^|\/)ltx-2\.5-(fast|pro)(?:\/|$)/i.exec(model)?.[1]?.toLowerCase();
}
function resolutionChoices(s){return contractFor(s)?.resolutions||[]}
function ltxSize(fields){
 const landscape={'720p':[1280,720],'1080p':[1920,1080],'1440p':[2560,1440],'2160p':[3840,2160]}[fields.resolution];
 if(!landscape||!['16:9','9:16','1:1'].includes(fields.aspect_ratio))return null;
 const [w,h]=landscape;
 if(fields.aspect_ratio==='1:1')return [h,h];
 return fields.aspect_ratio==='16:9'?[w,h]:[h,w];
}
function displaySize(s){
 const {resolution,aspect_ratio,width,height}=s.params;
 if(s.op===videoOp && (width!=null||height!=null))return 'Явные размеры · '+(width??'—')+' × '+(height??'—')+' пикс. Имеют приоритет. Измените формат или разрешение, чтобы убрать их.';
 if(s.op===videoOp && ltxVariant(s.params.model)){
  const px=ltxSize(s.params);
  if(px)return 'Запрашиваемый размер · '+resolution+' · '+aspect_ratio+' ('+px.join(' × ')+')';
 }
 return [resolution,aspect_ratio].filter(Boolean).join(' · ')||'Размер по умолчанию у модели';
}
function outputControls(s,index){
 const media=sourceOf(s,s.op===videoOp?'start_image_url':'image_url');
 const input=media.width&&media.height?'Исходное изображение · '+media.width+' × '+media.height+' пикс.':'';
 const controls=friendlyField(s,index,'resolution')+(s.op===videoOp?friendlyField(s,index,'aspect_ratio'):'');
 return '<section class="panel"><h3>Размер видео</h3><div class="formgrid compact">'+controls+'</div>'+
  (input?hint(h(input)):'')+'<p class="compact" aria-live="polite">'+h(displaySize(s))+'</p>'+
  (s.op===videoOp?hint('Перед генерацией сверяем параметры с оценкой. Если API изменил длительность или размер в допущениях оценки, цепочка остановится. '+docsLink('api-reference-video')):'')+
  (ltxVariant(s.params.model)?hint('Для пробы движения губ с портретом и записью доступен <a target="_blank" rel="noopener" href="/#portrait480">шаблон InfiniteTalk 480p ↗</a>.'):'')+'</section>';
}
function friendlyField(s,index,key){
 const value=(s.op===imageOp?normalizeRequest(s.op,s.params)[key]:s.params[key])??'',attrs='data-wf-field="'+key+'" data-i="'+index+'"';
 let control;
 if(s.op===imageOp&&key==='model')control='<select '+attrs+'>'+options([...new Set([...modelsForAction(modeOf(s)).map(m=>m.id),value].filter(Boolean))],value)+'</select>';
 else if(['input','prompt'].includes(key))control='<textarea '+attrs+' rows="3" placeholder="'+(key==='input'?'Введите текст для чтения':'Что происходит в кадре?')+'">'+h(value)+'</textarea>';
 else if(key==='voice'&&s.op===speechOp)control='<select '+attrs+'>'+options([...new Set(['alloy','nova','shimmer','echo','onyx','fable',value].filter(Boolean))],value)+'</select>';
 else if(key==='model'&&[speechOp,'POST /v1/audio/transcriptions'].includes(s.op))control='<select '+attrs+'>'+options([...new Set([...(s.op===speechOp?['tts-1','tts-1-hd']:['whisper-1']),value].filter(Boolean))],value)+'</select>';
 else if(key==='model' && s.op===portraitOp){
  const extra=value&&!lipSource(value)?options([value],value):'';
  control='<select '+attrs+'><option value="">Выберите модель</option>'+extra+Object.entries(lipModels).map(([k,slugs])=>'<optgroup label="'+(k==='image_url'?'Из фотографии':'Из видео')+'">'+options(slugs,value)+'</optgroup>').join('')+'</select>';
 }
 else if(['size','quality'].includes(key)){
  const values=imageSizing(s.params.model)[key==='size'?'sizes':'qualities'];
  const choices=[...new Set([...values,value].filter(Boolean))];
  const labels={size:{'1024x1024':'Квадрат · 1:1 · 1024 × 1024','1024x1536':'Портрет · 2:3 · 1024 × 1536','1536x1024':'Альбом · 3:2 · 1536 × 1024'},quality:{low:'Низкое',medium:'Среднее',high:'Высокое',standard:'Стандартное',hd:'HD'}};
  control='<select '+attrs+'>'+choices.map(v=>'<option value="'+h(v)+'" '+(v===value?'selected':'')+'>'+h(labels[key][v]||v)+'</option>').join('')+'</select>';
 }
 else if(key==='resolution'){
  const tiers=resolutionChoices(s);
  control='<select '+attrs+'>'+options(value&&!tiers.includes(value)?[value,...tiers]:tiers,value,'По умолчанию')+'</select>';
 }
 else if(['aspect_ratio','response_format'].includes(key)){
  const values=key==='aspect_ratio'?[...(contractFor(s)?.ratios||[])]:[...(contractFor(s)?.formats||[])];
  if(key==='aspect_ratio'&&ltxVariant(s.params.model))values.splice(0,values.length,'16:9','9:16','1:1');
  if(value&&!values.includes(value))values.push(value);
  control='<select '+attrs+'>'+options(values,value,'По умолчанию')+'</select>';
 }else control='<input '+attrs+' type="'+(['duration_secs','n'].includes(key)?'number" min="1':'text')+'" value="'+h(value)+'">';
 return '<label class="field '+(['input','prompt'].includes(key)?'full':'')+'">'+(s.op===imageOp&&key==='aspect_ratio'?'Формат изображения':fieldNames[key])+control+'</label>';
}
function makeStep(id){
 const s={id:newStepId(),op:id,params:copy(friendlySteps[id].defaults),wait:asyncOps.has(id)};
 if(id===videoOp){
  const choices=sourceChoices(flow.steps.length,'audio','input_audio_url');
  s.media={input_audio_url:choices.length?{mode:'previous',ref:choices.at(-1).ref}:{mode:'file'}};
 }
 return s;
}
function imageOutputButtons(s,i){
 return Array.from({length:Number.isInteger(s.params.n)&&s.params.n>0?Math.min(s.params.n,100):0},(_,n)=>action('imageToVideo','Изображение '+(n+1)+' → видео','btn','data-i="'+i+'" data-output="'+n+'"')+action('imageNext','Изображение '+(n+1)+' → редактировать','btn','data-i="'+i+'" data-output="'+n+'" data-mode="image-edit"')+action('imageNext','Изображение '+(n+1)+' → увеличить','btn','data-i="'+i+'" data-output="'+n+'" data-mode="image-upscale"')).join('');
}
function legacyWorkflow(){
 ensureStepIds(flow.steps);
 const rows=flow.steps.map((s,i)=>{
  const spec=specFor(s),attrs='data-i="'+i+'"';
  const buttons=action('insertAfter','＋ После','small',attrs)+action('stepup','↑','small',attrs+' aria-label="Переместить вверх" '+(i?'':'disabled'))+action('stepdown','↓','small',attrs+' aria-label="Переместить вниз" '+(i===flow.steps.length-1?'disabled':''))+action('stepdel','Убрать','small',attrs);
  let body=action('stepedit','Настроить запрос','btn',attrs);
  if(spec){
   const main=spec.fields.filter(k=>['input','prompt'].includes(k)).map(k=>friendlyField(s,i,k)).join('');
   const hasSize=spec.fields.includes('resolution');
   const settings=spec.fields.filter(k=>!['input','prompt','aspect_ratio','resolution'].includes(k)&&!(s.op===imageOp&&k==='model')).map(k=>friendlyField(s,i,k)).join('');
   const media=workflowMedia(s).map(([k,v])=>mediaPicker(s,i,k,v)).join('');
   if(s.op===portraitOp){
    const size=resolutionChoices(s).length||s.params.resolution?outputControls(s,i):'';
    const prompt=s.params.model?.endsWith('/omnihuman-v2')||s.params.prompt?friendlyField(s,i,'prompt'):'';
    body=friendlyField(s,i,'model')+media+prompt+size+hint('Длительность задаёт исходная запись. '+docsLink('lip-sync'));
   }else{
    const audioMode=s.op===videoOp && ltxVariant(s.params.model) && sourceOf(s,'input_audio_url').mode!=='none';
    const modeHint=audioMode?hint('LTX · видео по аудиодорожке. Оценка и отправка используют указанную длительность видео. Подберите её под запись.'):'';
    body=(s.op===imageOp?friendlyField(s,i,'model')+(modeOf(s)!=='image-upscale'?'<section class="panel"><h3>Формат изображения</h3><div class="formgrid compact">'+(imageSizing(s.params.model).sizes.length?friendlyField(s,i,'size')+(imageSizing(s.params.model).qualities.length?friendlyField(s,i,'quality'):''):friendlyField(s,i,'aspect_ratio')+friendlyField(s,i,'resolution'))+'</div></section>':''):'')+(s.op===videoOp?videoModelPicker(s,i):'')+modeHint+(hasSize?outputControls(s,i):'')+main+media+(settings?'<details><summary>Настройки · '+h(s.params.model||spec.name)+'</summary><div class="formgrid compact">'+settings+'</div></details>':'');
    if([videoOp,imageOp].includes(s.op))body+=action('stepedit','Все параметры запроса','linkbtn',attrs);
   }
  }
  if([videoOp,portraitOp,imageOp].includes(s.op))body+=action('stepQuote','Оценить стоимость шага','btn',attrs);
  if(s.op===imageOp)body+='<div class="toolbar" data-image-outputs="'+i+'">'+imageOutputButtons(s,i)+'</div>'+hint('Выберите номер результата заранее. Следующее действие получит только выбранное изображение.');
  const problem=s.advanced?'API Explorer: расширенный запрос без проверенного контракта Studio.':contractError(s);
  if(problem)body='<p class="bad">'+h(problem)+'</p>'+body;
  const savedQuote=s.quote?(s.quote.key===quoteKey(s)?'Оценка · '+usd(s.quote.response.estimated_cost_usd)+' · максимум '+usd(s.quote.response.max_cost_usd):'Оценка устарела — параметры изменились'):'Оценка пока не получена';
  const links=Object.entries(s.media||{}).filter(([,src])=>src.stepId).map(([key,src])=>'Шаг '+(flow.steps.findIndex(row=>row.id===src.stepId)+1)+' → Изображение '+(src.index+1)+' → '+(specFor(s)?.media[key]?.[0]||key)).join(' · ');
  return '<section class="step" id="workflow-step-'+i+'"><div class="between"><div><small class="muted">Шаг '+(i+1)+'</small><h2>'+h(stageName(s))+'</h2></div><div class="actions">'+action('collapseStep',s.collapsed?'Развернуть':'Свернуть','small',attrs)+buttons+'</div></div>'+hint(h(links||s.params.model||''))+'<p class="hint" data-quote-status="'+i+'">'+h(savedQuote)+'</p>'+(s.collapsed?(problem?'<p class="bad">'+h(problem)+'</p>':''):'<div class="wfbody">'+body+'</div>')+(spec?'<p class="hint">Результат · '+spec.output+'</p>':'')+'</section>';
 }).join('');
 return title('Workflow',action('load','Открыть')+action('fresh','Новый'))+'<p id="draftStatus" role="status" class="hint">'+h(draftMessage)+'</p><label class="field">Название workflow<input id="flowname" class="flowname" value="'+h(flow.name)+'"></label>'+
 '<div class="toolbar" aria-label="Шаги workflow">'+flow.steps.map((s,i)=>action('gotoStep',(i+1)+'. '+h(stageName(s)),'small','data-i="'+i+'"')).join('')+'</div>'+
 (rows||'<div class="panel compact"><h2>С чего начнём?</h2>'+hint('Для готовой записи выберите «Создать видео». Для отдельного MP3 из текста выберите «Озвучить текст».')+action('template','Создать видео с LTX','primary')+'</div>')+
 '<div class="toolbar">'+action('addstep','＋ Добавить шаг')+'</div><hr class="sep"><div class="actions">'+action('saveflow','Сохранить')+(flow.steps.length?action('budget','Оптимизировать бюджет'):'')+action('runflow','Запустить workflow →','primary')+'</div>';
}

function setMediaSource(s,key,source){
 s.media||={};
 if(key.includes('#')){const [port,slot]=key.split('#');s.media[port]||={mode:'list',items:[]};s.media[port].items[+slot]=source;delete s.params[port]}
 else{s.media[key]=source;delete s.params[key]}
}
function ensureGroups(){
 flow.id||=newStepId();ensureStepIds(flow.steps);
 if(!flow.groups)flow.groups=flow.steps.map((s,i)=>({id:'step-'+s.id,name:'Step '+(i+1),continueOnSuccess:true,nodeIds:[s.id]}));
 for(const g of flow.groups)g.nodeIds=g.nodeIds.filter(id=>flow.steps.some(s=>s.id===id));
 for(const s of flow.steps)if(!flow.groups.some(g=>g.nodeIds.includes(s.id)))flow.groups.push({id:'step-'+s.id,name:'Step '+(flow.groups.length+1),continueOnSuccess:true,nodeIds:[s.id]});
}
const inputLabels={input_references:'Изображения-референсы',input_video_references:'Видео-референсы',input_audio_references:'Аудио-референсы',start_image_url:'Стартовое изображение',end_image_url:'Последний кадр',input_audio_url:'Звуковая дорожка',input_video_url:'Исходное видео',audio_url:'Аудиозапись',image_url:'Портрет',video_url:'Видео',face_image_url:'Исходное лицо',file:'Аудиофайл'};
function graphField(s,i,key){
 if(s.op===imageOp&&['resolution','aspect_ratio'].includes(key)&&imageSizing(s.params.model).sizes.length)return '';
 if(['size','quality'].includes(key)&&!imageSizing(s.params.model)[key==='size'?'sizes':'qualities'].length)return '';
 if(['resolution','aspect_ratio'].includes(key)){
  const value=s.params[key]||'',choices=key==='aspect_ratio'?['16:9','9:16','1:1','4:3','3:4','21:9']:s.op===imageOp?['512','1K','2K','4K']:['480p','540p','720p','1080p','1440p','2160p'];
  return '<label class="field">'+fieldNames[key]+'<select data-wf-field="'+key+'" data-i="'+i+'">'+options([...new Set([...choices,value].filter(Boolean))],value,'По умолчанию')+'</select></label>';
 }
 if(['size','quality','aspect_ratio','resolution','n','prompt','input'].includes(key))return friendlyField(s,i,key);
 const value=s.params[key],attr='data-wf-field="'+key+'" data-i="'+i+'"';
 if(key==='model'){
  const choices=[...new Set([s.params.model,...modelChoices(operationIdFor(s),models).map(m=>m.id),...modelChoices(operationIdFor(s),cat.models).map(m=>m.id)].filter(Boolean))];
  return '<label class="field">Модель<select '+attr+'>'+options(choices,s.params.model)+'</select></label>';
 }
 if(['messages','modalities','audio','keyframes'].includes(key))return '<label class="field full">'+key+'<textarea '+attr+' data-json-field rows="3">'+h(typeof value==='object'?fmt(value):value||'')+'</textarea></label>';
 if(['instrumental','source_face_consent','draft'].includes(key))return '<label class="field">'+key+'<select '+attr+' data-boolean-field>'+options(['true','false'],value==null?'':String(value),'Не задано')+'</select></label>';
 return '<label class="field">'+h(fieldNames[key]||key)+'<input '+attr+' type="'+(['duration','duration_secs','scale_factor','speed','fps'].includes(key)?'number':'text')+'" step="any" value="'+h(value??'')+'"></label>';
}
function graphMedia(s,i){
 const d=operations[operationIdFor(s)],attrs='data-i="'+i+'"';
 let media='';
 for(const [key,port] of Object.entries(d.inputs)){
  if(key==='input_references'&&s.media?.reference_image){s.media[key]={mode:'list',items:[s.media.reference_image]};delete s.media.reference_image}
  if(port.multiple){
   if(!s.media?.[key]){
    const values=s.params[key]||[];(s.media||={})[key]={mode:'list',items:values.map(v=>({mode:'url',url:v[port.type+'_url']?.url}))};delete s.params[key];
   }
   const items=s.media[key].items||[];
   media+='<section class="reference-list"><h3>'+inputLabels[key]+'</h3>'+items.map((src,j)=>mediaPicker(s,i,key+'#'+j,[port.type+' '+(j+1),port.type])+action('removeReference','Убрать reference','small',attrs+' data-key="'+key+'" data-slot="'+j+'"')).join('')+action('addReference','＋ Reference','btn',attrs+' data-key="'+key+'"')+'</section>';
  }else media+=mediaPicker(s,i,key,[inputLabels[key]||key,port.type]);
 }
 return media;
}
function graphCard(s,i,locked){
 const mode=operationIdFor(s),d=operations[mode],attrs='data-i="'+i+'"';
 const media=graphMedia(s,i);
 const modes=Object.entries(operations).filter(([,o])=>o.kind===d.kind&&o.kind!=='api');
 const modeControl=modes.length?'<label class="field">Режим<select data-node-mode '+attrs+'>'+modes.map(([key,o])=>'<option value="'+key+'" '+(key===mode?'selected':'')+'>'+h(o.name)+'</option>').join('')+'</select></label>':'';
 const fields=d.fields.filter(k=>!(k==='modalities'&&mode.startsWith('chat-'))).map(k=>graphField(s,i,k)).join('');
 const saved=s.quote?(s.quote.key===quoteKey(s)?'Оценка · '+usd(s.quote.response.estimated_cost_usd):'Оценка устарела'):'Оценка пока не получена';
 const linked=JSON.stringify(s.media||{}).match(/"stepId":"[^"]+"/g)?.length||0;
 const group=flow.groups.find(g=>g.nodeIds.includes(s.id));
 return '<section class="step graph-card tone-'+(group.nodeIds.indexOf(s.id)%2)+'" id="workflow-step-'+i+'"><div class="between"><div><small>'+h(d.kind.toUpperCase())+' · '+(i+1)+'</small><h2>'+h(d.name==='API запрос'?s.op:d.name)+'</h2></div>'+action('collapseStep',s.collapsed?'Развернуть':'Свернуть','small',attrs)+'</div>'+hint(h(s.params.model||s.op)+(linked?' · Связей: '+linked:''))+'<p class="hint" data-quote-status="'+i+'">'+h(saved)+'</p>'+
  (s.collapsed?'':'<fieldset class="card-editor" '+(locked?'disabled':'')+'><div class="formgrid">'+modeControl+'<label class="field">Step<select data-node-group '+attrs+'>'+flow.groups.map(g=>'<option value="'+h(g.id)+'" '+(g===group?'selected':'')+'>'+h(g.name)+'</option>').join('')+'</select></label>'+fields+'</div><div class="wfbody">'+media+'</div><div class="toolbar">'+action('stepedit','Все параметры / API','btn',attrs)+action('stepQuote','Оценить стоимость','btn',attrs)+action('insertAfter','＋ Карточка после','small',attrs)+action('stepup','↑','small',attrs+(i?'':' disabled'))+action('stepdown','↓','small',attrs+(i<flow.steps.length-1?'':' disabled'))+action('stepdel','Убрать','small',attrs)+'</div>'+(d.kind==='image'?'<div class="toolbar" data-image-outputs="'+i+'">'+imageOutputButtons(s,i)+'</div>':'')+'</fieldset>')+'</section>';
}
function characters(kind='character'){
 const location=kind==='location';
 return title(location?'Locations':'Characters',action(location?'newLibraryLocation':'newLibraryCharacter',location?'Create location':'Create character')+action('exportCharacterContext','Export agent context'))+
  hint(location?'Reusable places: exteriors, rooms, viewpoints, and their spatial relationships. Workflows receive independent snapshots.':'Reusable descriptions and local assets. Workflows receive independent snapshots.')+characterList(state.dataCards||[],{kind});
}
function openCharacter(card,scope){characterDraft=copy(card);characterScope=scope;characterRemoved=new Set();renderCharacterEditor()}
function renderCharacterEditor(){dialog(characterEditor(characterDraft,{scope:characterScope,locked:characterScope==='workflow'&&workflowRunning(),busy:waitingFiles.size>0}))}
function replaceWorkflow(w){const session={resume:flow.resume,activeRunId:flow.activeRunId};flow={...workflowToEditor(w),...session};saveDraft()}
function emptyCharacter(kind='character'){return {id:newStepId(),kind,name:kind==='location'?'New location':'New character',description:'',...(kind==='location'?{layout:''}:{age:''}),appearance:'',scenario:'',assets:[]}}
async function characterAction(a,id,target){
 const actions=['newLibraryLocation','newWorkflowLocation','newLibraryCharacter','newWorkflowCharacter','editLibraryCharacter','editWorkflowCharacter','duplicateCharacter','deleteCharacter','exportCharacterContext','pickCharacter','attachCharacter','saveCharacter','saveCharacterAsNew','removeWorkflowCharacter','confirmRemoveWorkflowCharacter','removeCharacterAsset','confirmRemoveCharacterAsset','backCharacterEditor'];
 if(!actions.includes(a))return false;
 if(workflowRunning()&&(['attachCharacter','newWorkflowCharacter','newWorkflowLocation','removeWorkflowCharacter','confirmRemoveWorkflowCharacter'].includes(a)||characterScope==='workflow'&&['saveCharacter','removeCharacterAsset','confirmRemoveCharacterAsset'].includes(a)))throw Error('Pause the workflow before editing its data snapshots');
 if(a==='newLibraryLocation'||a==='newWorkflowLocation')openCharacter(emptyCharacter('location'),a==='newLibraryLocation'?'library':'workflow');
 if(a==='newLibraryCharacter'||a==='newWorkflowCharacter')openCharacter(emptyCharacter(),a==='newLibraryCharacter'?'library':'workflow');
 if(a==='editLibraryCharacter')openCharacter(state.dataCards.find(c=>c.id===id),'library');
 if(a==='editWorkflowCharacter')openCharacter(flow.dataCards.find(c=>c.id===id),'workflow');
 if(a==='duplicateCharacter'){await api('data-card/'+encodeURIComponent(id)+'/duplicate',{});await refresh();render()}
 if(a==='deleteCharacter')await previewDeletion({kind:'data-card',id});
 if(a==='exportCharacterContext')downloadJSON(await api('data-cards/context'),'asset-context');
 if(a==='pickCharacter'){await refresh();dialog('<h2>Add a character or location</h2>'+characterList(state.dataCards||[],{select:true,attached:(flow.dataCards||[]).map(c=>c.id)})+action('newWorkflowCharacter','Create workflow character')+action('newWorkflowLocation','Create workflow location'))}
 if(a==='attachCharacter'){
  flow.dataCards||=[];if(flow.dataCards.some(c=>c.id===id))throw Error('This card is already in the workflow');
  const card=state.dataCards.find(c=>c.id===id);if(!card)throw Error('DataCard not found');flow.dataCards.push(copy(card));close();render();saveDraft();
 }
 if(a==='saveCharacter'||a==='saveCharacterAsNew'){
  if(waitingFiles.size)throw Error('Wait for local files to finish saving');
  const [card]=normalizeDataCards([characterDraft]);
  if(a==='saveCharacterAsNew'){await api('data-card',{...card,id:newStepId()});await refresh();toast('Saved as a new library card')}
  else if(characterScope==='library'){await api('data-card',card);await refresh();close();render()}
  else{
   let w=editorToWorkflow(flow);w.dataCards||=[];
   for(const assetId of characterRemoved)if(w.dataCards.find(c=>c.id===card.id)?.assets.some(a=>a.id===assetId))w=removeCharacter(w,card.id,assetId);
   const index=w.dataCards.findIndex(c=>c.id===card.id);if(index<0)w.dataCards.push(card);else w.dataCards[index]=card;
   replaceWorkflow(w);close();render();
  }
 }
 if(a==='removeWorkflowCharacter'){
  const uses=characterUsage(editorToWorkflow(flow),id);
  dialog('<h2>Remove card from workflow?</h2>'+hint('Affected inputs: '+uses.length+'. They will need a new source. Library entries and files remain.')+action('confirmRemoveWorkflowCharacter','Remove','danger','data-id="'+h(id)+'"')+action('cancelLibrary','Cancel'));
 }
 if(a==='confirmRemoveWorkflowCharacter'){replaceWorkflow(removeCharacter(editorToWorkflow(flow),id));close();render()}
 if(a==='removeCharacterAsset'){
  const uses=characterScope==='workflow'?characterUsage(editorToWorkflow(flow),characterDraft.id,id):[];
  dialog('<h2>Remove asset?</h2>'+hint('Affected workflow inputs: '+uses.length+'. The local file and other snapshots remain.')+action('confirmRemoveCharacterAsset','Remove','danger','data-id="'+h(id)+'"')+action('backCharacterEditor','Cancel'));
 }
 if(a==='confirmRemoveCharacterAsset'){characterDraft.assets=characterDraft.assets.filter(asset=>asset.id!==id);characterRemoved.add(id);renderCharacterEditor()}
 if(a==='backCharacterEditor')renderCharacterEditor();
 return true;
}
async function uploadCharacterFiles(input){
 const draft=characterDraft,previous=draft.assets.find(a=>a.id===input.dataset.characterReplace),type=input.dataset.characterUpload||previous?.type;
 if(characterScope==='workflow'&&workflowRunning())return;
 const token={};waitingFiles.add(token);
 try{
  for(const file of input.files||[]){
   if(!file.type.startsWith(type+'/'))throw Error('Select a compatible '+type+' file');
   const saved=await saveLocalFile(file),asset={...(previous||{}),id:previous?.id||newStepId(),type,role:dataCardAssetRole(draft.kind,type),name:previous?.name||file.name,description:previous?.description||'',fileId:saved.file};
   delete asset.missing;delete asset.width;delete asset.height;delete asset.duration;
   if(type==='image'&&typeof createImageBitmap==='function'){const bitmap=await createImageBitmap(file).catch(()=>null);if(bitmap){asset.width=bitmap.width;asset.height=bitmap.height;bitmap.close()}}
   if(previous)draft.assets[draft.assets.findIndex(a=>a.id===previous.id)]=asset;else draft.assets.push(asset);
  }
 }catch(error){toast(error.message)}
 finally{waitingFiles.delete(token);if(characterDraft===draft&&$('#dialog').open)renderCharacterEditor()}
}
function roundedFlowPath(points){
 const ps=points.filter((p,i)=>!i||p.x!==points[i-1].x||p.y!==points[i-1].y);
 let path='M '+ps[0].x+' '+ps[0].y;
 for(let i=1;i<ps.length-1;i++){
  const a=ps[i-1],b=ps[i],c=ps[i+1],before=Math.hypot(b.x-a.x,b.y-a.y),after=Math.hypot(c.x-b.x,c.y-b.y),r=Math.min(10,before/2,after/2);
  path+=' L '+(b.x+(a.x-b.x)*r/before)+' '+(b.y+(a.y-b.y)*r/before)+' Q '+b.x+' '+b.y+' '+(b.x+(c.x-b.x)*r/after)+' '+(b.y+(c.y-b.y)*r/after);
 }
 const end=ps.at(-1);return path+' L '+end.x+' '+end.y;
}
function globalFlowCanvasHTML(wrapWidth){
 let w,layout;try{w=editorToWorkflow(flow);layout=layoutWorkflow(w,{wrapWidth})}catch(error){return '<p class="bad">'+h(error.message)+'</p>'}
 const positions=new Map(layout.positions.map(p=>[(p.kind==='data'?'data:':'api:')+p.id,p]));
 const connected=edge=>edge.to===selectedFlowNode||edge.fromKind!=='data'&&edge.from===selectedFlowNode;
 const edges=layout.edges.map((edge,i)=>{
  const a=positions.get((edge.fromKind==='data'?'data:':'api:')+edge.from),b=positions.get('api:'+edge.to);if(!a||!b)return '';
  const x=a.x+176,y=a.y+88,endY=b.y+88,route=layout.routes?.[i];
  const path=route?roundedFlowPath(route.points):'M '+x+' '+y+' C '+(x+28)+' '+y+', '+(b.x-28)+' '+endY+', '+b.x+' '+endY;
  const focus=selectedFlowNode?(connected(edge)?' edge-selected':' edge-muted'):'';
  const ports=route?[route.start,route.end].map(p=>'<circle cx="'+p.x+'" cy="'+p.y+'" r="3"/>').join(''):'';
  return '<g class="global-edge '+edge.kind+focus+'"><path d="'+path+'" marker-end="url(#'+(edge.kind==='location'?'workflow-location-arrow':'workflow-arrow')+')"><title>'+h(edge.label)+'</title></path>'+ports+(wrapWidth?'':'<text x="'+((x+b.x)/2)+'" y="'+((y+endY)/2-7)+'">'+h(edge.label.slice(0,45))+'</text>')+'</g>';
 }).join('');
 const groups=layout.groups.map((box,i)=>{const step=w.steps.find(g=>g.id===box.id);return '<div class="global-step-boundary '+(step.enabled===false?'stage-disabled':'')+'" data-flow-x="'+box.x+'" data-flow-y="'+box.y+'" data-flow-width="'+box.width+'" data-flow-height="'+box.height+'"><strong>'+h((i+1)+'. '+step.name)+'</strong><small>'+h(step.enabled===false?'Disabled · reuse saved outputs':step.continueOnSuccess?'Continue':'Pause after Step')+'</small></div>'}).join('');
 const nodes=layout.positions.map(p=>{
  const attrs=' data-flow-x="'+p.x+'" data-flow-y="'+p.y+'"';
  if(p.kind==='data'){const card=w.dataCards.find(c=>c.id===p.id);return '<button class="flow-square '+(card.kind==='location'?'location-square':'character-square')+'" data-a="editWorkflowCharacter" data-id="'+h(card.id)+'"'+attrs+'><small>'+h(card.kind.toUpperCase())+'</small><strong>'+h(card.name)+'</strong><small>'+card.assets.length+' assets</small>'+assetPreview(card.assets.find(a=>a.type==='image'),true)+'</button>'}
  const s=flow.steps.find(n=>n.id===p.id),d=operations[operationIdFor(s)],row=cardRuntime(s),g=w.steps.find(g=>g.id===p.stepId);
  return '<button class="flow-square tone-'+(g.nodes.findIndex(n=>n.id===s.id)%2)+(s.id===selectedFlowNode?' flow-selected':'')+'" data-a="flowNode" data-id="'+h(s.id)+'"'+attrs+'><small>'+h(d.kind.toUpperCase())+'</small><strong>'+h(d.name)+'</strong><span class="flow-model">'+h(s.params.model||s.op)+'</span><span data-node-status="'+h(s.id)+'">'+h(statuses[row?.status]||'Waiting')+'</span><span data-node-thumb="'+h(s.id)+'">'+(row?.artifacts?.[0]?mediaHTML(row.artifacts[0],true):'')+'</span></button>';
 }).join('');
 const name=(id,data)=>data?w.dataCards.find(c=>c.id===id)?.name:(()=>{const step=w.steps.find(g=>g.nodes.some(n=>n.id===id)),node=step?.nodes.find(n=>n.id===id);return step?step.name+' · '+(step.nodes.indexOf(node)+1):id})();
 const connections=selectedFlowNode?'<div class="flow-connections"><strong>Selected card connections</strong><ul>'+layout.edges.filter(connected).map(e=>'<li>'+h(name(e.from,e.fromKind==='data'))+' → '+h(name(e.to,false))+'<small>'+h(e.label)+'</small></li>').join('')+'</ul></div>':'';
 return '<div class="flow-canvas'+(layout.direction==='down'?' flow-vertical':'')+'" data-flow-width="'+layout.width+'" data-flow-height="'+layout.height+'">'+groups+'<svg class="flow-edges" width="'+layout.width+'" height="'+layout.height+'"><defs><marker id="workflow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker><marker id="workflow-location-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>'+edges+'</svg>'+nodes+'</div>'+connections;
}
function globalFlowHTML(){
 const selected=flow.steps.find(s=>s.id===selectedFlowNode);
 return '<section class="workflow-global"><h2>Workflow Flow</h2>'+hint('On phones, follow dependencies from top to bottom. Purple lines come from characters; teal lines come from locations. Tap a card to edit it and highlight its connections. Wide branches can be scrolled sideways.')+'<div class="flow-scroll" tabindex="0" aria-label="Global workflow graph">'+globalFlowCanvasHTML()+'</div>'+(selected?graphCard(selected,flow.steps.indexOf(selected),workflowRunning())+'<section data-node-result="'+h(selected.id)+'">'+nodeResultHTML(selected)+'</section>':'')+'</section>';
}
function applyFlowLayout(root=document){
 for(const el of root.querySelectorAll('[data-flow-width]')){el.style.width=el.dataset.flowWidth+'px';el.style.height=el.dataset.flowHeight+'px'}
 for(const el of root.querySelectorAll('[data-flow-x]')){el.style.left=el.dataset.flowX+'px';el.style.top=el.dataset.flowY+'px'}
}
function refreshGlobalFlowLayout(){
 const graph=$('.workflow-global .flow-scroll');if(!graph)return;
 const mobile=window.matchMedia('(max-width:760px)').matches;
 graph.innerHTML=globalFlowCanvasHTML(mobile?Math.floor(graph.clientWidth/.7):undefined);
 applyFlowLayout(graph);
}
function currentInlineRun(){return inlineRun?.workflowId===flow.id?inlineRun:null}
function workflowRunning(){return currentInlineRun()?.status==='running'}
function frozenGroup(){return workflowRunning()}
function nodeCandidates(s){return workflowOutputCache.workflowId===flow.id?(workflowOutputCache.nodes[s.id]||[]):[]}
function selectedOutput(s){const list=nodeCandidates(s);return s.reuse?.mode==='pinned'?list.find(r=>r.runId===s.reuse.runId):list.find(r=>r.kind===operations[operationIdFor(s)].kind)}
function mediaHTML(a,mini=false){
 const url=a.local_url||(a.url?.startsWith('https:')?a.url:'');
 if(a.type==='text')return '<p class="output-text">'+h(a.text||'')+'</p>';
 if(!url)return '';
 if(a.type==='image')return '<img class="'+(mini?'flow-thumb':'artifact-image')+'" src="'+h(url)+'" alt="Изображение '+(a.index+1)+'" loading="lazy">';
 if(mini)return '<span class="flow-media-label">'+h(a.type==='video'?'▶ Видео':'♫ Аудио')+'</span>';
 return '<'+(a.type==='video'?'video':'audio')+' controls preload="metadata" src="'+h(url)+'"></'+(a.type==='video'?'video':'audio')+'><a href="'+h(url)+'" target="_blank" rel="noreferrer">Открыть результат ↗</a>';
}
function cardRuntime(s){
 const r=currentInlineRun(),row=r?.steps.find(n=>n.id===s.id);
 if(row&&r.status==='running')return row;
 const source=selectedOutput(s);
 if(row&&(!source||JSON.stringify((row.artifacts||[]).map(a=>a.id))===JSON.stringify(source.artifacts.map(a=>a.id))))return row;
 return source?{status:'saved',artifacts:source.artifacts,reusedFrom:source}:row;
}
function nodeResultHTML(s){
 const row=cardRuntime(s),candidates=nodeCandidates(s),source=selectedOutput(s),locked=workflowRunning();
 const choice=candidates.length?'<label class="field output-choice">Сохранённый результат<select data-output-choice="'+s.id+'" '+(locked?'disabled':'')+'><option value="latest">Последний успешный</option>'+candidates.map(c=>'<option value="'+c.runId+'" '+(s.reuse?.mode==='pinned'&&s.reuse.runId===c.runId?'selected':'')+'>'+h(date(c.created)+' · '+(c.model||'API')+' · '+usd(c.sourceCost)+' · '+c.runId.slice(0,6))+'</option>').join('')+'</select></label>':'';
 const info=row?.reusedFrom;
 const changed=source&&JSON.stringify({...source.parameters,model:source.model})!==JSON.stringify(s.params);
 return choice+(row?'<div class="result-state">'+tag(statuses[row.status]||row.status)+(row.status!=='saved'?' '+tag('Новый расход '+usd(row.cost)):'')+'</div>'+((row.reason||row.error)?hint(h(row.reason||row.error)):'')+(info?hint('Источник: '+h(date(info.created))+' · '+h(info.model||'API')+' · прежняя стоимость '+usd(info.sourceCost)):'')+(changed?hint('Результат получен с другой конфигурацией карточки.'):'')+'<div class="inline-artifacts">'+(row.artifacts||[]).map(a=>mediaHTML(a)).join('')+'</div>':'<p class="hint">Сохранённого результата пока нет</p>');
}
function flowGraphHTML(group){
 const w=editorToWorkflow(flow),g=w.steps.find(s=>s.id===group.id),layout=layoutStep(g),position=new Map(layout.positions.map(p=>[p.id,p]));
 const edges=g.edges.filter(e=>e.from.stepId===g.id).map(e=>{const a=position.get(e.from.nodeId),b=position.get(e.to.nodeId);return '<path d="M '+(a.x+176)+' '+(a.y+88)+' C '+(a.x+200)+' '+(a.y+88)+', '+(b.x-24)+' '+(b.y+88)+', '+b.x+' '+(b.y+88)+'" marker-end="url(#arrow-'+g.id+')"/>'}).join('');
 return '<div class="flow-scroll" tabindex="0" aria-label="Граф '+h(g.name)+'"><div class="flow-canvas" data-flow-width="'+layout.width+'" data-flow-height="'+layout.height+'"><svg class="flow-edges" width="'+layout.width+'" height="'+layout.height+'" aria-hidden="true"><defs><marker id="arrow-'+g.id+'" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>'+edges+'</svg>'+layout.positions.map(p=>{
  const s=flow.steps.find(n=>n.id===p.id),d=operations[operationIdFor(s)],row=cardRuntime(s),ordinal=group.nodeIds.indexOf(s.id);
  const external=g.edges.filter(e=>e.to.nodeId===s.id&&e.from.stepId!==g.id).length+Object.values(g.nodes.find(n=>n.id===s.id).inputs).flat().filter(Boolean).length;
  return '<button type="button" class="flow-square tone-'+(ordinal%2)+'" data-a="flowNode" data-id="'+s.id+'" data-flow-x="'+p.x+'" data-flow-y="'+p.y+'"><small>'+h(d.kind.toUpperCase())+'</small><strong>'+h(d.name)+'</strong><span class="flow-model">'+h(s.params.model||s.op)+'</span>'+(external?'<small>Внешних входов: '+external+'</small>':'')+'<span data-node-status="'+s.id+'">'+h(statuses[row?.status]||'Ожидание')+'</span><span data-node-thumb="'+s.id+'">'+(row?.artifacts?.[0]?mediaHTML(row.artifacts[0],true):'')+'</span></button>';
 }).join('')+'</div></div>';
}
function runHeaderHTML(){
 const r=currentInlineRun();if(!r)return '';
 const step=lastStepRun?.workflowId===flow.id&&lastStepRun.id!==r.id?lastStepRun:null;
 return '<section class="inline-run panel"><div class="between"><div><b>'+h(r.scopeStepId?'Отдельный запуск Step':r.status==='running'?'Workflow выполняется':'Последний запуск')+'</b> '+tag(statuses[r.status]||r.status)+' '+tag('Новые вызовы '+usd(r.cost))+'</div><div class="actions">'+(r.status==='running'&&!r.scopeStepId?action('pauseInline','Пауза после текущего Step'):'')+action('openrun','История запуска','small','data-id="'+r.id+'"')+'</div></div>'+(r.error?hint(h(r.error)):'')+(step?'<div class="toolbar">'+hint('Последний отдельный Step · '+h(statuses[step.status])+' · '+usd(step.cost)+(step.error?' · '+h(step.error):''))+action('openrun','История Step','small','data-id="'+step.id+'"')+'</div>':'')+'</section>';
}
function workflow(){
 ensureGroups();const running=workflowRunning();
 return title('Workflow',action('workflowView',flow.view==='flow'?'Steps':'Workflow Flow')+action('load','Открыть')+action('exportWorkflow','Экспорт JSON')+action('importWorkflow','Импорт JSON','btn',running?'disabled':'')+action('fresh','Новый'))+'<p id="draftStatus" class="hint" role="status">'+h(draftMessage)+'</p><label class="field">Название<input id="flowname" value="'+h(flow.name)+'" '+(running?'disabled':'')+'></label><div id="inlineRunHeader">'+runHeaderHTML()+'</div>'+
 (flow.resume?hint('Пауза: проверьте результат. Можно изменить любой Step и запустить его отдельно. Продолжение использует выбранные outputs пройденных Steps.'):'')+
 workflowCharacters(flow.dataCards||[],running)+(flow.view==='flow'?globalFlowHTML():'')+
 flow.groups.map((g,gi)=>{
  const locked=frozenGroup(),stage=currentInlineRun()?.stages.find(s=>s.stepId===g.id),toggleLocked=running&&(!!currentInlineRun()?.scopeStepId||stage?.status!=='waiting');
  const cards=flow.steps.filter(s=>g.nodeIds.includes(s.id));
  return '<section class="workflow-stage '+(g.enabled===false?'stage-disabled':'')+'" data-stage="'+g.id+'"><div class="between"><h2>'+h(g.name)+'</h2><div class="actions"><label class="check"><input type="checkbox" data-enabled="'+g.id+'" '+(g.enabled!==false?'checked':'')+' '+(toggleLocked?'disabled':'')+'>Включён</label>'+action('runStep','Запустить Step','primary','data-id="'+g.id+'" '+(locked||!cards.length?'disabled':''))+action('groupView',g.view==='flow'?'Карточки':'Flow','btn','data-id="'+g.id+'"')+action('groupUp','↑','small','aria-label="Переместить '+h(g.name)+' выше" data-id="'+g.id+'" '+(locked||gi===0?'disabled':''))+action('groupDown','↓','small','aria-label="Переместить '+h(g.name)+' ниже" data-id="'+g.id+'" '+(locked||gi===flow.groups.length-1?'disabled':''))+action('deleteGroup','Удалить','small','data-id="'+g.id+'" '+(locked?'disabled':''))+action('addCard','＋ Карточка','btn','data-id="'+g.id+'" '+(locked?'disabled':''))+'</div></div><p class="hint" data-stage-status="'+g.id+'">'+h(stage?statuses[stage.status]||stage.status:g.enabled===false?'Отключён: использовать сохранённые результаты':'')+'</p>'+
  (flow.view==='flow'?'':g.view==='flow'?flowGraphHTML(g)+(g.nodeIds.includes(selectedFlowNode)?graphCard(flow.steps.find(s=>s.id===selectedFlowNode),flow.steps.findIndex(s=>s.id===selectedFlowNode),locked):''):cards.map(s=>graphCard(s,flow.steps.indexOf(s),locked)).join(''))+
  '<div class="step-results" '+(flow.view==='flow'?'hidden':'')+'><h3>Результаты '+h(g.name)+'</h3>'+cards.map(s=>'<section class="node-result" data-node-result="'+s.id+'">'+nodeResultHTML(s)+'</section>').join('')+'</div></section>'+
  (gi<flow.groups.length-1?'<label class="stage-gate"><input type="checkbox" data-continue="'+g.id+'" '+(g.continueOnSuccess!==false?'checked':'')+' '+(running&&(!!currentInlineRun()?.scopeStepId||stage&&['completed','reused','skipped'].includes(stage.status))?'disabled':'')+'> Continue после '+h(g.name)+' <span class="hint">выключено → Pause</span></label>':'');
 }).join('')+
 '<div class="toolbar">'+action('newGroup','＋ Добавить Step','btn',running?'disabled':'')+action('acceptanceTemplate','Шаблон: Image → Edit → References','btn',running?'disabled':'')+'</div><hr class="sep"><div class="actions">'+action('saveflow','Сохранить')+(flow.steps.length?action('budget','Оптимизировать бюджет','btn',running?'disabled':''):'')+action('runflow',flow.resume?'Продолжить workflow →':'Запустить workflow →','primary',running?'disabled':'')+'</div>';
}
function showWorkflow(){show('workflow');void refreshWorkflowSession().catch(e=>toast(e.message))}
async function refreshWorkflowSession(){
 const id=flow.id;if(!id)return;
 const data=await api('workflow/'+id+'/outputs');if(flow.id!==id||page!=='workflow')return;
 workflowOutputCache={workflowId:id,nodes:data.nodes||{}};
 if(data.lastStepRunId){const step=await api('run/'+data.lastStepRunId+'?view=workflow');if(flow.id!==id||page!=='workflow')return;lastStepRun=step}
 for(const origin of new Set(flow.steps.map(s=>s.reuse?.workflowId).filter(v=>v&&v!==id))){
  const extra=await api('workflow/'+origin+'/outputs');if(flow.id!==id||page!=='workflow')return;
  for(const s of flow.steps.filter(s=>s.reuse?.workflowId===origin))workflowOutputCache.nodes[s.id]=extra.nodes?.[s.id]||[];
 }
 if(!inlineRun||inlineRun.workflowId!==id)inlineRun=null;
 const activeId=data.activeRunId||flow.activeRunId||data.lastRunId;
 if(activeId){flow.activeRunId=activeId;await pollWorkflow(activeId,true)}else render();
}
async function pollWorkflow(id,initial=false){
 clearTimeout(timer);const workflowId=flow.id;
 const r=await api('run/'+id+'?view=workflow');if(page!=='workflow'||flow.id!==workflowId||r.workflowId!==workflowId)return;
 if(r.scopeStepId){
  lastStepRun=r;
  if(r.parentRunId&&r.status!=='running'){flow.activeRunId=r.parentRunId;return pollWorkflow(r.parentRunId,true)}
  if(r.parentRunId&&!flow.resume){const parent=await api('run/'+r.parentRunId+'?view=workflow');flow.resume={id:parent.id,revision:parent.revision,completedStepIds:parent.stages.filter(s=>['completed','reused','skipped'].includes(s.status)).map(s=>s.stepId)}}
 }
 const previous=inlineRun?.status;inlineRun=r;
 if(r.status==='running'&&!r.scopeStepId)for(const stage of r.stages){const g=flow.groups.find(g=>g.id===stage.stepId);if(g){g.enabled=stage.enabled!==false;g.continueOnSuccess=stage.continueOnSuccess}}
 if(r.status==='paused'){
  flow.resume={id,revision:r.revision,completedStepIds:r.stages.filter(s=>['completed','reused','skipped'].includes(s.status)).map(s=>s.stepId)};
 }else if(!r.scopeStepId)delete flow.resume;
 if(initial||previous!==r.status){
  if(r.status!=='running'){const outputs=await api('workflow/'+workflowId+'/outputs');for(const s of flow.steps.filter(s=>s.reuse?.workflowId&&s.reuse.workflowId!==workflowId))outputs.nodes[s.id]=nodeCandidates(s);workflowOutputCache={workflowId,nodes:outputs.nodes||{}}}
  const y=window.scrollY;render();window.scrollTo(0,y);
 }else{
  $('#inlineRunHeader').innerHTML=runHeaderHTML();
  for(const el of document.querySelectorAll('[data-node-result]')){
   const s=flow.steps.find(n=>n.id===el.dataset.nodeResult);if(!s)continue;
   const row=cardRuntime(s),key=JSON.stringify([row?.status,row?.artifacts,row?.reason,row?.cost]);
   if(el.dataset.resultKey!==key){el.innerHTML=nodeResultHTML(s);el.dataset.resultKey=key}
  }
  for(const el of document.querySelectorAll('[data-node-thumb]')){const a=r.steps.find(s=>s.id===el.dataset.nodeThumb)?.artifacts?.[0],key=a?.id||'';if(el.dataset.artifactId!==key){el.innerHTML=a?mediaHTML(a,true):'';el.dataset.artifactId=key}}
  for(const el of document.querySelectorAll('[data-node-status]'))el.textContent=statuses[r.steps.find(s=>s.id===el.dataset.nodeStatus)?.status]||'';
  for(const el of document.querySelectorAll('[data-stage-status]'))el.textContent=statuses[r.stages.find(s=>s.stepId===el.dataset.stageStatus)?.status]||'';
  for(const el of document.querySelectorAll('[data-enabled]'))el.disabled=!!r.scopeStepId||r.stages.find(s=>s.stepId===el.dataset.enabled)?.status!=='waiting';
 }
 saveDraft();if(r.status==='running')timer=setTimeout(()=>pollWorkflow(id).catch(e=>toast(e.message)),1200);
}
async function controlWorkflow(change){
 const r=currentInlineRun();if(!r||r.status!=='running')throw Error('Запуск не выполняется');
 try{inlineRun=await api('run/'+r.id+'/control',{revision:r.revision,...change});await pollWorkflow(r.id,true)}
 catch(e){await pollWorkflow(r.id,true);throw e}
}
function nodeWillExecute(s){
 const group=flow.groups?.find(g=>g.nodeIds.includes(s.id));
 if(group?.enabled===false||flow.resume?.completedStepIds?.includes(group?.id))return false;
 try{
  const w=editorToWorkflow(flow),reusable=Object.fromEntries(flow.steps.map(n=>[n.id,selectedOutput(n)]));
  return executionPreview(w,compileGraph(w),reusable).find(r=>r.id===s.id)?.status==='waiting';
 }catch{return true}
}
function graphActionMenu(){
 dialog('<h2>Добавить карточку</h2>'+['image','video','audio','text'].map(kind=>'<h3 class="compact">'+kind.toUpperCase()+'</h3><div class="list">'+Object.entries(operations).filter(([,d])=>d.kind===kind).map(([key,d])=>action('newCard',h(d.name),'listrow','data-id="'+key+'"')).join('')+'</div>').join('')+'<div class="toolbar">'+action('otherstep','API Explorer','btn')+'</div>');
}
function graphNewCard(mode){
 const d=operations[mode],defaults={'text-to-image':{model:'gpt-image-1',prompt:'',n:1},'image-edit':{model:'gemini-2.5-flash-image',prompt:'',n:1},'image-upscale':{model:'fal/recraft-crisp-upscale'},'reference-to-video':{model:'bytedance/seedance-2.0',prompt:'',duration_secs:5,resolution:'480p',aspect_ratio:'16:9'},speech:{model:'tts-1',input:'',voice:'alloy',response_format:'mp3'},'text-to-video':{model:'lightricks/ltx-2.5-fast',prompt:'',duration_secs:5,resolution:'720p',aspect_ratio:'16:9'}};
 return {id:newStepId(),op:d.op,action:mode,params:copy(defaults[mode]||{model:modelChoices(mode,models)[0]?.id||modelChoices(mode,cat.models)[0]?.id||''}),media:{},wait:true};
}
async function prepareGraph(stepId){
 if(waitingFiles.size)throw Error('Дождитесь добавления файла');
 const workflow=editorToWorkflow(flow);
 pending={name:stepId?flow.name+' · '+flow.groups.find(g=>g.id===stepId).name:flow.name,workflow,...(stepId?{stepId,...(flow.resume?{parentRunId:flow.resume.id,parentRevision:flow.resume.revision}:{})}:flow.resume?{runId:flow.resume.id,revision:flow.resume.revision}:{})};
 const result=await api('prepare',pending);ticket=result.ticket;pending.preview=result.preview;
 dialog('<h2>'+h(stepId?'Запустить '+flow.groups.find(g=>g.id===stepId).name:flow.resume?'Продолжить workflow':'Запустить workflow')+'</h2>'+(stepId?hint('Выполнится только этот Step, даже если он выключен для общего запуска. Другие Steps поставляют сохранённые inputs. '+(flow.resume?'Workflow останется на паузе.':'Следующие Steps автоматически не запускаются.')):'')+hint('Цена изображений и видео уточняется перед отправкой. Это оценка, не лимит списаний. Малые references передаются напрямую; upload применяется при необходимости.')+'<ol>'+result.plan.map(s=>'<li>'+h(flow.groups.find(g=>g.id===s.stepId)?.name||s.stepId)+' · '+s.nodeIds.length+' карточек</li>').join('')+'</ol>'+((result.preview||[]).map(r=>hint(h((statuses[r.status]||r.status)+' · '+(flow.steps.find(n=>n.id===r.id)?.params.model||r.id)+(r.reason?' · '+r.reason:'')))).join(''))+'<details><summary>Конфигурация запросов</summary><pre>'+h(fmt(workflow))+'</pre></details>'+action('confirm','Отправить в VideoRouter','primary'));
}

function quoteInputs(s){
 const inputs=[];
 if(flow.groups&&['video-edit','video-upscale'].includes(operationIdFor(s))){
  inputs.push(['input_video_secs','Длительность исходного видео, с','input_video_url']);
  if(operationIdFor(s)==='video-upscale')inputs.push(['input_width','Ширина исходного видео, px','input_video_url'],['input_height','Высота исходного видео, px','input_video_url']);
 }
 if(s.op===portraitOp){
  inputs.push(['audio','Длительность записи, с',s.op===portraitOp?'audio_url':'input_audio_url']);
 }
 if(s.op===portraitOp && (lipSource(s.params.model)==='video_url'||sourceOf(s,'video_url').mode!=='none')){
  inputs.push(['video','Длительность исходного видео, с','video_url']);
 }
 return inputs;
}
function openQuote(s,i){
 const inputs=quoteInputs(s);
 dialog('<h2>Оценка стоимости шага</h2>'+hint(h(s.params.model||'Модель по умолчанию'))+
  inputs.map(([name,label])=>'<label class="field">'+label+'<input id="quote-'+name+'" type="number" min="0.001" step="any" inputmode="decimal"></label>').join('')+
  (inputs.length===2?hint('Для расчёта берём длину более длинного файла.'):'')+
  (s.op===videoOp && inputs.length?hint('Для LTX цена рассчитывается по длине записи. Выбор провайдера при генерации может зависеть от самой аудиодорожки.'):'')+
  hint('Рассчитаем по заполненным параметрам этого шага. Недостающие входы не блокируют предварительную оценку. Перед генерацией цена уточняется с готовыми входами.')+
  action('requestQuote','Рассчитать','primary','data-i="'+i+'"')+'<div id="quoteResult" aria-live="polite"></div>');
 fillMediaLengths(s,inputs,name=>$('#quote-'+name));
}
function fillMediaLengths(s,inputs,findField){
 s=resolveCharacterMedia(s,flow.dataCards,{tolerateMissing:true});
 for(const [name,,key] of inputs){
  const src=sourceOf(s,key);
  if(src.mode!=='file'||!src.file)continue;
  const field=findField(name),media=document.createElement(name==='audio'?'audio':'video');
  media.preload='metadata';
  media.onloadedmetadata=()=>{
   const value=name==='input_width'?media.videoWidth:name==='input_height'?media.videoHeight:media.duration;
   if(field.isConnected&&!field.value && Number.isFinite(value)&&value>0)field.value=String(value);
   media.removeAttribute('src');media.load();
  };
  media.src='/asset/'+encodeURIComponent(src.file);
 }
}
function inputFactsKey(s){return JSON.stringify({media:resolveCharacterMedia(s,flow.dataCards,{tolerateMissing:true}).media,inputs:[s.params.audio_url,s.params.video_url,s.params.input_audio_url]})}
function quoteKey(s){return JSON.stringify({action:s.action,op:s.op,params:s.params,media:resolveCharacterMedia(s,flow.dataCards,{tolerateMissing:true}).media,facts:s.quoteFacts})}
function stepQuoteParams(s,lengths={}){
 return previewEstimate(resolveCharacterMedia(s,flow.dataCards,{tolerateMissing:true}),lengths).request;
}
async function fetchQuote(p,active){
  const {ticket}=await api('prepare',{name:'Оценка · '+(p.model||p.endpoint),steps:[{op:estimateOp,params:p}]});
  const initial=await api('run',{ticket});
  let run;
  do{
   run=await api('run/'+initial.id);
   if(run.status==='running')await new Promise(resolve=>setTimeout(resolve,500));
  }while(run.status==='running' && active());
  if(!active())return;
  if(run.status!=='completed')throw Error(run.error||'Не удалось получить оценку.');
  return run.steps[0].result;
}
async function requestQuote(s,button){
 const result=$('#quoteResult');
 const fields=quoteInputs(s).map(([name])=>[name,$('#quote-'+name)]);
 button.disabled=true;result.textContent='Запрашиваем цену…';
 try{
  const facts=Object.fromEntries(fields.map(([name,field])=>[name,Number(field.value)]));
  s.quoteFacts=facts;s.quoteFactsKey=inputFactsKey(s);
  const p=stepQuoteParams(s,facts);const key=quoteKey(s);
  fields.forEach(([,field])=>field.disabled=true);
  const q=await fetchQuote(p,()=>result.isConnected && $('#dialog').open);
  if(!q)return;
  const preview=previewEstimate(resolveCharacterMedia(s,flow.dataCards,{tolerateMissing:true}),facts);
  let adjustment='';try{assertQuoteMatches(p,q)}catch{adjustment='API рассчитало цену с другими допущениями. Проверьте их ниже; параметры шага не изменены.'}
  if(key!==quoteKey(s))throw Error('Параметры изменились: оценка устарела');
  s.quote={key,request:p,response:q,omitted:preview.omitted};saveDraft();
  const status=$('[data-quote-status="'+flow.steps.indexOf(s)+'"]');if(status)status.textContent='Оценка · '+usd(q.estimated_cost_usd)+' · максимум '+usd(q.max_cost_usd);
  result.innerHTML=(preview.omitted.length?hint('Предварительно: не учтены незаполненные входы '+h(preview.omitted.join(', '))+'. Цена может измениться.'):'')+(adjustment?hint(adjustment):'')+'<p><b>Предварительная цена с комиссией · '+(q.estimated_cost_usd==null?'пока неизвестна':usd(q.estimated_cost_usd))+'</b></p>'+
   (q.max_cost_usd!=null?hint('При переключении провайдера · до '+usd(q.max_cost_usd)):'')+
   (q.estimated_cost_usd==null?hint('API не вернул числовую цену. '+(q.pricing?.unit==='1m_tokens'?'Эта модель оплачивается по фактическим токенам; точная сумма появится после генерации.':'Проверьте формат и качество изображения.')):'')+(q.assumptions?hint('Допущения расчёта: '+h(JSON.stringify(q.assumptions))):'')+(q.notes||[]).map(note=>hint(h(note))).join('')+
   '<details><summary>Параметры расчёта и ответ</summary><pre>'+h(fmt({request:p,response:q}))+'</pre></details>';
 }catch(err){result.textContent=err.message}
 finally{button.disabled=false;fields.forEach(([,field])=>field.disabled=false)}
}

function budgetCanQuote(s){
 if(![videoOp,portraitOp].includes(s.op))return false;
 if(Object.values(s.media||{}).some(src=>['previous','file','speech','character'].includes(src.mode)))return false;
 const known=['model','prompt','duration_secs','resolution','aspect_ratio','width','height','n','draft','task_type','auto_upscale','provider','webhook_url','store',...Object.keys(friendlySteps[s.op].media)];
 return sourceOf(s,'input_video_url').mode==='none' && Object.keys(s.params).every(key=>known.includes(key));
}
function budgetModels(s,lengths){
 const p=s.params,current=p.model,lip=s.op===portraitOp;
 const basic=new Set(['model','prompt','aspect_ratio','resolution','duration_secs',...Object.keys(friendlySteps[s.op].media)]);
 if(Object.keys(p).some(k=>!basic.has(k)))return [current];
 const media=Object.keys(friendlySteps[s.op].media).filter(key=>sourceOf(s,key).mode!=='none');
 const mode=media.includes('input_audio_url')?'audio-to-video':media.includes('start_image_url')?'image-to-video':'text-to-video';
 const matches=models.filter(m=>{
  if(!lip&&!videoProfile(m.id))return false;
  if(m.id===current || modelOp(m)!==s.op || catalogRate(m)==null)return false;
  if(p.resolution&&!resolutionChoices({op:s.op,params:{model:m.id}}).includes(p.resolution))return false;
  if(lip){
   const face=lipSource(current);
   if(!face||lipSource(m.id)!==face || (p.prompt&&!m.id.endsWith('/omnihuman-v2')))return false;
   if(p.aspect_ratio && m.id!=='boson/higgs-avatar')return false;
   if(m.id.endsWith('/omnihuman-v2') && (lengths.audio<4||lengths.audio>300))return false;
   if(m.id==='boson/higgs-avatar'&&lengths.audio>60)return false;
   return m.id!=='fal/sync-lipsync-react-1'||Math.max(lengths.audio,lengths.video||0)<=15;
  }
  if(ltxVariant(m.id)){
   if(!p.prompt?.trim()|| (p.aspect_ratio&&!['1:1','16:9','9:16'].includes(p.aspect_ratio)))return false;
   const limit=ltxVariant(m.id)==='fast'&&['720p','1080p'].includes(p.resolution)?20:10;
   if((lengths.audio||p.duration_secs)>limit)return false;
  }else{
   const family=cat.models.find(row=>row.category==='video'&&row.id.split('/').pop()===m.id.split('/').pop()&&
    row.hosts?.split(' ').includes(m.owned_by));
   if(!(m.cap||family?.cap||'').split(' ').includes(mode))return false;
  }
  return media.every(key=>videoInputAvailable(m,key));
 });
 matches.sort((a,b)=>catalogRate(a)-catalogRate(b)||a.id.localeCompare(b.id));
 const sample=matches.length<=4?matches:[matches[0],matches[1],matches[Math.floor(matches.length/2)],matches.at(-1)];
 return [current,...sample.map(m=>m.id)];
}
function fixedCost(s){
 if(s.op===uploadOp||s.op===estimateOp)return 0;
 if(s.op===speechOp && typeof s.params.input==='string'&&!s.params.input.startsWith('{{')){
  const model=videoModel(s.params.model);
  if(model?.pricing?.unit==='1m_characters'&&Number.isFinite(model.pricing.rates?.['*'])){
   const rate=catalogRate(model);
   if(rate!=null)return Array.from(s.params.input).length*rate/1e6;
  }
 }
 return '';
}
function budgetNumber(id,label,value=''){
 return '<label class="field">'+h(label)+'<input id="'+id+'" type="number" min="0" step="any" inputmode="decimal" value="'+h(value)+'"></label>';
}
function openBudget(){
 budgetVariants=[];
 const rows=flow.steps.map((s,i)=>{
  if(!nodeWillExecute(s))return '<p class="hint">'+h(stageName(s))+' · без новых вызовов · $0</p>';
  const quote=budgetCanQuote(s);
  const inlineSpeech=Object.values(s.media||{}).some(src=>src.mode==='speech');
  const choose=quote?'<label><input type="checkbox" id="vary-'+i+'" checked> Подбирать замену модели</label>':'';
  const media=quote?quoteInputs(s).map(([name,label])=>budgetNumber('len-'+i+'-'+name,label)).join(''):'';
  const fixed=quote?(inlineSpeech?budgetNumber('extra-'+i,'Дополнительно за встроенную озвучку, USD'):''):budgetNumber('fixed-'+i,'Стоимость фиксированного шага, USD',fixedCost(s));
  return '<fieldset class="mediafield"><legend>Шаг '+(i+1)+' · '+h(stageName(s))+'</legend>'+hint(h(s.params.model||s.op))+choose+media+fixed+'</fieldset>';
 }).join('');
 dialog('<h2>Оптимизация бюджета</h2><div id="budgetForm" class="stack"><div class="formgrid">'+budgetNumber('budgetMin','Минимум, USD',0)+budgetNumber('budgetMax','Максимум, USD')+'</div><label class="field">Для сравнения с бюджетом<select id="budgetMetric"><option value="estimated_cost_usd">Ожидаемая цена</option><option value="max_cost_usd">Цена при переключении провайдера</option></select></label>'+rows+
  hint('Сумма включает выполняемые карточки. Переиспользование результатов стоит $0. Для выбранных шагов сравним текущую модель и до четырёх замен через бесплатную оценку VideoRouter. Впишите стоимость вручную там, где автоматическая оценка недоступна.')+
  action('compareBudget','Подобрать варианты','primary')+'</div><div id="budgetResults" aria-live="polite"></div>');
 flow.steps.forEach((s,i)=>{if(nodeWillExecute(s)&&budgetCanQuote(s))fillMediaLengths(s,quoteInputs(s),name=>$('#len-'+i+'-'+name))});
}
// Bounds on remaining costs discard entire branches outside the budget.
function findBudgetPlans(groups,min,max){
 const n=groups.length,low=Array(n+1).fill(0),high=Array(n+1).fill(0);
 if(groups.some(g=>!g.length))return {plans:[],limited:false};
 for(let i=n-1;i>=0;i--){
  low[i]=low[i+1]+Math.min(...groups[i].map(o=>o.cost));
  high[i]=high[i+1]+Math.max(...groups[i].map(o=>o.cost));
 }
 const best=[null,null,null],path=[];
 let visited=0;
 function search(i,total,changes){
  if(++visited>50000 || total+low[i]>max+1e-10 || total+high[i]<min-1e-10)return;
  if(i===n){
   const score=[total,changes,-total];
   for(let k=0;k<3;k++){
    const other=best[k];
    if(!other||score[k]<other.score[k]||(score[k]===other.score[k] && (k===1?total<other.total:changes<other.changes))){
     best[k]={score,total,changes,path:[...path]};
    }
   }
   return;
  }
  for(const choice of groups[i]){
   path.push(choice);search(i+1,total+choice.cost,changes+Number(choice.changed));path.pop();
   if(visited>50000)break;
  }
 }
 search(0,0,0);
 const seen=new Set(),plans=[];
 best.forEach((plan,i)=>{
  if(!plan)return;
  const key=JSON.stringify(plan.path.map(o=>o.model));
  if(!seen.has(key)){seen.add(key);plans.push({...plan,label:['Самый дешёвый','Меньше замен','Ближе к максимуму'][i]})}
 });
 return {plans,limited:visited>50000};
}
function budgetValue(id){
 const el=$('#'+id);
 if(!el.value.trim()||!Number.isFinite(el.valueAsNumber)||el.valueAsNumber<0)throw Error('Заполните поле «'+el.parentElement.firstChild.textContent+'».');
 return el.valueAsNumber;
}
async function compareBudget(){
 const form=$('#budgetForm'),out=$('#budgetResults'),active=()=>out.isConnected&&$('#dialog').open;
 const min=budgetValue('budgetMin'),max=budgetValue('budgetMax'),metric=$('#budgetMetric').value;
 if(max<min)throw Error('Максимум бюджета должен быть не ниже минимума.');
 const jobs=flow.steps.map((s,i)=>{
  if(!nodeWillExecute(s))return {fixed:0};
  if(!budgetCanQuote(s))return {fixed:budgetValue('fixed-'+i)};
  const lengths=Object.fromEntries(quoteInputs(s).map(([name])=>[name,budgetValue('len-'+i+'-'+name)]));
  const params=stepQuoteParams(s,lengths);
  const ids=$('#vary-'+i).checked?budgetModels(s,lengths):[s.params.model];
  return {params,ids,extra:$('#extra-'+i)?budgetValue('extra-'+i):0};
 });
 budgetVariants=[];
 const controls=[...form.querySelectorAll('input,select,button')];
 controls.forEach(el=>el.disabled=true);
 const groups=[],missing=[],cache=new Map();
 try{
  for(const [i,job] of jobs.entries()){
   const original=flow.steps[i].params.model,group=[];
   groups.push(group);
   if(job.fixed!=null){group.push({model:original,cost:job.fixed,changed:false});continue}
   for(const model of job.ids){
    if(!active())return;
    out.textContent='Оценка шага '+(i+1)+' · '+(model||'по умолчанию');
    const params={...job.params,model},key=JSON.stringify(params);
    const candidate={...flow.steps[i],params:{...flow.steps[i].params,model}};
    if(contractError(candidate)){missing.push('Шаг '+(i+1)+' · '+model+' · несовместимый контракт');continue}
    let quote=cache.get(key);
    try{
     if(!quote){quote=await fetchQuote(params,active);cache.set(key,quote)}
     if(!active())return;
     if(!Number.isFinite(quote?.[metric])||quote[metric]<0)throw Error('Цена неизвестна');
     if(model!==original && params.resolution && quote.assumptions?.resolution && String(params.resolution).toLowerCase()!==String(quote.assumptions.resolution).toLowerCase())throw Error('Другое разрешение в оценке');
     if(model!==original && params.aspect_ratio && quote.assumptions?.aspect_ratio && params.aspect_ratio!==quote.assumptions.aspect_ratio)throw Error('Другой формат кадра в оценке');
     group.push({model,cost:quote[metric]+job.extra,changed:model!==original});
    }catch(err){missing.push('Шаг '+(i+1)+' · '+(model||'по умолчанию')+' · '+err.message)}
   }
  }
  if(!active())return;
  const baseline=groups.map(g=>g.find(o=>!o.changed));
  const before=baseline.every(Boolean)?baseline.reduce((v,o)=>v+o.cost,0):null;
  const {plans,limited}=findBudgetPlans(groups,min,max);
  budgetVariants=plans;
  const summary=before==null?'Исходная цена неизвестна':'Исходный workflow · '+usd(before);
  const lowest=groups.every(g=>g.length)?groups.reduce((v,g)=>v+Math.min(...g.map(o=>o.cost)),0):null;
  const variants=plans.map((plan,k)=>'<section class="panel compact"><h3>'+plan.label+' · '+usd(plan.total)+'</h3>'+
   (before!=null?hint((plan.total<=before?'Экономия · ':'Дороже на ')+usd(Math.abs(before-plan.total))):'')+
   '<ol>'+plan.path.map((o,j)=>'<li>'+h(o.changed?(flow.steps[j].params.model||'По умолчанию')+' → '+o.model:o.model||stageName(flow.steps[j]))+' · '+usd(o.cost)+'</li>').join('')+'</ol>'+
   (plan.changes?action('applyBudget','Применить к черновику','btn','data-i="'+k+'"'):hint('Текущая конфигурация'))+'</section>').join('');
  out.innerHTML='<h3>'+summary+'</h3>'+(variants||hint('Среди проверенных комбинаций вариантов в заданном диапазоне не найдено.'+(lowest!=null?' Минимальная проверенная сумма · '+usd(lowest):'')))+
   (limited?hint('Показан результат ограниченного перебора комбинаций.'):'')+
   (missing.length?'<details><summary>Исключённые оценки · '+missing.length+'</summary><ul>'+missing.map(v=>'<li>'+h(v)+'</li>').join('')+'</ul></details>':'');
 }finally{controls.forEach(el=>el.disabled=false)}
}

function compileWorkflow(steps){
 if(waitingFiles.size)throw Error('Дождитесь добавления файла с компьютера');
 ensureStepIds(steps);
 validateImageBindings(steps,[...models,...cat.models]);
 const plan=[],positions=[];
 let sourceStepId;
 const add=step=>plan.push({...step,id:newStepId(),sourceStepId});
 function remap(string){
  return string.replace(/^\{\{(\d+)((?:\.[\w-]+)*)\}\}$/,(_,number,rest)=>{
   if(!positions[number-1])throw Error('Выберите доступный предыдущий шаг');
   return '{{'+positions[number-1]+rest+'}}';
  });
 }
 function remapTree(v){
  if(typeof v==='string')return remap(v);
  if(Array.isArray(v))return v.map(remapTree);
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,remapTree(x)]));
  return v;
 }
 function upload(file){
  add({op:uploadOp,params:{file}});
  return '{{'+plan.length+'.url}}';
 }
 for(const [index,s] of steps.entries()){
  sourceStepId=s.id;
  const fields=remapTree(s.params);
  for(const [key,src] of Object.entries(s.media||{})){
   delete fields[key];
   const label=specFor(s)?.media[key]?.[0]||key;
   const error=msg=>Error('Шаг '+(index+1)+' · '+label+'. '+msg);
   if(src.mode==='none')continue;
   if(src.mode==='url'){
    let url;try{url=new URL(src.url)}catch{}
    if(url?.protocol!=='https:'||!url.hostname)throw error('Введите полную HTTPS-ссылку.');
    fields[key]=url.href;
   }else if(src.mode==='file'){
    if(!src.file)throw error('Выберите файл с компьютера.');
    fields[key]=key==='file'?src.file:upload(src.file);
   }else if(src.mode==='previous'){
    if(src.stepId){fields[key]={$artifact:{stepId:src.stepId,port:src.port,index:src.index,type:'image'}};continue}
    if(!src.ref)throw error('Выберите предыдущий шаг.');
    const ref=remap(src.ref);
    fields[key]=key!=='file'&&ref.endsWith('.file}}')?upload(ref):ref;
   }else if(src.mode==='speech'){
    if(!src.text?.trim())throw error('Введите текст для озвучки.');
    add({op:speechOp,params:{model:'tts-1',voice:src.voice||'alloy',input:src.text,response_format:'mp3'}});
    fields[key]=upload('{{'+plan.length+'.file}}');
   }
  }
  if(s.op===imageOp&&fields.reference_image){fields.input_references=[{type:'image_url',image_url:{url:fields.reference_image}}];delete fields.reference_image}
  const facts=s.quoteFactsKey===inputFactsKey(s)?s.quoteFacts||{}:{};
  if(!s.advanced)assertContract(s,fields,{complete:true,facts});
  if([uploadOp,'POST /v1/audio/transcriptions'].includes(s.op)&&!fields.file)throw Error('Шаг '+(index+1)+'. Выберите файл.');
  add({op:s.op,params:normalizeRequest(s.op,fields),wait:s.wait,contractMode:s.advanced?undefined:modeOf(s),quoteFacts:facts,quoteBeforeRun:[imageOp,videoOp].includes(s.op)});positions.push(plan.length);
 }
 return plan;
}

const unitNames={second:'с',minute:'мин',clip:'ролик',image:'изобр.',song:'трек',model:'модель','1m_tokens':'1 млн токенов','1m_characters':'1 млн символов','1m_bytes':'1 млн байт',megapixel:'Мп',compute_second:'с вычислений'};
function catalogRate(m){
 const p=m.pricing;
 if(!p?.rates||p.currency!=='USD'||!Number.isFinite(p.platform_fee_rate))return null;
 const values=Object.entries(p.rates).filter(([key,n])=>Number.isFinite(n)&&n>=0&&!['world_setup_fee','min_billed_seconds'].includes(key)).map(([,n])=>n);
 const base=p.unit==='1m_tokens'?p.rates.input:Math.min(...values);
 return Number.isFinite(base)?base*(1+p.platform_fee_rate):null;
}
function rateLabel(m){
 const rate=catalogRate(m);
 if(rate==null)return 'Цена по запросу';
 const token=m.pricing.unit==='1m_tokens',unit=unitNames[m.pricing.unit]||m.pricing.unit;
 const amount=rate.toLocaleString('en-US',{maximumSignificantDigits:6});
 return (token?'Вход ':Object.keys(m.pricing.rates).length>1?'от ':'')+'$'+amount+' / '+unit;
}
function sortOptions(){
 return [['','Порядок каталога'],['asc','Сначала дешевле'],['desc','Сначала дороже']].map(([v,label])=>'<option value="'+v+'" '+(priceSort===v?'selected':'')+'>'+label+'</option>').join('');
}
function listModels(){
 const q=modelFilter.toLowerCase(),list=models.filter(m=>(!modelGroup||m.category===modelGroup)&&(!priceUnit||m.pricing?.unit===priceUnit)&&[m.id,m.hosts,m.cap].join(' ').toLowerCase().includes(q));
 if(priceSort)list.sort((a,b)=>{
  const x=catalogRate(a),y=catalogRate(b);
  if(x==null || y==null)return Number(x==null)-Number(y==null);
  return a.pricing.unit.localeCompare(b.pricing.unit)||(priceSort==='asc'?x-y:y-x)||a.id.localeCompare(b.id);
 });
 const pages=Math.max(1,Math.ceil(list.length/35));modelPage=Math.min(modelPage,pages-1);
 return '<div class="pagination">'+list.length+' моделей '+action('prev','←','small',modelPage===0?'disabled':'')+(modelPage+1)+' / '+pages+' '+action('next','→','small',modelPage+1>=pages?'disabled':'')+'</div><div class="list">'+(list.slice(modelPage*35,modelPage*35+35).map(m=>'<button class="listrow modelrow" data-a="model" data-id="'+h(m.id)+'"><b>'+h(m.id)+'</b><small>'+h(m.cap||m.type||'')+'</small><span>'+h(rateLabel(m))+'</span>'+tag(m.category)+'</button>').join('')||no('Модели не найдены.'))+'</div>';
}
function modelView(){
 return title('Модели',action('syncmodels','Обновить из API'))+'<p class="groupnote">'+(state.modelCache?'Каталог API от '+date(state.modelCache):'Снимок публичного каталога · 10 ноября 2026')+'</p><div class="filters"><input id="modelsQ" placeholder="Поиск по модели, режиму или провайдеру…" value="'+h(modelFilter)+'"><select id="modelGroup">'+options([...new Set(models.map(x=>x.category))].sort(),modelGroup,'Все типы')+'</select><select id="priceUnit" aria-label="Единица тарифа">'+options([...new Set(models.map(m=>m.pricing?.unit).filter(Boolean))].sort(),priceUnit,'Все единицы тарифа')+'</select><select id="priceSort" aria-label="Сортировка по цене">'+sortOptions()+'</select></div>'+hint('Тарифы в USD с комиссией. Сортировка по цене группирует модели с одинаковой единицей оплаты.')+'<div id="modelList">'+listModels()+'</div>';
}
function guideRows(){return cat.guides.filter(g=>(g.title+' '+g.slug).toLowerCase().includes(docFilter.toLowerCase())).map(g=>'<a class="listrow" target="_blank" rel="noreferrer" href="https://videorouter.sh/docs/'+h(g.slug)+'">'+h(g.title)+'<small>↗</small></a>').join('')||no('Ничего не найдено.')}
function docs(){return title('Документация')+'<div class="filters"><input id="docsQ" placeholder="Найти раздел документации…" value="'+h(docFilter)+'"></div><div class="list" id="guides">'+guideRows()+'</div>'}
function settings(){
 return title('Подключение')+'<div class="panel stack"><h2>Ключи VideoRouter</h2>'+hint('Ключи хранятся в памяти локального сервера до его остановки. При запуске из терминала можно задать VIDEOROUTER_API_KEY и VIDEOROUTER_MANAGEMENT_KEY.')+
 ['api','management'].map(k=>'<label class="field">'+(k==='api'?'API key · модели, задания и баланс':'Management key · ключи и статистика расходов')+'<input type="password" autocomplete="off" id="key_'+k+'" placeholder="'+(state.keys[k]?'Подключён':'Ключ не задан')+'"></label>').join('')+
 '<div class="actions">'+action('keys','Применить ключи','primary')+action('forget','Отключить ключи')+'</div></div>'+webhookSettings()+'<section class="panel compact"><div class="between"><h2>Кошелёк</h2>'+action('balance','Обновить баланс')+'</div>'+(state.account?'<pre>'+h(fmt(state.account))+'</pre>':hint('Баланс появится после запроса к аккаунту.'))+'</section>';
}
function webhookSettings(){
 const w=state.webhook||{};
 return '<section class="panel stack"><h2>Webhook + polling</h2>'+hint(w.ready?'Приёмник подключён. Polling продолжает работать.':w.enabled?'Введите webhook secret после перезапуска сервера. Polling продолжает работать.':'Webhook отключён. Результаты получаем через polling.')+
 '<label class="field">Публичный HTTPS URL<input id="webhook_url" type="url" value="'+h(w.url||'')+'" placeholder="https://device.tailnet.ts.net/webhooks/videorouter"></label>'+
 '<label class="field">Webhook secret · Org admin → Webhooks<input id="webhook_secret" type="password" autocomplete="off" placeholder="'+(w.secretConfigured?'Подключён; оставьте пустым, чтобы сохранить':'whsec_…')+'"></label>'+
 hint('Секрет хранится только в памяти сервера. Funnel направляется на порт '+h(w.port??8792)+'. Адрес для проверки: /health. Настройка применяется к новым заданиям Video, lip-sync, face-swap и Async Jobs.')+
 (w.error?hint(h(w.error)):'')+(w.lastReceived?hint('Последнее уведомление: '+date(new Date(w.lastReceived).toISOString())+' · Получено: '+h(w.received)):'')+
 '<div class="actions">'+action('webhook-save','Подключить webhook','primary')+action('webhook-disable','Отключить webhook')+'</div></section>';
}
function render(){
 $('#view').innerHTML=({dashboard,characters,locations:()=>characters('location'),api:explorer,workflow,models:modelView,docs,settings,runs:()=>title('История запусков',action('refresh','Обновить')+action('clearHistory','Очистить завершённые','btn',state.runs.some(r=>['completed','failed','interrupted'].includes(r.status))?'':'disabled'))+runRows(state.runs)})[page]();
 applyFlowLayout();refreshGlobalFlowLayout();
}
async function refresh(){state=await api('state');header()}
function template(){
 flow={name:'LTX 2.5 · видео с озвучкой',steps:[]};
 flow.steps.push(makeStep(videoOp));editIndex=-1;showWorkflow();
}
function checkVideoRequest(s){
 const p=s.params,model=p.model;
 if(s.op===videoOp){
  if(p.audio_url||p.image_url||p.video_url)throw Error('Поля audio_url, image_url и video_url относятся к синхронизации губ. Проверьте выбранную операцию.');
  if(p.input_audio_url && !ltxVariant(model))throw Error('Для одной звуковой дорожки выберите LTX-2.5 Fast или Pro либо пропустите дорожку.');
  if(p.input_audio_url && ltxVariant(model)==='fast' && p.provider?.only?.length===1 && p.provider.only[0]==='fal')throw Error('VideoRouter исключил fal для LTX-2.5 Fast с аудио. Уберите ограничение provider.only, чтобы разрешить прямой маршрут LTX.');
  if(ltxVariant(model)&&!p.prompt?.trim())throw Error('Заполните описание сцены для запроса LTX через VideoRouter.');
 }
 if(s.op!==portraitOp)return;
 if(!model||!p.audio_url)throw Error('Для синхронизации губ выберите модель и запись речи.');
 const key=lipSource(model);
 if((key&&!p[key])||Boolean(p.image_url)===Boolean(p.video_url)){
  throw Error(key?'Для '+model+' нужны запись речи и '+(key==='image_url'?'только портрет (image_url).':'только исходное видео (video_url).'):'Выберите один источник лица — портрет или видео.');
 }
 if(['input_audio_url','start_image_url','input_video_url','duration_secs','width','height'].some(k=>p[k]!=null))throw Error('Проверьте поля синхронизации губ. Длительность задают исходные медиа, а размер зависит от модели.');
 if(key && p.prompt && !model.endsWith('/omnihuman-v2'))throw Error('Описание сцены доступно для OmniHuman v2. Очистите описание для выбранной модели.');
 if(key && p.resolution && !resolutionChoices(s).includes(p.resolution))throw Error('Выберите доступное разрешение или «По умолчанию» для '+model+'.');
 if(key && p.aspect_ratio && model!=='boson/higgs-avatar')throw Error('Эта модель синхронизации губ не предлагает выбор aspect_ratio. Уберите поле в API Explorer.');
}
async function prepare(config){
 if(!config.ws){
  if(!config.steps.length)throw Error('Добавьте шаг workflow');
  for(const [i,s] of config.steps.entries()){
   const r=op(s.op);
   for(const f of r.fields)if(f.required&&at(s.params,f.name)===undefined&&!r.path.includes('{'+f.name+'}'))throw Error('Шаг '+(i+1)+': заполните '+f.name);
   if(s.op==='POST /v1/audio/speech'&&!s.params.input?.trim())throw Error('Заполните текст озвучки в первом шаге');
   if(s.op===imageOp&&s.contractMode!=='image-upscale'&&!s.params.prompt?.trim())throw Error('Заполните описание изображения');
   checkVideoRequest(s);
  }
 }
 if(config.steps?.some(s=>s.quoteBeforeRun))config.pricePolicy='Оценка каждого изображения и видео уточняется перед отправкой. Это справочная оценка, не лимит расходов. При ошибке оценки цепочка останавливается.';
 const result=await api('prepare',config);ticket=result.ticket;pending=config;
 dialog('<h2>Подтвердить запрос к VideoRouter</h2>'+(config.pricePolicy?hint(h(config.pricePolicy)):'')+hint('Сервер отправит указанные параметры и выбранные файлы. Для генерации, загрузки и изменений аккаунта требуется ваше разрешение на этот запуск.')+(config.titles?'<ol>'+config.titles.map(t=>'<li>'+h(t)+'</li>').join('')+'</ol><p>'+config.steps.length+' операций в цепочке</p><details><summary>Параметры отправки</summary><pre>'+h(fmt(config.steps))+'</pre></details>':'<pre>'+h(fmt(config.ws?config.params:config.steps))+'</pre>')+action('confirm','Отправить в VideoRouter','primary'));
}
function resultLinks(v){
 if(!v||typeof v!=='object')return '';
 const links=[];const visit=(o)=>{if(!o||typeof o!=='object')return;
 if(o.local_url&&/^\/asset\/[a-f\d-]+$/.test(o.local_url))links.push('<a href="'+h(o.local_url)+'" download="'+h(o.name)+'">Скачать '+h(o.name)+'</a>');
 for(const [k,x] of Object.entries(o)){if(k==='url'&&typeof x==='string'&&x.startsWith('https://'))links.push('<a href="'+h(x)+'" target="_blank" rel="noreferrer">Открыть результат ↗</a>');else if(typeof x==='object')visit(x)}
 };visit(v);return [...new Set(links)].join(' · ');
}
async function detail(id){
 clearTimeout(timer);runId=id;const r=await api('run/'+id);if(runId!==id||page!=='runs')return;
 $('#view').innerHTML=title(r.name,action('allruns','Все запуски')+(r.config?action('restoreRun','Открыть как черновик'):''))+'<div class="chips">'+tag(statuses[r.status])+tag(date(r.created))+tag('Учтено '+usd(r.cost))+'</div>'+(r.error?'<pre class="bad">'+h(r.error)+'</pre>':'')+
 (r.config?'<details class="compact"><summary>Исходная конфигурация и план запуска</summary><pre>'+h(fmt(r.config))+'</pre></details>':hint('Старая запись: исходная конфигурация не сохранена. Восстановление недоступно.'))+
 r.steps.map((s,i)=>'<section class="step"><div class="between"><b class="mono">'+(i+1)+'. '+h(s.op)+'</b>'+tag(statuses[s.status])+'</div>'+(s.sourceStepId?hint('ID шага workflow · '+h(s.sourceStepId)):'')+(s.error?hint(h(s.error)):'')+(s.estimate?'<details><summary>Оценка перед отправкой · '+usd(s.estimate.response.estimated_cost_usd)+'</summary><pre>'+h(fmt(s.estimate))+'</pre></details>':'')+(s.artifacts?'<div class="artifacts">'+s.artifacts.map(a=>'<div>'+h(({image:'Изображение',video:'Видео',audio:'Аудио',text:'Текст'}[a.type]||'Результат')+' '+(a.index+1))+(a.local_url&&a.type==='image'?'<img class="artifact-image" src="'+h(a.local_url)+'" alt="Изображение '+(a.index+1)+'">':'')+(a.url?'<a target="_blank" rel="noreferrer" href="'+h(a.url)+'">Открыть результат ↗</a>':'')+'</div>').join('')+'</div>':'')+(s.request?'<details><summary>Фактические параметры запроса</summary><pre>'+h(fmt(s.request))+'</pre></details>':'')+(s.remoteId?hint('Job ID · <code>'+h(s.remoteId)+'</code>'):'')+(s.remoteStatus?hint(h(s.result?.status||s.remoteStatus)):'')+(s.lastEvent?'<pre>'+h(s.lastEvent)+'</pre>':'')+(s.result?'<div class="compact">'+resultLinks(s.result)+'</div><details open><summary>Ответ</summary><pre>'+h(fmt(s.result).slice(0,24000))+'</pre></details>'+action('resultjson','Скачать JSON','small','data-i="'+i+'"'):'')+'</section>').join('');
 if(r.version===2){
  const attempts=(r.revisions||[]).filter(v=>v.steps?.some(s=>s.request));
  if(attempts.length)$('#view').insertAdjacentHTML('beforeend','<details class="panel"><summary>Предыдущие результаты и запросы этого запуска · учтено '+usd(r.carriedCost)+'</summary><pre>'+h(fmt(attempts))+'</pre></details>');
  $('#view').insertAdjacentHTML('afterbegin','<section class="panel compact"><div class="toolbar">'+(r.status==='paused'?action('resumeRun','Править Steps / Продолжить','primary'):'')+(['interrupted','failed'].includes(r.status)?action('recoverRun','Проверить существующие задания','btn'):'')+'</div>'+r.stages.map((s,i)=>'<p class="help">Step '+(i+1)+' · '+h(statuses[s.status]||s.status)+' · '+(s.continueOnSuccess?'Continue':'Pause')+'</p>').join('')+'</section>');
 }
 if(r.status==='running')timer=setTimeout(()=>detail(id).catch(e=>toast(e.message)),1200);else await refresh();
}
async function socketView(){
 const s=await api('socket/'+socketId);
 $('#socketState').textContent=s.status;$('#events').textContent=s.events.map(e=>e.seq+' '+e.type+' '+e.data).join('\n');
 if(s.status!=='closed'&&$('#dialog').open)timer=setTimeout(()=>socketView().catch(e=>toast(e.message)),1000);
}
async function liveModels(){const rows=await api('models');configureModelCatalog(cat.models,rows);if(!rows.length)return cat.models;
 const publicRows=new Map(cat.models.map(m=>[m.id,m]));
 return rows.map(m=>({...publicRows.get(m.id),...m,id:m.id,category:m.type||publicRows.get(m.id)?.category||'other',cap:publicRows.get(m.id)?.cap||'',hosts:publicRows.get(m.id)?.hosts||''}));
}
function modelOp(m){
 const byCap={'lip-sync':'POST /v1/lipsync','face-swap':'POST /v1/face-swap','talking-avatar':'POST /v1/avatars/videos','live-video':'POST /v1/live-video/sessions'};
 for(const c of ['world-model','live-avatar','realtime-video-edit','realtime-video-generation','realtime-virtual-try-on'])byCap[c]='POST /v1/live-video/sessions';
 const cap=(m.cap||'').split(' ').find(c=>byCap[c]);
 const byType={video:'POST /v1/videos',image:'POST /v1/images',mesh:'POST /v1/meshes',speech:'POST /v1/audio/speech',transcription:'POST /v1/audio/transcriptions',sfx:'POST /v1/audio/sfx',music:'POST /v1/audio/music',realtime:'WS /v1/realtime',embedding:'POST /v1/embeddings',embeddings:'POST /v1/embeddings',lipsync:'POST /v1/lipsync',live_video:'POST /v1/live-video/sessions',avatar:'POST /v1/avatars/videos'};
 const endpoint=m.endpoint?.replace(/^\/api\/v1\//,'/v1/');
 return (endpoint&&cat.routes.find(r=>r.path===endpoint&&['POST','WS'].includes(r.method))?.id)||byCap[cap]||byType[m.category]||'POST /v1/chat/completions';
}
 function moveStep(from,to){
 const order=flow.steps.map((_,i)=>i);order.splice(to,0,order.splice(from,1)[0]);
 const moved=order.map((old,i)=>{
  const s=copy(flow.steps[old]);
  const mapped=JSON.parse(JSON.stringify(s).replace(/"\{\{(\d+)((?:\.[\w-]+)*)\}\}"/g,(_,n,rest)=>{
   const target=order.indexOf(+n-1);
   if(target<0||target>=i)throw Error('Этот порядок нарушит зависимость шагов');
   return '"{{'+(target+1)+rest+'}}"';
  }));return mapped;
 });if(flow.groups)compileGraph(editorToWorkflow({...flow,steps:moved}));else validateImageBindings(moved,[...models,...cat.models]);flow.steps=moved;render();
}
async function act(a,target){
 const id=target.dataset.id,i=Number(target.dataset.i);
 const structureActions=['newGroup','newCard','addCard','deleteGroup','confirmDeleteGroup','groupUp','groupDown','stepdel','stepup','stepdown','insertAfter','acceptanceTemplate','attachCharacter','newWorkflowCharacter','removeWorkflowCharacter','confirmRemoveWorkflowCharacter'];
 if(workflowRunning()&&structureActions.includes(a))throw Error('Изменение структуры доступно после паузы');
 if(page==='api'&&editIndex>=0&&['mediaMode','addReference','removeReference'].includes(a))commit();
 if(page==='api'&&editIndex>=0&&['nav','backworkflow','pick','group','otherstep','usemodel'].includes(a)){commit();saveDraft()}
 if(waitingFiles.size&&['exportWorkflow','saveCharacter','saveCharacterAsNew','stepup','stepdown','stepdel','saveflow','runflow'].includes(a))throw Error('Дождитесь добавления выбранного файла');
 if(await characterAction(a,id,target))return;
 switch(a){
  case 'workflowView':flow.view=flow.view==='flow'?'steps':'flow';render();break;
  case 'newGroup':ensureGroups();flow.groups.push({id:newStepId(),name:'Step '+(flow.groups.length+1),continueOnSuccess:true,nodeIds:[]});render();break;
  case 'deleteGroup':{
   const g=flow.groups.find(g=>g.id===id),w=editorToWorkflow(flow),links=w.steps.flatMap(s=>s.edges).filter(e=>e.from.stepId===id&&e.from.stepId!==w.steps.find(s=>s.nodes.some(n=>n.id===e.to.nodeId))?.id).length;
   dialog('<h2>Удалить '+h(g.name)+'?</h2>'+hint(g.nodeIds.length+' карточек; внешних связей: '+links+'. История и файлы останутся.')+action('confirmDeleteGroup','Удалить Step','primary','data-id="'+id+'"'));break;
  }
  case 'confirmDeleteGroup':{const session={resume:flow.resume,activeRunId:flow.activeRunId};flow={...deleteGraphStep(flow,id),...session};close();render();break}
  case 'groupUp':case 'groupDown':{const session={resume:flow.resume,activeRunId:flow.activeRunId};const g=flow.groups.findIndex(g=>g.id===id),to=g+(a==='groupUp'?-1:1);flow={...moveGraphStep(flow,id,a==='groupUp'?-1:1),...session};render();break}
  case 'groupView':{const g=flow.groups.find(g=>g.id===id);g.view=g.view==='flow'?'cards':'flow';render();break}
  case 'flowNode':selectedFlowNode=selectedFlowNode===id?'':id;render();break;
  case 'pauseInline':await controlWorkflow({pauseAfterCurrent:true});break;
  case 'runStep':if(workflowRunning())throw Error('Дождитесь текущего запроса');await prepareGraph(id);break;
  case 'addCard':selectedGroupId=id;insertionIndex=flow.steps.length;graphActionMenu();break;
  case 'newCard':insertStep(insertionIndex??flow.steps.length,graphNewCard(id));insertionIndex=null;close();render();break;
  case 'addReference':{const s=flow.steps[i];s.media||={};s.media[target.dataset.key]||={mode:'list',items:[]};s.media[target.dataset.key].items.push({mode:'file'});render();break}
  case 'removeReference':flow.steps[i].media[target.dataset.key].items.splice(+target.dataset.slot,1);render();break;
  case 'acceptanceTemplate':{
   const a=graphNewCard('text-to-image'),b=graphNewCard('image-edit'),c=graphNewCard('reference-to-video');
   a.params.prompt='A small ceramic blue teapot on a pale wooden table, soft daylight, clear product photography';
   b.params.prompt='Keep the teapot and composition, add a delicate gold stripe around the teapot.';
   b.media={input_references:{mode:'list',items:[{mode:'previous',stepId:a.id,port:'images',index:0}]}};
   c.params.prompt='A slow cinematic camera move around the teapot from @Image1, with the geometric decorative motif from @Image2 on the background. Preserve the teapot shape.';
   c.media={input_references:{mode:'list',items:[{mode:'previous',stepId:b.id,port:'images',index:0},{mode:'file'}]}};
   flow={name:'Image → Edit → Reference Video',steps:[a,b,c],groups:[{id:newStepId(),name:'Step 1 · Изображение',continueOnSuccess:true,nodeIds:[a.id,b.id]},{id:newStepId(),name:'Step 2 · Видео',continueOnSuccess:true,nodeIds:[c.id]}]};render();break;
  }
  case 'resumeRun':{const r=await api('run/'+runId);flow=workflowToEditor(r.config.workflow);flow.resume={id:r.id,revision:r.revision,completedStepIds:r.stages.filter(s=>['completed','reused','skipped'].includes(s.status)).map(s=>s.stepId)};showWorkflow();break}
  case 'recoverRun':await api('run/'+runId+'/recover',{});await detail(runId);break;
  case 'collapseStep':flow.steps[i].collapsed=!flow.steps[i].collapsed;render();break;
  case 'imageToVideo':{
   const source=flow.steps[i],index=Number(target.dataset.output),next=makeStep(videoOp);
   next.media={start_image_url:{mode:'previous',stepId:source.id,port:'images',index},input_audio_url:{mode:'none'}};
   source.collapsed=true;insertStep(i+1,next);showWorkflow();break;
  }
  case 'budget':openBudget();break;
  case 'compareBudget':await compareBudget();break;
  case 'applyBudget':{
   const variant=budgetVariants[i];if(!variant)break;
   variant.path.forEach((choice,j)=>{if(choice.changed)flow.steps[j].params.model=choice.model});
   budgetVariants=[];close();render();toast('Модели заменены в черновике');break;
  }
  case 'stepQuote':openQuote(flow.steps[i],i);break;
  case 'requestQuote':await requestQuote(flow.steps[i],target);break;
  case 'nav':runId='';editIndex=-1;await refresh();if(id==='workflow')showWorkflow();else show(id);break;
  case 'refresh':await refresh();render();break;
  case 'group':group=id;filter='';selected=cat.routes.find(r=>r.group===id&&r.method==='POST')?.id||cat.routes.find(r=>r.group===id).id;params={};editIndex=-1;editingJSON=false;show('api');break;
  case 'pick':selected=id;params={};editingJSON=false;render();break;
  case 'fields':case 'json':commit();waitJob=$('#waitJob')?.checked??true;editingJSON=a==='json';render();break;
  case 'addstep':insertionIndex=flow.steps.length;flow.groups?graphActionMenu():actionMenu();break;
  case 'insertAfter':insertionIndex=i+1;selectedGroupId=flow.groups?.find(g=>g.nodeIds.includes(flow.steps[i].id))?.id;flow.groups?graphActionMenu():actionMenu();break;
  case 'gotoStep':flow.steps[i].collapsed=false;render();$('#workflow-step-'+i).scrollIntoView({block:'start'});break;
  case 'addAction':{
   let s;
   if(actionMatrix[id].op===imageOp)s=newImageAction(id);
   else {s=makeStep(videoOp);s.action=id;s.media={input_audio_url:{mode:'none'}};const key=actionMatrix[id].input;if(key)s.media[key]={mode:'file'}}
   insertStep(insertionIndex??flow.steps.length,s);insertionIndex=null;close();showWorkflow();break;
  }
  case 'addfriendly':insertStep(insertionIndex??flow.steps.length,makeStep(id));insertionIndex=null;close();showWorkflow();break;
  case 'imageNext':{
   const source=flow.steps[i],next=newImageAction(target.dataset.mode);
   next.media={reference_image:{mode:'previous',stepId:source.id,port:'images',index:Number(target.dataset.output)}};
   insertStep(i+1,next);source.collapsed=true;flow.steps[i].collapsed=true;showWorkflow();break;
  }
  case 'selectVideoModel':{
   const s=flow.steps[i],m=videoModel(id);
   if(!modelSupportsAction(id,modeOf(s))||s.op!==videoOp)return;
   if(s.params.model!==id){s.params.model=id;toast('Модель изменена. Входы и настройки сохранены; несовместимые значения нужно исправить.')}
   render();$('[data-picker="'+i+'"] summary').focus();break;
  }
  case 'otherstep':close();toApi(videoOp);break;
  case 'mediaMode':{
   const s=flow.steps[i],key=target.dataset.key,mode=target.dataset.mode;
   if(sourceOf(s,key).mode===mode)break;
   const next={mode};
   if(mode==='previous')next.ref='';
   setMediaSource(s,key,next);render();break;
  }
  case 'append':insertStep(insertionIndex??flow.steps.length,step());insertionIndex=null;showWorkflow();break;
  case 'apply':{
   flow.steps[editIndex]=mergeEditorStep(flow.steps[editIndex],step());editIndex=-1;showWorkflow();window.scrollTo(0,workflowScroll);break;
  }
  case 'backworkflow':editIndex=-1;showWorkflow();window.scrollTo(0,workflowScroll);break;
  case 'stepedit':editorFor(i);break;
  case 'stepup':moveStep(i,i-1);break;
  case 'stepdown':moveStep(i,i+1);break;
  case 'stepdel':{
   if(flow.steps.some(s=>Object.values(s.media||{}).flatMap(src=>src.mode==='list'?src.items:[src]).some(src=>src?.stepId===flow.steps[i].id)))throw Error('Сначала удалите ссылки на этот шаг');
   const changed=flow.steps.filter((_,idx)=>idx!==i).map(s=>JSON.parse(JSON.stringify(s).replace(/"\{\{(\d+)((?:\.[\w-]+)*)\}\}"/g,(_,n,rest)=>{
    if(+n===i+1)throw Error('Сначала удалите ссылки на этот шаг');return '"{{'+(+n>i+1?+n-1:+n)+rest+'}}"';
    })));flow.steps=changed;render();break;
  }
  case 'template':template();break;
  case 'fresh':flow={name:'Новый workflow',steps:[]};render();break;
  case 'saveflow':{const saved=await api('workflow',flow.groups?editorToWorkflow(flow):flow);flow.id=saved.id;await refresh();render();toast('Workflow сохранён');break}
  case 'load':await refresh();dialog(workflowLibraryHTML());break;
  case 'deleteRun':await previewDeletion({kind:'run',id});break;
  case 'clearHistory':await previewDeletion({kind:'run',clearCompleted:true});break;
  case 'deleteFlow':await previewDeletion({kind:'flow',id});break;
  case 'cancelLibrary':pendingDeletion=null;pendingImport=null;close();break;
  case 'confirmLibraryDelete':{
   if(!pendingDeletion)throw Error('Сначала подтвердите удаление');
   const deleted=await api('library/delete',{ticket:pendingDeletion.ticket});pendingDeletion=null;close();
   if(deleted.kind==='flow'&&deleted.deleted.includes(flow.id)){flow={name:'Новый workflow',steps:[],groups:[]};inlineRun=null;lastStepRun=null;editIndex=-1}
   if(deleted.kind==='run'){
    if(deleted.deleted.includes(flow.activeRunId))delete flow.activeRunId;
    if(deleted.deleted.includes(flow.resume?.id))delete flow.resume;
    if(deleted.deleted.includes(inlineRun?.id))inlineRun=null;
    if(deleted.deleted.includes(lastStepRun?.id))lastStepRun=null;
    if(deleted.deleted.includes(runId))runId='';
   }
   workflowOutputCache={nodes:{}};await refresh();saveDraft();
   if(page==='workflow'){render();await refreshWorkflowSession()}else if(page==='runs'&&runId)await detail(runId);else render();
   if(deleted.kind==='flow')dialog(workflowLibraryHTML());toast('Удалено: '+deleted.deleted.length);break;
  }
  case 'exportWorkflow':{
   if(waitingFiles.size)throw Error('Дождитесь добавления выбранного файла');
   const exported=await api('workflow/export',{workflow:flow.groups?editorToWorkflow(flow):flow});downloadJSON(exported.workflow,exported.workflow.name);
   if(exported.warnings.length)dialog('<h2>Workflow экспортирован</h2>'+hint('JSON содержит схему и параметры. Локальные файлы и история не включены.')+'<ul>'+exported.warnings.map(v=>'<li>'+h(v)+'</li>').join('')+'</ul>');
   else toast('Workflow экспортирован в JSON');break;
  }
  case 'importWorkflow':if(workflowRunning())throw Error('Дождитесь текущего запроса');$('#workflowImportFile').value='';$('#workflowImportFile').click();break;
  case 'confirmWorkflowImport':{
   if(!pendingImport)throw Error('Сначала выберите JSON');if(workflowRunning())throw Error('Дождитесь текущего запроса');
   const imported=await api('workflow/import',{text:pendingImport.text});pendingImport=null;close();
   flow=workflowToEditor(imported.workflow);inlineRun=null;lastStepRun=null;workflowOutputCache={nodes:{}};editIndex=-1;
   await refresh();saveDraft();showWorkflow();toast('Импортирована отдельная копия workflow');break;
  }
  case 'loadone':flow=workflowToEditor(state.flows.find(f=>f.id===id));close();showWorkflow();break;
  case 'estimate':commit();{const estimate=normalizeRequest(selected,params);toApi('POST /v1/pricing/estimate',{...estimate,endpoint:op(selected).path})}break;
  case 'single':{const s=step();await prepare(op(selected).method==='WS'?{ws:true,params:s.params}:{name:selected,steps:[s]});break}
  case 'runflow':{
   if(flow.groups){await prepareGraph();break}
   const plan=compileWorkflow(flow.steps);
   const outputs=flow.steps.filter(s=>[videoOp,portraitOp].includes(s.op));
   const label=outputs.map(displaySize).join(', ');
   await prepare({name:flow.name+(label?' · '+label:''),steps:plan,workflow:copy(flow),titles:flow.steps.map(s=>stageName(s)+(outputs.includes(s)?' · '+displaySize(s):''))});break;
  }
  case 'confirm':{
   target.disabled=true;const result=await api(pending.runId?'run/'+pending.runId+'/resume':'run',{ticket});close();
   if(pending.stepId)for(const n of flow.steps.filter(n=>flow.groups.find(g=>g.id===pending.stepId)?.nodeIds.includes(n.id)))n.reuse={mode:'latest'};
   if(pending.ws){socketId=result.id;dialog('<h2>Realtime</h2><p id="socketState"></p><pre id="events"></pre><textarea id="wsEvent" placeholder="JSON события"></textarea><div class="toolbar">'+action('wssend','Отправить событие','primary')+action('wsclose','Закрыть соединение')+'</div>');await socketView()}
   else if(pending.workflow?.version===2){flow.activeRunId=result.id;await refresh();show('workflow');await pollWorkflow(result.id,true)}
   else{await refresh();show('runs');await detail(result.id)}break;
  }
  case 'wssend':await api('socket',{id:socketId,event:$('#wsEvent').value});break;
  case 'wsclose':await api('socket',{id:socketId,close:true});await socketView();break;
  case 'restoreRun':{
   const r=await api('run/'+runId);
   if(!r.config)throw Error('У этого запуска нет сохранённой конфигурации');
   flow=workflowToEditor(r.config.workflow||{name:r.name,steps:r.config.steps});
   if(r.config.workflow?.version===2)for(const n of flow.steps)n.reuse={mode:'pinned',runId:r.id,workflowId:r.config.workflow.id};
   delete flow.id;flow.name+=' · копия';ensureStepIds(flow.steps);
   editIndex=-1;runId='';showWorkflow();toast('Открыт новый черновик. Запросы не отправлены.');break;
  }
  case 'openrun':show('runs');await detail(id);break;
  case 'allruns':runId='';await refresh();show('runs');break;
  case 'resultjson':{
   const r=await api('run/'+runId),blob=new Blob([fmt(r.steps[i].result)],{type:'application/json'}),url=URL.createObjectURL(blob);
   const el=document.createElement('a');el.href=url;el.download='step-'+(i+1)+'.json';el.click();setTimeout(()=>URL.revokeObjectURL(url),2000);break;
  }
  case 'keys':{
   const input={};for(const k of ['api','management'])if($('#key_'+k).value.trim())input[k]=$('#key_'+k).value.trim();
   if(!Object.keys(input).length)throw Error('Введите ключ');
   state=await api('keys',input);header();render();toast('Ключ сохранён в памяти процесса');break;
  }
  case 'forget':state=await api('keys',{api:'',management:''});header();render();break;
  case 'webhook-save':{
   const input={enabled:true,url:$('#webhook_url').value.trim()},secret=$('#webhook_secret').value.trim();if(secret)input.secret=secret;
   state=await api('webhook',input);render();toast('Webhook подключён; polling остаётся включён');break;
  }
  case 'webhook-disable':state=await api('webhook',{enabled:false,secret:''});render();toast('Webhook отключён; polling продолжает работать');break;
  case 'balance':state=await api('account',{});header();render();break;
  case 'syncmodels':state=await api('sync-models',{});models=await liveModels();render();toast('Каталог обновлён');break;
  case 'prev':case 'next':modelPage+=a==='next'?1:-1;$('#modelList').innerHTML=listModels();break;
  case 'model':{
   const m=models.find(x=>x.id===id);dialog('<h2 class="break">'+h(m.id)+'</h2><div class="chips compact">'+chips([m.category,...m.cap.split(' ').filter(Boolean)])+'</div>'+
   (m.hosts?hint('Провайдеры · '+h(m.hosts)):'')+(m.pricing?'<pre>'+h(fmt(m.pricing))+'</pre>':hint('Тариф и поддерживаемые параметры зависят от модели и провайдера.'))+
   (m.url&&/^\/[\w./-]+$/.test(m.url)?'<a target="_blank" rel="noreferrer" href="https://videorouter.sh'+h(m.url)+'">Карточка модели ↗</a>':'')+'<div class="toolbar">'+action('usemodel','Открыть запрос','primary','data-id="'+h(id)+'"')+'</div>');break;
  }
  case 'usemodel':{const m=models.find(x=>x.id===id);close();let model=id;
   if(!state.modelCache){
    if(['speech','music','realtime','transcription'].includes(m.category))model=id.split('/').pop();
    if(id==='lightricks/ltx2')model='reactor/ltx2';
   }
   toApi(modelOp(m),{model});break}
 }
}
document.addEventListener('click',async e=>{
 const t=e.target.closest('[data-a]');if(!t)return;
 try{await act(t.dataset.a,t)}catch(err){toast(err.message);if($('#dialog').open){let p=$('#dialogError');if(!p){p=document.createElement('p');p.id='dialogError';p.className='bad compact';$('#dialogBody').append(p)}p.textContent=err.message}}finally{saveDraft()}
});
document.addEventListener('keydown',e=>{
 const picker=e.target.closest('.videopicker');
 if(!picker?.open)return;
 if(e.key==='Escape'){picker.open=false;picker.querySelector('summary').focus();e.preventDefault();return}
 const buttons=[...picker.querySelectorAll('.modelchoices button')],pos=buttons.indexOf(e.target);
 if((e.key==='ArrowDown'||e.key==='ArrowUp')&&buttons.length){
  buttons[Math.max(0,Math.min(buttons.length-1,pos+(e.key==='ArrowDown'?1:-1)))].focus();e.preventDefault();
 }else if(e.key==='Enter'&&e.target.type==='search'&&buttons.length===1){
  buttons[0].click();e.preventDefault();
 }
});
document.addEventListener('input',e=>{
 const t=e.target;
 if(t.closest('#budgetForm')){budgetVariants=[];$('#budgetResults').textContent=''}
 if(t.id==='quote-audio'||t.id==='quote-video')$('#quoteResult').textContent='';
 if(t.hasAttribute('data-video-query')){
  const i=Number(t.dataset.videoQuery);
  t.closest('details').querySelector('.modelchoices').innerHTML=videoModelResults(t.value,i,flow.steps[i].params.model);
 }
 if(t.hasAttribute('data-character-field')){characterDraft[t.dataset.characterField]=t.value;return}
 if(t.hasAttribute('data-character-asset')){characterDraft.assets.find(a=>a.id===t.dataset.characterAsset)[t.dataset.assetField]=t.value;return}
 if(t.id==='flowname')flow.name=t.value;
 if(t.hasAttribute('data-wf-field')){
  const fields=flow.steps[Number(t.dataset.i)].params,key=t.dataset.wfField;
  if(!t.value)delete fields[key];else if(t.hasAttribute('data-json-field')){try{fields[key]=JSON.parse(t.value)}catch{fields[key]=t.value}}else fields[key]=t.hasAttribute('data-boolean-field')?t.value==='true':t.type==='number'?Number(t.value):t.value;
  if(key==='n'){const outputs=$('[data-image-outputs="'+t.dataset.i+'"]');if(outputs)outputs.innerHTML=imageOutputButtons(flow.steps[Number(t.dataset.i)],Number(t.dataset.i))}
 }
 if(t.hasAttribute('data-src-value')){
  const s=flow.steps[Number(t.dataset.i)],k=t.dataset.key;
  const source=sourceOf(s,k);
  if(t.dataset.srcValue==='ref'){
   delete source.stepId;delete source.port;delete source.index;delete source.ref;
   if(t.value.startsWith('media:')){const [,stepId,port,index]=t.value.split(':');Object.assign(source,{stepId,port,index:Number(index)})}
   else if(t.value.startsWith('image:')){const [,stepId,index]=t.value.split(':');Object.assign(source,{stepId,port:'images',index:Number(index)})}
   else source.ref=t.value;
  }else source[t.dataset.srcValue]=t.value;
  setMediaSource(s,k,source);
 }
 for(const el of document.querySelectorAll('[data-quote-status]')){const s=flow.steps[Number(el.dataset.quoteStatus)];if(s?.quote&&s.quote.key!==quoteKey(s))el.textContent='Оценка устарела — параметры изменились'}
 if(t.id==='routeQ'){filter=t.value;$('#routeList').innerHTML=routeList()}
 if(t.id==='modelsQ'){modelFilter=t.value;modelPage=0;$('#modelList').innerHTML=listModels()}
 if(t.id==='docsQ'){docFilter=t.value;$('#guides').innerHTML=guideRows()}
 saveDraft();
});
async function saveLocalFile(file){
 const response=await fetch('/local/file?name='+encodeURIComponent(file.name),{method:'POST',headers:{'X-Studio':'1','Content-Type':file.type||'application/octet-stream'},body:file});
 const result=await response.json();if(!response.ok)throw Error(result.error);return result;
}
document.addEventListener('change',async e=>{
 const t=e.target;
 if(t.hasAttribute('data-character-upload')||t.hasAttribute('data-character-replace')){await uploadCharacterFiles(t);return}
 if(t.hasAttribute('data-character-source')){
  if(workflowRunning())return;
  if(page==='api'&&editIndex>=0)commit();
  const [dataCardId,assetId]=t.value.split(':');setMediaSource(flow.steps[+t.dataset.i],t.dataset.key,{mode:'character',dataCardId,assetId});render();saveDraft();return;
 }
 if(t.id==='workflowImportFile'){
  const file=t.files?.[0];if(!file)return;
  try{if(file.size>workflowJSONLimit)throw Error('JSON workflow должен быть не больше 3 MiB');if(workflowRunning())throw Error('Дождитесь текущего запроса');previewWorkflowImport(await file.text())}catch(error){toast(error.message)}
  return;
 }
 if(t.hasAttribute('data-continue')||t.hasAttribute('data-enabled')){
  const stepId=t.dataset.continue||t.dataset.enabled,key=t.hasAttribute('data-enabled')?'enabled':'continueOnSuccess';
  try{if(workflowRunning())await controlWorkflow({stepId,[key]:t.checked});else{flow.groups.find(g=>g.id===stepId)[key]=t.checked;render();saveDraft()}}catch(err){toast(err.message)}return;
 }
 if(t.hasAttribute('data-output-choice')){
  const s=flow.steps.find(n=>n.id===t.dataset.outputChoice),source=nodeCandidates(s).find(r=>r.runId===t.value);
  s.reuse=t.value==='latest'?{mode:'latest'}:{mode:'pinned',runId:t.value,...(source?.workflowId&&source.workflowId!==flow.id?{workflowId:source.workflowId}:{})};render();saveDraft();return;
 }
 if(t.hasAttribute('data-node-mode')){
  const s=flow.steps[+t.dataset.i],old=operationIdFor(s);s.modeDrafts||={};s.modeDrafts[old]={params:copy(s.params),media:copy(s.media||{})};
  let next=s.modeDrafts[t.value];if(!next){next=graphNewCard(t.value);const d=operations[t.value];for(const key of d.fields)if(key!=='model'&&s.params[key]!=null)next.params[key]=copy(s.params[key]);for(const key of Object.keys(d.inputs))if(s.media?.[key])next.media[key]=copy(s.media[key]);if(modelChoices(t.value,[videoModel(s.params.model)].filter(Boolean)).length)next.params.model=s.params.model}
  s.action=t.value;s.op=operations[t.value].op;s.params=copy(next.params);s.media=copy(next.media||{});delete s.quote;render();saveDraft();return;
 }
 if(t.hasAttribute('data-node-group')){
  const s=flow.steps[+t.dataset.i],previous=copy(flow.groups);
  for(const g of flow.groups)g.nodeIds=g.nodeIds.filter(id=>id!==s.id);flow.groups.find(g=>g.id===t.value).nodeIds.push(s.id);
  try{const w=editorToWorkflow(flow);compileGraph({...w,steps:w.steps.filter(g=>g.nodes.length)})}catch(err){flow.groups=previous;toast(err.message)}render();saveDraft();return;
 }
 if(t.dataset.wfField && ['aspect_ratio','resolution','size','quality','model'].includes(t.dataset.wfField)){
  const step=flow.steps[Number(t.dataset.i)];
  if([videoOp,imageOp].includes(step.op)&&['aspect_ratio','resolution'].includes(t.dataset.wfField)){
   delete step.params.width;delete step.params.height;delete step.params.size;
  }
  if(step.op===imageOp&&t.dataset.wfField==='size'){delete step.params.aspect_ratio;delete step.params.resolution}
  if([videoOp,portraitOp,imageOp].includes(step.op))render();
 }
 if(t.id==='routeGroup'){group=t.value;$('#routeList').innerHTML=routeList()}
 if(t.id==='priceSort'||t.id==='priceUnit'){
  if(t.id==='priceSort')priceSort=t.value;else priceUnit=t.value;
  modelPage=0;$('#modelList').innerHTML=listModels();
 }
 if(t.id==='modelGroup'){modelGroup=t.value;modelPage=0;$('#modelList').innerHTML=listModels()}
 if(t.id==='waitJob'){waitJob=t.checked;if(editIndex>=0)flow.steps[editIndex].wait=t.checked}
 if(t.hasAttribute('data-wf-file')&&t.files[0]){
  const s=flow.steps[Number(t.dataset.i)],key=t.dataset.key,file=t.files[0];
  const source={mode:'file',name:file.name};setMediaSource(s,key,source);
  waitingFiles.add(source);
  try{
   const result=await saveLocalFile(file);source.file=result.file;
   if(file.type.startsWith('image/') && typeof createImageBitmap==='function'){
    const bitmap=await createImageBitmap(file).catch(()=>null);
    if(bitmap){source.width=bitmap.width;source.height=bitmap.height;bitmap.close()}
   }
  }catch(err){source.name='';toast(err.message)}
  finally{waitingFiles.delete(source);if(page==='workflow')render();saveDraft()}
  return;
 }
 if(t.type==='file'&&t.files[0]){
  const file=t.files[0],dest=t.parentElement.querySelector('input[type=text]');
  try{const data=await saveLocalFile(file);dest.value=data.file;toast('Файл добавлен локально: '+file.name);
  }catch(err){toast(err.message)}
 }
 saveDraft();
});
window.addEventListener('pagehide',saveDraft);
window.addEventListener('resize',refreshGlobalFlowLayout);
$('#connection').onclick=()=>{try{if(page==='api'&&editIndex>=0){commit();saveDraft()}editIndex=-1;show('settings')}catch(e){toast(e.message)}};
$('#dialog').addEventListener('close',()=>{if(socketId){void api('socket',{id:socketId,close:true}).catch(()=>{});socketId=''}});
try {
 [cat,state]=await Promise.all([fetch('/catalog.json').then(r=>r.json()),api('state')]);
 models=await liveModels();const restored=restoreDraft();
 if(restored){if(!restoreEditor())showWorkflow()}
 else if(location.hash==='#ltx')template();
 else if(location.hash==='#portrait480'){
  const step=makeStep(portraitOp);Object.assign(step.params,{model:'atlascloud/infinitetalk',resolution:'480p'});
  flow={name:'Проба портрета · 480p',steps:[step]};showWorkflow();
 }else show('dashboard');
 draftReady=true;
 if(draftMessage)toast(draftMessage);
}catch(e){$('#view').textContent='Не удалось открыть студию: '+e.message}

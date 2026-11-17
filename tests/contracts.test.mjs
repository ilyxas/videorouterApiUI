import test from 'node:test';
import assert from 'node:assert/strict';
import {contractError,assertQuoteMatches,actionMatrix,configureModelCatalog,modelsForAction,modelSupportsAction} from '../public/contracts.mjs';
const video=params=>({op:'POST /v1/videos',params:{model:'lightricks/ltx-2.5-fast',prompt:'Scene',...params}});
test('supported contracts reject unknown capability, routing, voice and media types',()=>{
 assert.equal(contractError(video({resolution:'2160p',aspect_ratio:'9:16'})),'');
 assert.match(contractError(video({model:'unknown'})),/не подтверждён/);
 assert.match(contractError(video({model:'lightricks/ltx-2.5-pro',resolution:'2160p'})),/не подтверждено/);
 assert.match(contractError(video({provider:{only:['unverified']}})),/провайдер/);
 assert.match(contractError(video({provider:[]})),/объектом/);
 assert.match(contractError(video({input_audio_url:'https://fixture.invalid/a.wav',provider:{only:['fal']}})),/аудиовход/);
 assert.match(contractError(video({start_image_url:123})),/тип или адрес/);
 assert.match(contractError(video({width:123})),/width/);
 assert.match(contractError({...video({}),action:'video-edit'}),/не подключены/);
 assert.match(contractError({op:'POST /v1/audio/speech',params:{model:'tts-1',voice:'unknown'}}),/голос/);
 assert.match(contractError({op:'POST /v1/lipsync',params:{model:'vidu/s1-avatar-offline',video_url:'https://fixture.invalid/a.mp4'}}),/video_url/);
 const lip={op:'POST /v1/lipsync',params:{model:'fal/omnihuman-v2',image_url:'https://fixture.invalid/a.png',audio_url:'https://fixture.invalid/a.wav'}};
 assert.match(contractError(lip,lip.params,{complete:true}),/длительность/);
 assert.match(contractError(lip,lip.params,{complete:true,facts:{audio:301}}),/ограничений/);
 assert.equal(contractError(lip,lip.params,{complete:true,facts:{audio:8}}),'');
 for(const action of Object.values(actionMatrix))assert.ok(action.source||action.unavailable);
});
test('image action contracts require exactly one reference and preserve promptless upscale',()=>{
 const step={op:'POST /v1/images',action:'image-upscale',params:{model:'fal/recraft-crisp-upscale',n:1,input_references:[{type:'image_url',image_url:{url:'https://fixture.invalid/a.png'}}]}};
 assert.equal(contractError(step,step.params,{complete:true}),'');
 assert.match(contractError(step,{...step.params,n:2}),/количество/);
 assert.match(contractError(step,{...step.params,input_references:[]}),/ровно одно/);
 assert.match(contractError(step,{...step.params,scale_factor:4}),/scale_factor/);
 const edit={...step,action:'image-edit',params:{...step.params,model:'gemini-2.5-flash-image'}};
 assert.match(contractError(edit,edit.params,{complete:true}),/prompt/);
});
test('pricing assumptions cannot silently change requested duration or resolution',()=>{
 assert.doesNotThrow(()=>assertQuoteMatches({duration_secs:5},{assumptions:{duration_secs:5}}));
 assert.throws(()=>assertQuoteMatches({duration_secs:5},{assumptions:{duration_secs:8}}),/5 → 8/);
 assert.throws(()=>assertQuoteMatches({resolution:'1080p'},{assumptions:{resolution:'720p'}}),/1080p → 720p/);
});


test('live endpoint models extend registry and explicit negative capabilities win',()=>{
 configureModelCatalog([
  {id:'another-image',type:'image',endpoint:'/v1/images'},
  {id:'another-video',type:'video',endpoint:'/v1/videos',capabilities:{start_image_url:true,end_image_url:false}},
  {id:'text-only',type:'video',endpoint:'/v1/videos',cap:'image-to-video',capabilities:{start_image_url:false}}
 ]);
 assert.ok(modelsForAction('text-to-image').some(m=>m.id==='another-image'));
 assert.ok(modelsForAction('image-to-video').some(m=>m.id==='another-video'));
 assert.equal(modelSupportsAction('text-only','image-to-video'),false);
 assert.equal(modelSupportsAction('another-video','audio-to-video'),false);
 assert.equal(contractError({op:'POST /v1/images',params:{model:'another-image',prompt:'Frame',n:1}}),'');
 assert.equal(contractError({op:'POST /v1/videos',params:{model:'another-video',prompt:'Scene',start_image_url:'https://fixture.invalid/a.png',duration_secs:5}}),'');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {imageArtifacts,resolveArtifacts} from '../artifacts.mjs';
import {checkSteps} from '../engine.mjs';
import {estimateRequest} from '../public/workflow-core.mjs';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=';
const marker=index=>({$artifact:{stepId:'image',port:'images',type:'image',index}});
test('URL and base64 artifacts retain explicit output indexes without external uploads',()=>{
 let stored;const response={data:[{url:'https://fixture.invalid/one.png'},{b64_json:png,media_type:'image/png'}]};
 const artifacts=imageArtifacts(response,'run','image',(bytes,name,type)=>{stored={bytes,name,type};return {file:'local-id',local_url:'/asset/local-id'}});
 const map=new Map([['image',artifacts]]);
 assert.equal(resolveArtifacts(marker(0),map,()=>stored),'https://fixture.invalid/one.png');
 const value=resolveArtifacts(marker(1),map,()=>stored);assert.equal(value,'data:image/png;base64,'+png);
 assert.equal(response.data[1].b64_json,undefined);assert.equal(response.data[1].file,'local-id');
 assert.deepEqual(estimateRequest('POST /v1/videos',{start_image_url:value,duration_secs:5}),{start_image_url:value,duration_secs:5,endpoint:'/v1/videos'});
 assert.throws(()=>resolveArtifacts(marker(2),map,()=>stored),/не получено/);
 assert.throws(()=>resolveArtifacts(marker(1),map,()=>{throw Error('Локальный файл не найден')}),/не найден/);
 artifacts[0].expiresAt=Date.now()-1000;assert.throws(()=>resolveArtifacts(marker(0),map,()=>stored),/истёк/);
});
test('invalid output and invalid typed ports fail closed',()=>{
 for(const data of [[],[{url:'http://localhost/frame.png'}],[{b64_json:'broken'}]])assert.throws(()=>imageArtifacts({data},'run','image',()=>{}));
 const routes=new Map(['POST /v1/images','POST /v1/videos'].map(op=>[op,{method:'POST'}]));
 const image={id:'image',op:'POST /v1/images',params:{n:2}};
 const video={op:'POST /v1/videos',params:{start_image_url:marker(1)}};
 checkSteps([image,video],routes);
 assert.throws(()=>checkSteps([video,image],routes),/Неверная/);
 assert.throws(()=>checkSteps([image,{...video,params:{input_audio_url:marker(0)}}],routes),/Неверная/);
});

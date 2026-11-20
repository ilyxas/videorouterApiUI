// Studio-owned model IDs dispatch to the locally authenticated Grok agent.
export const grokModels=[
 {id:'grok-cli/image',type:'image',category:'image',endpoint:'/v1/images',owned_by:'Grok CLI',hosts:'Local Grok session',cap:'text-to-image image-edit',executionProvider:'grok-cli'},
 {id:'grok-cli/video',type:'video',category:'video',endpoint:'/v1/videos',owned_by:'Grok CLI',hosts:'Local Grok session',cap:'text-to-video image-to-video reference-to-video',executionProvider:'grok-cli',capabilities:{start_image_url:true,end_image_url:true,input_references:true,input_audio_url:false,input_video_references:false,input_audio_references:false}}
];
export const isGrok=model=>grokModels.some(row=>row.id===model);
export const grokRatios=['1:1','16:9','9:16','3:2','2:3'];
export function grokMode(p){return p.model==='grok-cli/image'?(p.input_references?.length?'image-edit':'text-to-image'):p.input_references?.length?'reference-to-video':p.start_image_url?'image-to-video':'text-to-video'}
export function grokProfile(model,mode){
 const row=grokModels.find(m=>m.id===model);
 if(!row||!row.cap.split(' ').includes(mode))return {unavailable:'This Grok CLI model does not support the selected operation.'};
 const inputs=mode==='image-edit'||mode==='reference-to-video'?['input_references']:mode==='image-to-video'?['start_image_url','end_image_url']:[];
 return {mode,inputs,allowed:['model','prompt','aspect_ratio','n',...(row.type==='video'?['duration_secs','resolution']:[]),...inputs],required:['prompt',...(inputs.length?[inputs[0]]:[])],ratios:grokRatios,resolutions:row.type==='video'?['480p','720p']:[],maxReferences:mode==='reference-to-video'?14:undefined,source:'local-grok-cli',additionalCost:0};
}
export function validateGrok(mode,p,{complete=false,estimate=false}={}){
 const profile=grokProfile(p.model,mode);if(profile.unavailable)throw Error(profile.unavailable);
 for(const key of Object.keys(p))if(!profile.allowed.includes(key)&&!(estimate&&key==='endpoint'))throw Error('Grok CLI does not support parameter: '+key);
 if(complete)for(const key of profile.required)if(p[key]==null||p[key]===''||Array.isArray(p[key])&&!p[key].length)throw Error('Grok CLI requires '+key);
 if(p.prompt!=null&&(typeof p.prompt!=='string'||p.prompt.length>32000||complete&&!p.prompt.trim()))throw Error('Grok CLI requires a prompt of 1–32000 characters.');
 if(p.n!=null&&p.n!==1)throw Error('One Grok card produces one final output; use additional cards for variations.');
 if(p.aspect_ratio!=null&&!grokRatios.includes(p.aspect_ratio))throw Error('Unsupported Grok aspect ratio.');
 if(p.resolution!=null&&!profile.resolutions.includes(p.resolution))throw Error('Grok video supports 480p or 720p.');
 if(p.duration_secs!=null&&(!Number.isInteger(p.duration_secs)||p.duration_secs<1||p.duration_secs>15))throw Error('Grok video duration must be an integer from 1 to 15 seconds.');
 if(p.input_references!=null){
  if(!Array.isArray(p.input_references)||p.input_references.some(ref=>ref?.type!=='image_url'||!ref.image_url?.url))throw Error('Grok references must be ordered images.');
  if(profile.maxReferences&&p.input_references.length>profile.maxReferences)throw Error('Grok video accepts at most 14 reference images.');
 }
 return profile;
}
export function grokQuote(p){
 validateGrok(grokMode(p),p,{estimate:true});
 return {estimated_cost_usd:0,max_cost_usd:0,execution_provider:'grok-cli',billing:'included',assumptions:Object.fromEntries(['model','duration_secs','resolution','aspect_ratio','n'].filter(k=>p[k]!=null).map(k=>[k,p[k]])),notes:['Grok CLI: no additional charge under your existing access. VideoRouter is not billed.']};
}

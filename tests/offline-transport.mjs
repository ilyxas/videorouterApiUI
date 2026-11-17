// Test-only preload. Never imported by the production server.
import {appendFileSync} from 'node:fs';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=';
globalThis.fetch=async(url,init={})=>{
 const u=new URL(url),params=init.body?JSON.parse(init.body):{};
 if(u.hostname!=='videorouter.sh')throw Error('External transport blocked by fixture');
 if(process.env.FIXTURE_CALLS)appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify({path:u.pathname,params})+'\n');
 if(u.pathname.endsWith('/pricing/estimate')){
  if(params.prompt==='quote-fail')return Response.json({error:'fixture quote failure'},{status:400});
  return Response.json({estimated_cost_usd:0.1,max_cost_usd:0.15,notes:['Локальная фикстура — списаний нет'],assumptions:{duration_secs:params.prompt==='quote-adjust'?8:params.duration_secs}});
 }
 if(u.pathname.endsWith('/images')){
  if(params.prompt==='source-fail')return Response.json({error:'fixture source failure'},{status:500});
  const n=params.prompt==='missing-output'?1:params.n||1;
  return Response.json({data:Array.from({length:n},(_,i)=>i%2?{b64_json:png,media_type:'image/png'}:{url:'https://fixture.invalid/frame.png'}),usage:{cost:0.01},...(params.prompt==='expired'?{output_expires_at:1}:{})});
 }
 if(u.pathname.endsWith('/videos'))return Response.json({id:'fixture-video',status:'queued'});
 if(u.pathname.endsWith('/videos/fixture-video'))return Response.json({id:'fixture-video',status:'completed',data:[{url:'https://fixture.invalid/movie.mp4'}],cost_usd:0.1});
 throw Error('Unexpected external request: '+u.pathname);
};

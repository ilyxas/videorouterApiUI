import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {operations} from '../../public/operations.mjs';
import {nodePort} from '../../public/graph.mjs';

export function operationRegistry(){
 return {contractVersion:1,workflowVersion:2,scope:'Studio operation wiring, not provider/model capability guarantees',operations:Object.entries(operations).map(([operationId,d])=>({operationId,...d,outputPort:nodePort(d.kind)}))};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const file=new URL('operations.json',import.meta.url),text=JSON.stringify(operationRegistry(),null,2)+'\n';
 if(process.argv[2]==='--write'){writeFileSync(file,text);console.log('Updated operations.json')}
 else if(process.argv[2]==='--check'){if(readFileSync(file,'utf8')!==text)throw Error('Operation registry changed; regenerate operations.json');console.log('Operation registry matches source')}
 else{console.error('Usage: node contracts/workflow/registry.mjs --write|--check');process.exitCode=1}
}

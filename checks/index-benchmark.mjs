import {Worker} from 'node:worker_threads';
import {cpus,totalmem,platform,release} from 'node:os';
import {writeFile} from 'node:fs/promises';
import {disposable,removeDisposable} from './helpers/fixtures.mjs';
import {loadIndexConfig} from '../index/config.mjs';
const directory=await disposable('phase2-benchmark-'),settings=await loadIndexConfig();
const worker=new Worker(new URL('./helpers/index-benchmark-worker.mjs',import.meta.url),{workerData:{directory,settings,count:100000}});
const delays=[];let prior=performance.now(),timer=setInterval(()=>{const now=performance.now();delays.push(Math.max(0,now-prior-20));prior=now;},20);
try{
 const result=await new Promise((resolve,reject)=>{worker.on('message',message=>{if(message.progress!==undefined&&message.progress%20000===0)console.log('Synthetic metadata inserted: '+message.progress);if(message.result)resolve(message.result);else if(message.error)reject(new Error(message.error.code));});worker.once('error',reject);worker.once('exit',code=>{if(code!==0)reject(new Error('Benchmark worker exited'));});});
 const sorted=delays.sort((a,b)=>a-b),report={date:new Date().toISOString(),hardware:{cpu:cpus()[0].model,logicalProcessors:cpus().length,totalMemoryBytes:totalmem(),platform:platform(),release:release()},runtime:process.version,cache:'warm after one warmup per query; 24 measured samples per class',scope:'Actual SQLite WASM in a worker. Synthetic metadata only, no 100,000 real files. SQLite/mapper/ranking time included; network/UI/path revalidation excluded. Pagination includes bounded snapshot retrieval plus slicing.',...result,mainEventLoop:{samples:delays.length,p95DelayMs:Number(sorted[Math.floor(sorted.length*.95)].toFixed(2)),maxDelayMs:Number(sorted.at(-1).toFixed(2))}};
 await writeFile('data/phase2-benchmark.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{clearInterval(timer);await worker.terminate();await removeDisposable(directory);}

import {mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {disposable,removeDisposable} from './helpers/fixtures.mjs';
import {loadFileConfig} from '../tools/config.mjs';
import {loadSecurityConfig} from '../safety/config.mjs';
import {FileService} from '../tools/service.mjs';
const directory=await disposable('phase2-observation-'),root=path.join(directory,'Documents');await mkdir(root);
const config={...await loadFileConfig(),enabled:true,roots:[{id:'Documents',path:root}],security:await loadSecurityConfig()};config.indexing={...config.indexing,directory:path.join(directory,'index'),startup:false,watch:true};
for(let i=0;i<100;i++)await writeFile(path.join(root,`sample-${i}.txt`),'Generated metadata-only test fixture.');
const service=new FileService(config),percentile=(list,p)=>Number([...list].sort((a,b)=>a-b)[Math.floor(list.length*p)].toFixed(2));
try{
 await service.index.initialize();const started=performance.now();await service.start();const scanMs=performance.now()-started,latencies=[];
 for(let i=0;i<10;i++){const file=path.join(root,`watch-update-${i}.txt`),t=performance.now();await writeFile(file,'Generated watcher fixture.');for(let turn=0;turn<150;turn++){if((await service.index.snapshot()).some(x=>x.name===`watch-update-${i}.txt`)){latencies.push(performance.now()-t);break;}await delay(20);}if(latencies.length!==i+1)throw new Error('Watcher latency observation timed out');}
 const report={realDisposableFiles:100,initialCrawlMs:Number(scanMs.toFixed(2)),initialCrawlFilesPerSecond:Math.round(100*1000/scanMs),watcherDebounceMs:config.indexing.debounceMs,watcherCreateLatency:{samples:latencies.length,p50Ms:percentile(latencies,.5),p95Ms:percentile(latencies,.95)},scope:'100 generated real files only; excludes fixture creation and worker/database initialization. Watcher timing includes fs.writeFile, debounce, SQLite update and polling observation.'};await writeFile('data/phase2-observation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await service.close();await removeDisposable(directory);}

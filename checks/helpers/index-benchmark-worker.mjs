import {parentPort,workerData} from 'node:worker_threads';
import {IndexDatabase} from '../../index/database.mjs';
import {parseSearch} from '../../search/queryParser.mjs';
import {statSync} from 'node:fs';
import path from 'node:path';
const {directory,settings,count}=workerData,filename=path.join(directory,'benchmark.sqlite'),db=new IndexDatabase(filename,settings);
const percentile=(numbers,p)=>{const sorted=[...numbers].sort((a,b)=>a-b);return Number(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))].toFixed(2));};
const topics=['resume','electricity_bill','college_admission','invoice','project_report','screenshot','analysis','meeting','application','presentation','tax_bill','research','budget','letter','holiday','contract'];
const started=performance.now();
try{
 for(let offset=0;offset<count;offset+=500){const items=[];for(let i=offset;i<Math.min(count,offset+500);i++){const extension=['.pdf','.docx','.xlsx','.txt','.png','.mp4','.py','.pptx'][i%8],name=`${topics[i%topics.length]}_${String(i).padStart(6,'0')}${extension}`;items.push({path:`D:\\Benchmark\\folder_${i%100}\\${name}`,name,folder:`D:\\Benchmark\\folder_${i%100}`,rootId:'Benchmark',driveId:'D:',size:1024+(i*137)%1000000000,createdMs:Date.parse('2026-01-01T00:00:00Z')+(i%300)*86400000,mtimeMs:Date.parse('2026-01-01T00:00:00Z')+(i%310)*86400000,ino:i+1,dev:1,isDirectory:false,extension});}db.upsert(items,'benchmark');if(offset%5000===0)parentPort.postMessage({progress:offset});await new Promise(r=>setImmediate(r));}
 const insertionMs=performance.now()-started;
 const workload={exact:{query:'resume 000000'},fuzzy:{query:'resmee'},partial:{query:'electric'},wordOrder:{query:'bill electricity'},metadata:{query:'',extensions:['xlsx'],sortBy:'modifiedDesc'},combined:{query:'',fileType:'pdfs',drive:'D:',minSize:5000000,modifiedAfter:'2026-06-01',sortBy:'sizeDesc'},pagination:{query:'',sortBy:'sizeDesc'}};
 const metrics={};let pageWindow;
 for(const [name,args] of Object.entries(workload)){
   const query={...parseSearch(args,settings),rootIds:['Benchmark']};db.search(query);const latencies=[];let matches;
   for(let i=0;i<24;i++){const start=performance.now();const result=db.search(query);matches=result.matches.length;pageWindow=result.matches;if(name==='pagination')pageWindow.slice((i%20)*20,(i%20+1)*20);latencies.push(performance.now()-start);await new Promise(r=>setImmediate(r));}
   metrics[name]={p50Ms:percentile(latencies,.5),p95Ms:percentile(latencies,.95),matchesInWindow:matches,samples:latencies.length};
 }
 const concurrent=[];for(let i=0;i<20;i++){const sample={path:`D:\\Benchmark\\load-${i}.txt`,name:`load-${i}.txt`,folder:'D:\\Benchmark',rootId:'Benchmark',driveId:'D:',size:1,createdMs:Date.now(),mtimeMs:Date.now(),ino:count+i+1,dev:1,isDirectory:false,extension:'.txt'};db.upsert([sample],'load');const t=performance.now();db.search({...parseSearch({query:'resmee'},settings),rootIds:['Benchmark']});concurrent.push(performance.now()-t);await new Promise(r=>setImmediate(r));}
 const plan=db.db.all('EXPLAIN QUERY PLAN SELECT * FROM files WHERE extension=? AND modified_at>? ORDER BY modified_at DESC,id LIMIT 20',['.pdf',0]);
 const health=db.health();db.close();parentPort.postMessage({result:{datasetCount:count,actualRowsAfterConcurrentWrites:count+20,sqliteVersion:health.version,journalMode:health.journalMode,insertionMs:Math.round(insertionMs),batchedInsertsPerSecond:Math.round(count*1000/insertionMs),batchSize:500,metrics,concurrentWriteFuzzy:{p50Ms:percentile(concurrent,.5),p95Ms:percentile(concurrent,.95),samples:20},databaseBytes:statSync(filename).size,workerHeapBytes:process.memoryUsage().heapUsed,processRssBytes:process.memoryUsage().rss,queryPlan:plan}});
}catch(error){try{db.close();}catch{}parentPort.postMessage({error:{message:'Benchmark failed',code:error.code||error.constructor.name}});}

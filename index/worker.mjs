import {parentPort,workerData} from 'node:worker_threads';
import {open,readFile,unlink,rename,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {IndexDatabase} from './database.mjs';
import {PathGuard} from '../tools/pathGuard.mjs';
import {crawl,metadata} from './crawler.mjs';
import {WatcherService} from './watcher.mjs';
import {ToolError,toolFailure} from '../tools/errors.mjs';
import {assertPathPolicy} from '../safety/pathRules.mjs';
const config=workerData,settings=config.indexing,directory=settings.directory,lockPath=path.join(directory,'owner.lock'),databasePath=path.join(directory,'metadata.sqlite');
let db,lock,control={paused:false,cancelled:false},task,closing=false,incremental=false,queuedRunId=null;
let progress={status:'idle',runId:null,scanned:0,indexed:0,directories:0,skipped:0,errors:0,permissionErrors:0,queueLength:0,count:0,lastSuccessfulScan:null},roots=new Map(),timer;
const emit=(type,data)=>parentPort.postMessage({type,data});
const status=()=>({...progress,elapsedMs:progress.startedAt?Date.now()-progress.startedAt:0,filesPerSecond:progress.startedAt?Math.round(progress.indexed*1000/Math.max(1,Date.now()-progress.startedAt)):0,memoryBytes:process.memoryUsage().rss,folders:config.roots.map(r=>({id:r.id,path:r.path,...roots.get(r.id)}))});
const publish=()=>emit('progress',status());
const guard=new PathGuard(config.roots,config.blockedExtensions,config.security);guard.storageRoots=[directory];
const watcher=new WatcherService(config,{onWarning:code=>{progress.watcherWarning=code;publish();},onFlush:entries=>{
  if(!db||closing)return;
  try{db.transaction(()=>{const overflow=db.db.get('SELECT COUNT(*) n FROM index_queue').n+entries.length>settings.maxQueue;if(overflow)db.db.exec('DELETE FROM index_queue');const work=overflow?config.roots.map(root=>({target:root.path,root})):entries;for(const {target,root} of work.slice(0,settings.maxQueue))db.db.run('INSERT INTO index_queue(target_path,root_id,operation_type,created_at) VALUES(?,?,?,?) ON CONFLICT(target_path) DO UPDATE SET created_at=excluded.created_at',[target,root.id,'refresh',Date.now()]);});drain().catch(fail);}catch(e){fail(e);}
}});
function fail(error){progress.status='failed';progress.lastErrorCode=error.code||'WORKER_FAILED';publish();}
async function ownLock(){
  try{lock=await open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid}));}
  catch(e){if(e.code!=='EEXIST')throw e;if((await lstat(lockPath)).isSymbolicLink())throw new ToolError('PATH_DENIED','Index lock links are forbidden.');let pid;try{pid=JSON.parse(await readFile(lockPath,'utf8')).pid;}catch{throw new ToolError('INDEX_LOCKED','An unreadable index owner lock must be reviewed locally.');}if(!Number.isSafeInteger(pid)||pid<=0)throw new ToolError('INDEX_LOCKED','The index owner lock is invalid.');try{process.kill(pid,0);throw new ToolError('INDEX_LOCKED','Another Edith process owns this index.');}catch(err){if(err.code!=='ESRCH')throw err;}await unlink(lockPath);lock=await open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid}));}
}
async function inspectRoots(){for(const root of config.roots){try{const c=await guard.inspect(root.path,{directory:true});root.path=c.path;roots.set(root.id,{available:true});}catch{roots.set(root.id,{available:false,error:{code:'DRIVE_UNAVAILABLE',message:'Configured location is unavailable or blocked.'}});db?.unavailable(root.id);}}}
async function scan(runId=randomUUID()){
  progress={...progress,status:'running',runId,startedAt:Date.now(),scanned:0,indexed:0,directories:0,skipped:0,errors:0,permissionErrors:0,truncated:false,queueLength:0,lastErrorCode:null};
  control={paused:false,cancelled:false};db.db.run('INSERT INTO index_runs(run_id,started_at,status) VALUES(?,?,?)',[progress.runId,Date.now(),'running']);publish();
  try{
    await inspectRoots();
    for(const root of config.roots){
      if(control.cancelled)break;if(!roots.get(root.id)?.available){progress.errors++;continue;}
      progress.currentRoot=root.id;publish();
      const complete=await crawl(root,{guard,settings,control,progress,onDirectory:dir=>watcher.add(dir,root),onBatch:async items=>{db.upsert(items,progress.runId);progress.indexed+=items.length;progress.count=db.count();progress.lastBatchAt=Date.now();publish();}});
      // Only a complete, error-free root traversal can establish that unseen files vanished.
      if(complete)db.reconcile(root.id,progress.runId);
    }
    progress.status=control.cancelled?'cancelled':progress.errors||progress.truncated?'partial':'completed';progress.count=db.count();if(progress.status==='completed')progress.lastSuccessfulScan=Date.now();
    db.db.run('UPDATE index_runs SET status=?,finished_at=?,total_scanned=?,total_indexed=?,total_skipped=?,total_errors=? WHERE run_id=?',[progress.status,Date.now(),progress.scanned,progress.indexed,progress.skipped,progress.errors,progress.runId]);
  }catch(e){fail(e);}finally{progress.currentRoot=null;publish();emit('settled',status());task=null;if(!closing&&!control.cancelled)drain().catch(fail);}
}
async function drain(){
  if(task||incremental||closing||control.paused||control.cancelled)return;incremental=true;
  try{for(let turns=0;turns<4;turns++){
    const entries=db.db.all('SELECT * FROM index_queue ORDER BY created_at LIMIT 32');if(!entries.length)break;
    for(const event of entries){
      if(closing)break;const root=config.roots.find(r=>r.id===event.root_id);if(!root){db.db.run('DELETE FROM index_queue WHERE target_path=?',[event.target_path]);continue;}
      try{
        assertPathPolicy(event.target_path,config.security);
        let checked;try{checked=await guard.inspect(event.target_path);}catch(e){if(e.code==='INVALID_FILE')checked=await guard.inspect(event.target_path,{directory:true});else throw e;}
        if(checked.kind==='directory'){
          if(checked.path!==root.path)db.upsert([metadata(checked)],null);
          const p={scanned:0,indexed:0,directories:0,skipped:0,errors:0,permissionErrors:0};const id=randomUUID();
          const complete=await crawl({...root,path:checked.path},{guard,settings,control,progress:p,onDirectory:dir=>watcher.add(dir,root),onBatch:async items=>{db.upsert(items,id);p.indexed+=items.length;}});
          // Subtree changes are repaired by a bounded periodic full reconciliation as well.
          if(complete){const key=process.platform==='win32'?checked.path.toLowerCase():checked.path;db.db.run('DELETE FROM files WHERE substr(normalized_path,1,?)=? AND run_id<>?',[key.length+1,key+path.sep,id]);}
        }else db.upsert([metadata(checked)],null);
        db.db.run('DELETE FROM index_queue WHERE target_path=?',[event.target_path]);
      }catch(e){
        if(e.code==='ENOENT'){try{await guard.inspect(root.path,{directory:true});db.remove(event.target_path);db.db.run('DELETE FROM index_queue WHERE target_path=?',[event.target_path]);}catch{db.unavailable(root.id);roots.set(root.id,{available:false});}}
        else if(['PROTECTED_PATH','PATH_DENIED','LINK_BLOCKED','OUTSIDE_ALLOWLIST'].includes(e.code)){db.remove(event.target_path);db.db.run('DELETE FROM index_queue WHERE target_path=?',[event.target_path]);}
        else {db.db.run('UPDATE index_queue SET attempt_count=attempt_count+1 WHERE target_path=?',[event.target_path]);db.db.run('DELETE FROM index_queue WHERE attempt_count>=3');progress.watcherWarning='WATCHER_FAILED';}
      }
    }
    progress.count=db.count();publish();await new Promise(r=>setImmediate(r));
  }}finally{incremental=false;if(queuedRunId&&!closing){const runId=queuedRunId;queuedRunId=null;task=scan(runId);}}
}
async function initialize(){for(const filename of [databasePath,databasePath+'-journal']){try{if((await lstat(filename)).isSymbolicLink())throw new ToolError('PATH_DENIED','Index database links are forbidden.');}catch(e){if(e.code!=='ENOENT')throw e;}}await ownLock();try{db=new IndexDatabase(databasePath,settings);progress.count=db.count();progress.lastSuccessfulScan=db.db.get("SELECT MAX(finished_at) at FROM index_runs WHERE status='completed'")?.at||null;progress.status=db.db.get("SELECT COUNT(*) n FROM index_runs WHERE status='interrupted'").n?'interrupted':'idle';}catch(e){progress.status='corrupt';progress.lastErrorCode=e.code||'INDEX_CORRUPT';}await inspectRoots();publish();emit('ready',status());timer=setInterval(()=>{if(db&&!task&&!closing){if(progress.count||settings.startup)task=scan();else drain().catch(fail);}},settings.reconcileSeconds*1000);timer.unref();}
parentPort.on('message',async message=>{
  const {id,command,args={}}=message;
  try{
    let result;
    if(command==='close'){closing=true;control.cancelled=true;control.paused=false;watcher.close();clearInterval(timer);await task;while(incremental)await new Promise(r=>setTimeout(r,10));db?.close();db=null;result={closed:true};}
    else if(command==='status')result={...status(),health:db?.health()||{status:'corrupt'}};
    else if(command==='rebuild'){
      if(task||incremental)throw new ToolError('INDEX_BUSY','Cancel indexing and wait before rebuilding.');
      if(db)db.rebuild();else{const suffix='.corrupt-'+Date.now();await rename(databasePath,databasePath+suffix);db=new IndexDatabase(databasePath,settings);}progress.count=0;progress.status='idle';progress.lastSuccessfulScan=null;progress.lastBatchAt=null;progress.lastErrorCode=null;result=status();publish();
    }else{
      if(!db)throw new ToolError('INDEX_CORRUPT','The index needs an authenticated rebuild. Existing documents are unaffected.');
      if(command==='start'){if(task)result={runId:progress.runId};else if(incremental){queuedRunId??=randomUUID();result={runId:queuedRunId};}else{const runId=randomUUID();task=scan(runId);result={runId};}}
      else if(command==='pause'){control.paused=true;progress.status='paused';publish();result=status();}
      else if(command==='resume'){control.paused=false;control.cancelled=false;progress.status=task?'running':'idle';publish();drain().catch(fail);result=status();}
      else if(command==='cancel'){control.cancelled=true;control.paused=false;if(queuedRunId){emit('settled',{...status(),runId:queuedRunId,status:'cancelled'});queuedRunId=null;}result=status();}
      else if(command==='search')result=db.search(args);
      else if(command==='upsert'){const checked=await guard.inspect(args.path);db.upsert([metadata(checked)],null);progress.count=db.count();result={updated:true};}
      else if(command==='entries')result=db.db.all('SELECT * FROM files LIMIT 1000');
      else throw new ToolError('INVALID_ARGUMENTS','Unknown index worker command.');
    }
    if(command==='close'){if(lock){await lock.close();await unlink(lockPath);lock=null;}parentPort.postMessage({id,result});parentPort.close();}else parentPort.postMessage({id,result});
  }catch(error){parentPort.postMessage({id,...toolFailure(error)});}
});
initialize().catch(async error=>{emit('fatal',toolFailure(error));if(lock){await lock.close().catch(()=>{});await unlink(lockPath).catch(()=>{});}parentPort.close();});

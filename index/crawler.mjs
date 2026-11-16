import {opendir} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {classify} from '../search/ranking.mjs';
export function metadata(checked){const {stat}=checked,name=path.basename(checked.path),extension=path.extname(name).toLowerCase();return {path:checked.path,name,folder:path.dirname(checked.path),rootId:checked.root.id,driveId:path.parse(checked.path).root.replace(/[\\/]$/,''),extension,fileType:classify(extension),size:stat.isDirectory()?0:stat.size,createdMs:stat.birthtimeMs>0?stat.birthtimeMs:null,mtimeMs:stat.mtimeMs,ino:stat.ino,dev:stat.dev,isDirectory:stat.isDirectory()};}
export async function crawl(root,{guard,settings,control,onBatch,onDirectory=()=>{},progress}){
  const stack=[],seen=new Set();let batch=[],complete=true;
  const checkpoint=async()=>{while(control.paused&&!control.cancelled)await delay(25);if(control.cancelled){complete=false;return false;}return true;};
  const flush=async()=>{if(batch.length){await onBatch(batch);batch=[];await delay(0);}};
  const enter=async(target,depth)=>{
    if(depth>settings.maxDepth){progress.skipped++;progress.truncated=true;complete=false;return;}
    try{
      const checked=await guard.inspect(target,{directory:true}),identity=`${checked.stat.dev}:${checked.stat.ino}`;
      if(seen.has(identity)){progress.skipped++;return;}seen.add(identity);
      let handle;for(let attempt=0;;attempt++){try{handle=await opendir(checked.path,{bufferSize:32});break;}catch(e){if(attempt===1||!['EBUSY','EAGAIN','EMFILE'].includes(e.code))throw e;await delay(50);}}
      stack.push({handle,depth});progress.directories++;onDirectory(checked.path);
      // Root directories themselves are not search results; child folders are.
      if(depth)batch.push(metadata(checked));
    }catch(e){if(['PROTECTED_PATH','PATH_DENIED','LINK_BLOCKED','OUTSIDE_ALLOWLIST'].includes(e.code)){progress.skipped++;return;}progress.errors++;if(['EACCES','EPERM'].includes(e.code))progress.permissionErrors++;progress.lastErrorCode=['EACCES','EPERM'].includes(e.code)?'ACCESS_DENIED':'PATH_DENIED';complete=false;}
  };
  try{
    await enter(root.path,0);
    while(stack.length&&await checkpoint()){
      if(progress.indexed>=settings.maxFiles){progress.truncated=true;complete=false;break;}
      const current=stack[stack.length-1];let entry;
      try{entry=await current.handle.read();}catch{progress.errors++;complete=false;await current.handle.close().catch(()=>{});stack.pop();continue;}
      if(!entry){await current.handle.close();stack.pop();continue;}
      progress.scanned++;progress.queueLength=stack.length;
      if(entry.isSymbolicLink()){progress.skipped++;continue;}
      const file=path.join(current.handle.path,entry.name);
      try{
        if(entry.isDirectory()){await enter(file,current.depth+1);}
        else if(entry.isFile()){const checked=await guard.inspect(file);batch.push(metadata(checked));}
        else progress.skipped++;
      }catch(e){progress.skipped++;if(['EACCES','EPERM'].includes(e.code)){progress.errors++;progress.permissionErrors++;complete=false;}else if(!['PROTECTED_PATH','PATH_DENIED','LINK_BLOCKED','OUTSIDE_ALLOWLIST'].includes(e.code)){progress.errors++;complete=false;}}
      if(batch.length>=settings.batchSize)await flush();
    }
    if(!control.cancelled)await flush();else complete=false;
  }finally{for(const {handle} of stack)await handle.close().catch(()=>{});progress.queueLength=0;}
  return complete&&!progress.truncated;
}

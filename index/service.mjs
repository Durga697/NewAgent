import {Worker} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
import {ToolError} from '../tools/errors.mjs';
import {parseSearch} from '../search/queryParser.mjs';
import {restrictAuditDirectory} from '../safety/windowsContracts.mjs';
import {mapRow,pathKey} from './database.mjs';
export class FileIndex {
  constructor(config,guard){this.config=config;this.guard=guard;this.status=new Map();this.loading=false;this.stopped=false;this.progress={status:'idle',count:0};this.pending=new Map();this.sequence=0;this.runWaiters=new Map();this.settledRuns=new Set();}
  key(file){return pathKey(file);}
  async initialize(){
    if(this.initialized)return this.initialized;
    this.initialized=(async()=>{
      await restrictAuditDirectory(this.config.indexing.directory);
      this.worker=new Worker(new URL('./worker.mjs',import.meta.url),{workerData:this.config});
      await new Promise((resolve,reject)=>{
        this.readyResolve=resolve;this.readyReject=reject;
        this.worker.on('message',message=>{
          if(message.type==='progress'||message.type==='ready'||message.type==='settled'){
            this.progress=message.data;this.loading=['running','paused'].includes(message.data.status);
            for(const root of message.data.folders||[])this.status.set(root.id,root);
            this.onProgress?.(this.publicStatus());if(message.type==='ready')resolve();if(message.type==='settled'){this.settledRuns.add(message.data.runId);if(this.settledRuns.size>20)this.settledRuns.delete(this.settledRuns.values().next().value);this.runWaiters.get(message.data.runId)?.();this.runWaiters.delete(message.data.runId);}
          }else if(message.type==='fatal'){const error=new ToolError(message.data.error.code,message.data.error.message);reject(error);this.fail(error);}
          else if(message.id){const entry=this.pending.get(message.id);if(entry){clearTimeout(entry.timer);this.pending.delete(message.id);message.error?entry.reject(new ToolError(message.error.code,message.error.message)):entry.resolve(message.result);}}
        });
        this.worker.on('error',()=>{const e=new ToolError('WORKER_FAILED','The index worker failed. Restart Edith; existing documents were not modified.');reject(e);this.fail(e);});
        this.worker.on('exit',code=>{if(!this.stopped&&code!==0){const e=new ToolError('WORKER_FAILED','The index worker stopped unexpectedly.');reject(e);this.fail(e);}});
      });
    })();return this.initialized;
  }
  fail(error){this.failed=true;this.loading=false;this.progress.status='failed';this.progress.lastErrorCode=error.code;for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}this.pending.clear();for(const resolve of this.runWaiters.values())resolve();this.runWaiters.clear();this.onProgress?.(this.publicStatus());}
  async rpc(command,args={},timeout=this.config.indexing.searchTimeoutMs){
    await this.initialize();if(this.stopped||this.failed)throw new ToolError('WORKER_FAILED','The index is closed.');if(this.pending.size>=64)throw new ToolError('INDEX_BUSY','The index request queue is full. Try again shortly.');
    const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new ToolError(command==='search'?'SEARCH_TIMEOUT':'WORKER_FAILED','The index request timed out. Retry or inspect indexing status.'));},timeout);this.pending.set(id,{resolve,reject,timer});this.worker.postMessage({id,command,args});});
  }
  async start({wait=true}={}){await this.initialize();if(!this.config.enabled)return;this.hasStarted=true;const {runId}=await this.rpc('start');this.finished=this.settledRuns.has(runId)?Promise.resolve():new Promise(resolve=>{const previous=this.runWaiters.get(runId);this.runWaiters.set(runId,()=>{previous?.();resolve();});});if(wait)await this.finished;}
  async ensureStarted(){await this.initialize();if(!this.hasStarted&&!this.progress.count&&!this.progress.lastSuccessfulScan){await this.start({wait:false});await Promise.race([this.finished,delay(150)]);}}
  async control(command){if(!['start','pause','resume','cancel','rebuild'].includes(command))throw new ToolError('INVALID_ARGUMENTS','Unknown indexing control.');if(command==='start'){await this.start({wait:false});return this.publicStatus();}const result=await this.rpc(command);if(command==='rebuild')this.hasStarted=false;return result;}
  folders(){return this.config.roots.map(r=>({id:r.id,path:r.path,...this.status.get(r.id)}));}
  publicStatus(){const p=this.progress;return {...p,folders:undefined,currentDirectory:undefined,indexing:this.loading,incomplete:!['completed'].includes(p.status),watcherWarning:p.watcherWarning||null};}
  async search(args){
    const query=parseSearch(args,{timezone:this.config.indexing.timezone,roots:this.config.roots}),roots=await this.guard.folders(query.folder||query.parentFolder);
    query.rootIds=roots.map(r=>r.id);if(query.folder||query.parentFolder)query.folderPath=roots[0]?.path;
    const found=await this.rpc('search',query);
    const warnings=[];if(this.loading||!this.progress.lastSuccessfulScan||['partial','cancelled','interrupted','failed','corrupt'].includes(this.progress.status))warnings.push('Search results may be incomplete while indexing continues or before a complete scan.');
    if(this.progress.truncated)warnings.push('The configured index depth or entry limit was reached.');
    if(this.progress.watcherWarning)warnings.push('Some file notifications may be missed; periodic reconciliation repairs the index.');
    if(query.folder&&roots.every(r=>this.status.get(r.id)?.available===false))throw new ToolError('FOLDER_UNAVAILABLE','That configured folder is unavailable.');
    return {...found,warnings,filters:{...query,tokens:undefined,rootIds:undefined,folderPath:undefined},queryVersion:this.progress.lastBatchAt||0};
  }
  async upsert(file){return this.rpc('upsert',{path:file});}
  async snapshot(){return (await this.rpc('entries')).map(mapRow);}
  async close(){if(this.stopped)return;if(this.initialized){try{if(!this.failed)await this.rpc('close',{},10000);}finally{this.stopped=true;await this.worker?.terminate();}}else this.stopped=true;}
}

import {watch} from 'node:fs';
import path from 'node:path';
import {assertPathPolicy} from '../safety/pathRules.mjs';
import {containsPath} from '../tools/pathGuard.mjs';
export class WatcherService {
  constructor(config,{onFlush,onWarning}){this.config=config;this.onFlush=onFlush;this.onWarning=onWarning;this.watchers=new Map();this.pending=new Map();this.closed=false;}
  add(directory,root){
    if(!this.config.indexing.watch||this.closed||this.watchers.has(directory))return;
    if(this.watchers.size>=256){this.onWarning('WATCHER_LIMIT');return;}
    try{const watcher=watch(directory,{persistent:false},(_event,filename)=>{
      if(this.closed)return;const target=filename?path.join(directory,String(filename)):directory;
      try{if(!containsPath(root.path,target))return;assertPathPolicy(target,this.config.security);}catch{return;}
      if(this.pending.size>=this.config.indexing.maxQueue){this.pending.clear();this.onWarning('WATCHER_OVERFLOW');this.pending.set(root.path,root);}else this.pending.set(target,root);
      clearTimeout(this.timer);this.timer=setTimeout(()=>this.flush(),this.config.indexing.debounceMs);this.timer.unref();
    });watcher.on('error',()=>{watcher.close();this.watchers.delete(directory);this.onWarning('WATCHER_FAILED');});this.watchers.set(directory,watcher);}catch{this.onWarning('WATCHER_FAILED');}
  }
  flush(){if(this.closed||!this.pending.size)return;const entries=[...this.pending].map(([target,root])=>({target,root}));this.pending.clear();this.onFlush(entries);}
  close(){this.closed=true;clearTimeout(this.timer);for(const w of this.watchers.values())w.close();this.watchers.clear();this.pending.clear();}
}

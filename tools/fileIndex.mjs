import {readdir as readDirectory,watch} from 'node:fs';
import {promisify} from 'node:util';
import path from 'node:path';
import Fuse from 'fuse.js';
import {ToolError,toolFailure} from './errors.mjs';
const readdir=promisify(readDirectory);

export const normalizeName=text=>text.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function parseDate(text,end=false){
  if(text===undefined)return end?Infinity:-Infinity;
  if(typeof text!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(text))throw new ToolError('INVALID_DATE','Use YYYY-MM-DD or an ISO timestamp with a timezone.');
  const value=Date.parse(text);
  if(!Number.isFinite(value)||new Date(Date.parse(text.slice(0,10))).toISOString().slice(0,10)!==text.slice(0,10))throw new ToolError('INVALID_DATE','Choose a valid date.');
  return value+(end&&text.length===10?86400000-1:0);
}
export class FileIndex {
  constructor(config,guard){this.config=config;this.guard=guard;this.entries=new Map();this.status=new Map();this.truncated=false;this.pending=new Set();this.watchers=[];this.loading=false;this.stopped=false;}
  key(file){return process.platform==='win32'?file.toLowerCase():file;}
  async upsert(file){
    try{
      const item=await this.guard.inspect(file);
      if(this.entries.size>=this.config.maxFiles&&!this.entries.has(this.key(item.path))){this.truncated=true;return;}
      const name=path.basename(item.path);
      this.entries.set(this.key(item.path),{name,path:item.path,folder:path.dirname(item.path),rootId:item.root.id,size:item.stat.size,modifiedAt:item.stat.mtime.toISOString(),mtimeMs:item.stat.mtimeMs,ino:item.stat.ino,dev:item.stat.dev,extension:path.extname(name).toLowerCase(),searchName:normalizeName(name)});
    }catch{this.entries.delete(this.key(file));}
  }
  async start(){
    if(!this.config.enabled)return;
    this.loading=true;
    for(const root of this.config.roots){
      if(this.stopped)break;
      try{
        const checked=await this.guard.inspect(root.path,{directory:true});
        if(this.stopped)break;
        // Windows TEMP/home paths can use 8.3 aliases. Index and compare canonical roots.
        root.path=checked.path;
        this.status.set(root.id,{available:true});
        try{
          const watcher=watch(root.path,{recursive:true},(_event,filename)=>{
            if(this.stopped||!filename)return;
            const file=path.join(root.path,String(filename));
            if(path.relative(root.path,file).split(path.sep).length>this.config.maxDepth+1)return;
            const task=this.changed(file,root);this.pending.add(task);task.then(()=>this.pending.delete(task),()=>this.pending.delete(task));
          });
          watcher.on('error',()=>{this.watchWarning='The file watcher could not monitor every folder; restart Edith to refresh the index.';});this.watchers.push(watcher);
        }catch{this.watchWarning='The file watcher is unavailable; restart Edith to refresh the index.';}
        await this.scan(root.path,0);
      }catch(e){this.status.set(root.id,{available:false,...toolFailure(e)});}
    }
    await Promise.all([...this.pending]);
    this.loading=false;
  }
  async changed(file,root){
    try{
      try{await this.guard.inspect(file);await this.upsert(file);return;}catch{}
      try{await this.guard.inspect(file,{directory:true});await this.scan(file,path.relative(root.path,file).split(path.sep).length);return;}catch{}
      const key=this.key(file);for(const stored of this.entries.keys())if(stored===key||stored.startsWith(key+path.sep))this.entries.delete(stored);
    }catch{this.watchWarning='A file-change notification could not be processed. Repeat your search to revalidate results.';}
  }
  async scan(dir,depth){
    if(depth>this.config.maxDepth||this.stopped)return;
    const entries=await readdir(dir,{withFileTypes:true});
    const files=entries.filter(e=>e.isFile()&&!e.isSymbolicLink());
    for(let i=0;i<files.length;i+=16){
      if(this.stopped)return;
      if(this.entries.size>=this.config.maxFiles){this.truncated=true;return;}
      await Promise.all(files.slice(i,i+16).map(entry=>this.upsert(path.join(dir,entry.name))));
    }
    for(const entry of entries.filter(e=>e.isDirectory()&&!e.isSymbolicLink())){
      if(this.stopped)return;
      if(this.entries.size>=this.config.maxFiles){this.truncated=true;return;}
      const file=path.join(dir,entry.name);
      try{await this.guard.inspect(file,{directory:true});await this.scan(file,depth+1);}catch{}
    }
  }
  folders(){return this.config.roots.map(r=>({id:r.id,path:r.path,...this.status.get(r.id)}));}
  async search(args){
    const roots=await this.guard.folders(args.folder);
    const after=parseDate(args.modifiedAfter),before=parseDate(args.modifiedBefore,true);
    if(after>before)throw new ToolError('INVALID_DATE_RANGE','modifiedAfter must be before modifiedBefore.');
    const extensions=args.extensions?.map(e=>'.'+e.replace(/^\./,'').toLowerCase());
    const candidates=[...this.entries.values()].filter(item=>roots.some(r=>{
      const rel=path.relative(r.path,item.path);return rel&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);
    })&&item.mtimeMs>=after&&item.mtimeMs<=before&&(!extensions?.length||extensions.includes(item.extension)));
    const tokens=normalizeName(args.query).split(' ').filter(t=>t&&!new Set(['my','latest','newest','find','file','files','the','please']).has(t));
    const ranked=tokens.length?new Fuse(candidates,{keys:['searchName'],threshold:.35,ignoreLocation:true,includeScore:true}).search({$and:tokens.map(t=>({searchName:t}))}):candidates.map(item=>({item,score:0}));
    const order=args.sortBy||'modifiedDesc';
    ranked.sort((a,b)=>order==='modifiedDesc'?b.item.mtimeMs-a.item.mtimeMs:order==='modifiedAsc'?a.item.mtimeMs-b.item.mtimeMs:order==='name'?a.item.name.localeCompare(b.item.name):(a.score-b.score||b.item.mtimeMs-a.item.mtimeMs));
    const matches=[];const limit=Math.min(args.limit||20,this.config.maxResults);
    for(const {item} of ranked){
      // Revalidate every returned result instead of trusting an old watcher entry.
      try{const current=await this.guard.inspect(item.path);if(current.stat.mtimeMs!==item.mtimeMs||current.stat.size!==item.size){await this.upsert(item.path);continue;}matches.push(item);}catch{this.entries.delete(this.key(item.path));}
      if(matches.length===limit)break;
    }
    const warnings=this.folders().filter(f=>!f.available).map(f=>`${f.id}: ${f.error?.message||'folder unavailable'}`);
    if(this.loading)warnings.push('The filename index is still building. Results are incomplete; try the search again in a moment.');
    if(args.folder&&roots.every(r=>this.status.get(r.id)?.available===false))throw new ToolError('FOLDER_UNAVAILABLE',warnings.join(' '));
    if(this.truncated)warnings.push(`Index limited to ${this.config.maxFiles} files and depth ${this.config.maxDepth}. Narrow the allowed folders if needed.`);
    if(this.watchWarning)warnings.push(this.watchWarning);
    return {matches,warnings,limited:ranked.length>matches.length||this.truncated};
  }
  async close(){this.stopped=true;for(const watcher of this.watchers)watcher.close();await Promise.all([...this.pending]);}
}

import {randomBytes,createHmac} from 'node:crypto';
import {ToolError} from './errors.mjs';
export class ResultStore {
  constructor(config,now=()=>Date.now()){this.config=config;this.now=now;this.secret=randomBytes(32);this.sessions=new WeakMap();}
  state(session){let state=this.sessions.get(session);if(!state){state={entries:new Map(),latest:[],previousSearch:[],pending:null,selected:null,previousSelected:null,snapshots:new Map(),version:0};this.sessions.set(session,state);}return state;}
  put(session,items){
    const state=this.state(session);state.previousSearch=state.latest;state.latest=[];state.pending=null;state.version++;
    for(const item of items){
      const resultId=createHmac('sha256',this.secret).update(`${session.id}\0${item.path}\0${item.mtimeMs}\0${item.size}\0${item.ino}`).digest('hex');
      state.entries.delete(resultId);state.entries.set(resultId,{...item,resultId,expiresAt:this.now()+this.config.resultTtlSeconds*1000});state.latest.push(resultId);
    }
    while(state.entries.size>this.config.maxStoredResults)state.entries.delete(state.entries.keys().next().value);
    return state.latest.map((id,index)=>this.public(this.get(session,id),index+1));
  }
  public(item,ordinal){return {resultId:item.resultId,fileRef:item.resultId,ordinal,name:item.name,path:item.path,folder:item.folder,rootId:item.rootId,driveId:item.driveId,size:item.size,extension:item.extension,fileType:item.fileType,isDirectory:!!item.isDirectory,createdAt:item.createdAt,modifiedAt:item.modifiedAt,matchReason:item.matchReason,expiresAt:new Date(item.expiresAt).toISOString()};}
  get(session,id){const item=this.state(session).entries.get(id);if(!item)throw new ToolError('UNKNOWN_RESULT','That result is not from this session. Search for the file again.');if(item.expiresAt<=this.now()){this.state(session).entries.delete(id);throw new ToolError('RESULT_EXPIRED','That file result expired. Search again before opening it.');}return item;}
  select(session,id,action){const state=this.state(session);this.get(session,id);if(state.selected!==id){state.previousSelected=state.selected;state.selected=id;}state.lastAction={resultId:id,action,at:this.now()};state.currentFolder=this.get(session,id).folder;}
  resolve(session,selector){
    const s=this.state(session),entries=s.latest.map(id=>this.get(session,id));let item;
    if(selector==='previousSearch'){if(!s.previousSearch.length)throw new ToolError('INVALID_FILE_REFERENCE','There is no previous search in this session.');const previous=s.previousSearch;s.previousSearch=s.latest;s.latest=previous;return s.latest.map((id,i)=>this.public(this.get(session,id),i+1));}
    if(selector==='selected')item=s.selected?this.get(session,s.selected):entries.length===1?entries[0]:null;
    else if(selector==='previous')item=s.previousSelected?this.get(session,s.previousSelected):null;
    else if(selector==='newest'||selector==='oldest')item=[...entries].sort((a,b)=>selector==='newest'?b.mtimeMs-a.mtimeMs:a.mtimeMs-b.mtimeMs)[0];
    else if(selector==='last')item=entries.at(-1);
    else if(Number.isInteger(Number(selector))&&Number(selector)>0)item=entries[Number(selector)-1];
    if(!item)throw new ToolError('INVALID_FILE_REFERENCE','Choose a numbered result; the reference is ambiguous or unavailable.');return item.resultId;
  }
  saveSnapshot(session,found){const s=this.state(session),id=randomBytes(24).toString('hex');s.snapshots.set(id,{...found,expiresAt:this.now()+this.config.resultTtlSeconds*1000});while(s.snapshots.size>3)s.snapshots.delete(s.snapshots.keys().next().value);return id;}
  page(session,cursor,limit){const s=this.state(session),entry=s.snapshots.get(cursor);if(!entry||entry.expiresAt<=this.now()){s.snapshots.delete(cursor);throw new ToolError('STALE_FILE_REFERENCE','That search page expired or belongs to another session. Search again.');}s.snapshots.delete(cursor);const offset=entry.offset||0,matches=entry.matches.slice(offset,offset+limit);let nextCursor=null;if(offset+limit<entry.matches.length){nextCursor=randomBytes(24).toString('hex');s.snapshots.set(nextCursor,{...entry,offset:offset+limit});}return {...entry,matches,nextCursor,totalInWindow:entry.matches.length};}
}

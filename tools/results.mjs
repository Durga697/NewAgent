import {randomBytes,createHmac} from 'node:crypto';
import {ToolError} from './errors.mjs';
export class ResultStore {
  constructor(config,now=()=>Date.now()){this.config=config;this.now=now;this.secret=randomBytes(32);this.sessions=new WeakMap();}
  state(session){let state=this.sessions.get(session);if(!state){state={entries:new Map(),latest:[],pending:null};this.sessions.set(session,state);}return state;}
  put(session,items){
    const state=this.state(session);state.latest=[];state.pending=null;
    for(const item of items){
      const resultId=createHmac('sha256',this.secret).update(`${session.id}\0${item.path}\0${item.mtimeMs}\0${item.size}\0${item.ino}`).digest('hex');
      state.entries.delete(resultId);state.entries.set(resultId,{...item,resultId,expiresAt:this.now()+this.config.resultTtlSeconds*1000});state.latest.push(resultId);
    }
    while(state.entries.size>this.config.maxStoredResults)state.entries.delete(state.entries.keys().next().value);
    return state.latest.map((id,index)=>this.public(this.get(session,id),index+1));
  }
  public(item,ordinal){return {resultId:item.resultId,ordinal,name:item.name,path:item.path,folder:item.folder,rootId:item.rootId,size:item.size,modifiedAt:item.modifiedAt,expiresAt:new Date(item.expiresAt).toISOString()};}
  get(session,id){const item=this.state(session).entries.get(id);if(!item)throw new ToolError('UNKNOWN_RESULT','That result is not from this session. Search for the file again.');if(item.expiresAt<=this.now()){this.state(session).entries.delete(id);throw new ToolError('RESULT_EXPIRED','That file result expired. Search again before opening it.');}return item;}
}

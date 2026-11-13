import {PathGuard} from './pathGuard.mjs';
import {FileIndex} from './fileIndex.mjs';
import {ResultStore} from './results.mjs';
import {ToolError} from './errors.mjs';
import {launchFile} from './windows.mjs';
import {hasActionConsent} from './intent.mjs';
export class FileService {
  constructor(config,{launch=launchFile,now}={}){this.config=config;this.guard=new PathGuard(config.roots,config.blockedExtensions);this.index=new FileIndex(config,this.guard);this.results=new ResultStore(config,now);this.launch=launch;}
  requireEnabled(){if(!this.config.enabled)throw new ToolError('FILES_DISABLED','Local file tools are disabled in this configuration.');}
  async start(){await this.index.start();}
  async act(context,action,resultId){
    this.requireEnabled();
    const item=this.results.get(context.session,resultId);
    const checked=await this.guard.inspect(item.path,{opening:true});
    if(context.isCancelled?.())throw new ToolError('CANCELLED','That file action was cancelled.');
    if(checked.stat.mtimeMs!==item.mtimeMs||checked.stat.size!==item.size||checked.stat.ino!==item.ino||checked.stat.dev!==item.dev)throw new ToolError('FILE_CHANGED','That file changed since the search. Search again before opening it.');
    if(!hasActionConsent(this.results,context.session,item,action,context.source)){
      const request={status:'confirmation_required',action,...this.results.public(item),message:`${action==='open'?'Open':'Show in folder'} ${item.name}? Choose this file by voice or use its button.`};
      this.results.state(context.session).pending=request;context.publish?.('fileAction',request);return request;
    }
    await this.launch(action,checked.path);
    context.session.fileUserSpeech='';context.session.fileSpeechAt=0;
    this.results.state(context.session).pending=null;
    const result={status:'launched',action,name:item.name,resultId,message:action==='open'?'The open request was handed to Windows.':'The show-in-folder request was handed to Windows Explorer.'};
    context.publish?.('fileAction',result);return result;
  }
  close(){return this.index.close();}
}

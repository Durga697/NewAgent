import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {ToolError} from './errors.mjs';
export function launchFile(action,file){
  if(process.platform!=='win32')throw new ToolError('WINDOWS_REQUIRED','Opening files is supported on Windows only.');
  const executable=join(process.env.SystemRoot||'C:\\Windows','explorer.exe');
  // No cmd.exe, shell interpolation, or model-provided commands.
  const args=action==='reveal'?['/select,',file]:[file];
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{shell:false,windowsHide:true,stdio:'ignore',detached:true});
    child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});
  });
}

import {pathToFileURL} from 'node:url';
import {access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {ToolError} from './errors.mjs';
import {isValidatedPath} from './pathGuard.mjs';
import {requirePermit} from '../safety/policy.mjs';
export async function launchFile(action,file,{capability,permit,session,security}={}){
  requirePermit(permit,session,action==='reveal'?'reveal_in_folder':action==='folder'?'open_folder':'open_file');
  if(!isValidatedPath(capability)||capability.path!==file||!['file','directory'].includes(capability.kind))throw new ToolError('PATH_DENIED','A validated internal file capability is required.');
  if(process.platform!=='win32')throw new ToolError('WINDOWS_REQUIRED','Opening files is supported on Windows only.');
  const handler=security?.handlers.find(h=>h.extensions.includes(file.slice(file.lastIndexOf('.')).toLowerCase()));
  const folder=capability.kind==='directory';
  if(action==='folder'&&!folder)throw new ToolError('PATH_DENIED','A validated folder is required.');
  if(action==='open'&&!folder&&!handler)throw new ToolError('UNSUPPORTED_FILE','No approved non-executing handler is configured for that file type. Use Show in folder instead.');
  const executable=action!=='open'||folder?join(process.env.SystemRoot||'C:\\Windows','explorer.exe'):handler.executable;
  // No cmd.exe, shell interpolation, or model-provided commands.
  const args=action==='reveal'?['/select,',file]:folder?[file]:handler.arguments.map(arg=>arg==='{file}'?file:arg.replace('{fileUrl}',pathToFileURL(file).href));
  if(action==='open'&&!folder){try{await access(executable);}catch{throw new ToolError('UNSUPPORTED_FILE_TYPE','The approved document application is not installed at its trusted path. Use Show in folder.');}}
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{shell:false,windowsHide:true,stdio:'ignore',detached:true});
    child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});
  });
}

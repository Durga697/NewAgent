import {promisify} from 'node:util';
// Test-only preload. Production never imports this adapter double.
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {appendFileSync} from 'node:fs';
const original=childProcess.spawn;
childProcess.spawn=function(command,args,options){
  if(/(?:^|[\\/])(?:explorer|notepad|msedge)\.exe$/i.test(command)){
    if(!process.env.EDITH_TEST_LAUNCH_LOG)throw new Error('Test launch log is required.');
    appendFileSync(process.env.EDITH_TEST_LAUNCH_LOG,JSON.stringify({command,args,shell:options.shell})+'\n');
    const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;
  }
  return original(command,args,options);
};
syncBuiltinESMExports();

const originalExec=childProcess.execFile;
childProcess.execFile=function(command,args,options,callback){
  if(process.env.EDITH_TEST_DRIVES&&/powershell\.exe$/i.test(command)&&args.includes('-EncodedCommand')){const done=typeof options==='function'?options:callback;queueMicrotask(()=>done(null,process.env.EDITH_TEST_DRIVES,''));return new EventEmitter();}
  return originalExec(command,args,options,callback);
};
syncBuiltinESMExports();

childProcess.execFile[promisify.custom]=function(command,args,options){return new Promise((resolve,reject)=>childProcess.execFile(command,args,options,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));};
syncBuiltinESMExports();

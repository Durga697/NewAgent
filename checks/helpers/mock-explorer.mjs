// Test-only preload. Production never imports this adapter double.
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {appendFileSync} from 'node:fs';
const original=childProcess.spawn;
childProcess.spawn=function(command,args,options){
  if(/(?:^|[\\/])explorer\.exe$/i.test(command)){
    if(!process.env.EDITH_TEST_LAUNCH_LOG)throw new Error('Test launch log is required.');
    appendFileSync(process.env.EDITH_TEST_LAUNCH_LOG,JSON.stringify({command,args,shell:options.shell})+'\n');
    const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;
  }
  return original(command,args,options);
};
syncBuiltinESMExports();

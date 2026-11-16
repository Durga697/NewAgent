import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const files=[];
async function collect(dir,recursive=true){for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isFile()&&/\.(?:m?js)$/.test(file))files.push(file);else if(recursive&&entry.isDirectory())await collect(file);}}
await collect('.',false);for(const dir of ['public','tools','safety','index','search','test','checks'])await collect(dir);
for(const file of files){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status!==0){console.error(result.stderr);process.exit(1);}}
console.log(`Syntax checked ${files.length} JavaScript modules. No bundler/typecheck/build pipeline is configured.`);

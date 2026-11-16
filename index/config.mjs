import {readFile,realpath,lstat,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'jsonc-parser';
import Ajv from 'ajv';
import {ToolError} from '../tools/errors.mjs';
const integer=(minimum,maximum)=>({type:'integer',minimum,maximum});
const schema={type:'object',additionalProperties:false,required:['version','directory','startup','watch','reconcileSeconds','debounceMs','batchSize','maxQueue','maxDepth','maxFiles','searchTimeoutMs','candidateLimit','snapshotLimit','timezone','ranking'],properties:{version:{const:1},directory:{type:'string',minLength:1},startup:{type:'boolean'},watch:{type:'boolean'},reconcileSeconds:integer(10,86400),debounceMs:integer(50,5000),batchSize:integer(10,1000),maxQueue:integer(16,10000),maxDepth:integer(1,256),maxFiles:integer(100,2000000),searchTimeoutMs:integer(100,30000),candidateLimit:integer(100,5000),snapshotLimit:integer(20,1000),timezone:{type:'string',maxLength:100},ranking:{type:'object',additionalProperties:false,required:['exact','token','prefix','fuzzy'],properties:Object.fromEntries(['exact','token','prefix','fuzzy'].map(k=>[k,integer(1,1000)]))}}};
const validate=new Ajv().compile(schema);
export async function loadIndexConfig(filename=process.env.EDITH_INDEX_CONFIG||new URL('../config/indexing.jsonc',import.meta.url)){
  try{
    const errors=[],config=parse(await readFile(filename,'utf8'),errors,{allowTrailingComma:true});
    if(errors.length||!validate(config))throw new Error();
    new Intl.DateTimeFormat('en',{timeZone:config.timezone}).format();
    config.directory=path.resolve(config.directory);
    if(process.env.NODE_ENV==='test'&&!process.env.EDITH_INDEX_CONFIG)config.directory=path.resolve(`data/test-fixtures/runtime-index-${process.pid}`);
    const data=path.resolve('data'),rel=path.relative(data,config.directory);
    if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw new Error();
    // The index is private app storage; no link may redirect database or lock writes.
    let current=path.parse(config.directory).root;
    for(const part of config.directory.slice(current.length).split(path.sep).filter(Boolean)){
      current=path.join(current,part);try{if((await lstat(current)).isSymbolicLink())throw new Error();}catch(e){if(e.code==='ENOENT')break;throw e;}
    }
    await mkdir(data,{recursive:true});const parent=await realpath(data);if(parent.toLowerCase()!==data.toLowerCase())throw new Error();
    return config;
  }catch{throw new ToolError('CONFIG_INVALID','Invalid indexing configuration or unsafe index storage. Indexing was not enabled.');}
}

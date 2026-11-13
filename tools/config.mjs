import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute,resolve} from 'node:path';
import {parse,printParseErrorCode} from 'jsonc-parser';
export async function loadFileConfig(filename=process.env.FILE_TOOLS_CONFIG||new URL('../config/file-tools.jsonc',import.meta.url)){
  const errors=[];const config=parse(await readFile(filename,'utf8'),errors,{allowTrailingComma:true});
  if(errors.length)throw new Error(`Invalid file-tool configuration: ${printParseErrorCode(errors[0].error)}`);
  if(typeof config?.enabled!=='boolean'||!Array.isArray(config.roots)||!Array.isArray(config.blockedExtensions))throw new Error('File tools need enabled, roots and blockedExtensions settings.');
  for(const [key,max] of Object.entries({maxDepth:32,maxFiles:100000,resultTtlSeconds:86400,maxResults:100,maxStoredResults:1000}))if(!Number.isInteger(config[key])||config[key]<1||config[key]>max)throw new Error(`Invalid file-tool ${key}.`);
  if(config.maxStoredResults<config.maxResults)throw new Error('maxStoredResults must be at least maxResults.');
  if(typeof config.auditFile!=='string'||!config.auditFile.trim())throw new Error('File tools require a local auditFile.');
  if(config.roots.some(r=>typeof r.id!=='string'||!r.id.trim()||typeof r.path!=='string'||!r.path.trim())||new Set(config.roots.map(r=>r.id.toLowerCase())).size!==config.roots.length)throw new Error('Allowed folder IDs must be unique.');
  if(config.blockedExtensions.some(e=>typeof e!=='string'||!/^\.[a-z0-9-]+$/i.test(e)))throw new Error('Blocked extensions must start with a dot.');
  config.roots=config.roots.map(r=>{const path=r.path.replaceAll('${home}',homedir());if(!isAbsolute(path))throw new Error('Allowed folders must use absolute paths or ${home}.');return {...r,path:resolve(path)};});
  config.auditFile=resolve(config.auditFile);
  // Automated checks never scan a real user's folders unless given an explicit test config.
  if(process.env.NODE_ENV==='test'&&!process.env.FILE_TOOLS_CONFIG){config.enabled=false;config.roots=[];}
  return config;
}

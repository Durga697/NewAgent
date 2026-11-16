import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import {parse} from 'jsonc-parser';
import {SecurityError} from './errors.mjs';
import {hardExecutableTypes} from './pathRules.mjs';
import fs from 'node:fs';
import {promisify} from 'node:util';
const realpath=promisify(fs.realpath.native);

const strings={type:'array',maxItems:100,uniqueItems:true,items:{type:'string',minLength:1,maxLength:1000}};
const extensions={type:'array',maxItems:100,uniqueItems:true,items:{type:'string',pattern:'^\\.[a-z0-9-]+$'}};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const number=(min,max)=>({type:'integer',minimum:min,maximum:max});
export const securitySchema=object({
  version:{const:1},filesystem:object({includedRoots:strings,excludedPaths:strings,neverTouchPaths:strings,localOnlyPaths:strings,allowedFileTypes:extensions,blockedExecutableTypes:extensions,autoStartExistingIndex:{type:'boolean'}}),
  policy:object({bulkActionThreshold:number(1,1000),requireConfirmationForOverwrite:{const:true},requireConfirmationForDelete:{const:true},permanentDeleteAllowed:{const:false},allowArbitraryShell:{const:false},allowExecutableFileLaunch:{const:false}}),
  privacy:object({sendFileContentToCloudByDefault:{const:false},requireRelevantUserRequestForCloudFileContent:{const:true},allowedProviders:{type:'array',minItems:1,maxItems:1,items:{const:'gemini'}}}),
  logging:object({directory:{type:'string',minLength:1,maxLength:1000},maxPageSize:number(1,100),maxRecordBytes:number(1024,16384)}),
  confirmation:object({ttlSeconds:number(10,600),maxPendingPerSession:number(1,100)}),
  sessions:object({idleSeconds:number(60,86400),absoluteSeconds:number(300,86400),maxSessions:number(1,1000),maxRequestsPerSession:number(10,1000)}),
  handlers:{type:'array',maxItems:20,items:object({id:{type:'string',pattern:'^[a-z0-9-]+$'},executable:{type:'string',minLength:1,maxLength:1000},extensions,arguments:{type:'array',minItems:1,maxItems:2,items:{type:'string',maxLength:100}}})}
});
const validate=new Ajv({allErrors:true}).compile(securitySchema);
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export function expandTrustedPath(value){
  const systemRoot=process.env.SystemRoot||'C:\\Windows';
  const vars={home:homedir(),systemRoot,programFilesX86:process.env['ProgramFiles(x86)']||path.win32.join(path.win32.parse(systemRoot).root,'Program Files (x86)'),programFiles:process.env.ProgramFiles||path.win32.join(path.win32.parse(systemRoot).root,'Program Files'),programData:process.env.ProgramData||path.win32.join(path.win32.parse(systemRoot).root,'ProgramData')};
  const expanded=value.replace(/\$\{([^}]+)\}/g,(_m,key)=>{if(!vars[key])throw new SecurityError('CONFIG_INVALID','Unsupported security path placeholder.');return vars[key];});
  if(!path.isAbsolute(expanded)||/^[\\/]{2}/.test(expanded)||expanded.split(/[\\/]/).includes('..'))throw new SecurityError('CONFIG_INVALID','Security paths must be absolute local paths without traversal.');
  return path.resolve(expanded);
}
export function validateSecurityConfig(raw){
  if(!validate(raw))throw new SecurityError('CONFIG_INVALID','Invalid or unsafe security configuration. Check the documented schema; unknown settings are refused.');
  const config=structuredClone(raw);
  if(config.filesystem.allowedFileTypes.some(e=>hardExecutableTypes.includes(e)))throw new SecurityError('CONFIG_INVALID','Executable/script types cannot be approved as openable documents.');
  for(const key of ['includedRoots','excludedPaths','neverTouchPaths','localOnlyPaths'])config.filesystem[key]=config.filesystem[key].map(expandTrustedPath);
  if(config.sessions.idleSeconds>config.sessions.absoluteSeconds)throw new SecurityError('CONFIG_INVALID','Session idle lifetime cannot exceed absolute lifetime.');
  if(new Set(config.handlers.map(h=>h.id)).size!==config.handlers.length)throw new SecurityError('CONFIG_INVALID','Handler IDs must be unique.');
  if(process.env.RENDER==='true')config.handlers=[];
  for(const handler of config.handlers){
    const system=expandTrustedPath('${systemRoot}');
  const installed=expandTrustedPath('${programFiles}'),installedX86=expandTrustedPath('${programFilesX86}');
    handler.executable=expandTrustedPath(handler.executable);
    const text=handler.executable.toLowerCase()===path.join(system,'System32','notepad.exe').toLowerCase()&&handler.extensions.every(e=>['.txt','.md','.log','.csv','.json'].includes(e))&&JSON.stringify(handler.arguments)==='["{file}"]';
    const pdf=[installed,installedX86].some(root=>handler.executable.toLowerCase()===path.join(root,'Microsoft','Edge','Application','msedge.exe').toLowerCase())&&handler.extensions.length===1&&handler.extensions[0]==='.pdf'&&JSON.stringify(handler.arguments)==='["--new-window","--app={fileUrl}"]';
    if(!text&&!pdf)throw new SecurityError('CONFIG_INVALID','Only reviewed Notepad text and Microsoft Edge PDF handlers with fixed arguments are permitted.');
    const roots=[system,installed,installedX86];
    if(!roots.some(root=>within(root,handler.executable))||!handler.executable.toLowerCase().endsWith('.exe')||/^(?:cmd|powershell|pwsh|wscript|cscript|rundll32|regsvr32|mshta|python|node)\.exe$/i.test(path.basename(handler.executable)))throw new SecurityError('CONFIG_INVALID','Handlers must be installed, non-interpreting executables in trusted OS/application directories.');
    if(handler.extensions.some(e=>!config.filesystem.allowedFileTypes.includes(e)||config.filesystem.blockedExecutableTypes.includes(e)))throw new SecurityError('CONFIG_INVALID','A handler cannot authorize a blocked or unapproved file type.');
  }
  config.logging.directory=path.resolve(config.logging.directory);
  const dataRoot=path.resolve('data');
  if(config.logging.directory===dataRoot||!within(dataRoot,config.logging.directory))throw new SecurityError('CONFIG_INVALID','Security logs must use a dedicated subdirectory under application data.');
  return freeze(config);
}
function within(root,target){const r=path.relative(root.toLowerCase(),target.toLowerCase());return !r||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));}
export async function loadSecurityConfig(filename=process.env.EDITH_SECURITY_CONFIG||new URL('../config/edith-security.jsonc',import.meta.url)){
  try{const errors=[];const raw=parse(await readFile(filename,'utf8'),errors,{allowTrailingComma:true});if(errors.length)throw new Error();const config=structuredClone(validateSecurityConfig(raw));for(const key of ['includedRoots','excludedPaths','neverTouchPaths','localOnlyPaths'])config.filesystem[key]=await Promise.all(config.filesystem[key].map(canonicalRulePath));return freeze(config);}catch(e){if(e instanceof SecurityError)throw e;throw new SecurityError('CONFIG_INVALID','The security configuration could not be loaded. No tools were enabled.');}
}
async function canonicalRulePath(input){let current=input;const suffix=[];for(;;){try{return path.join(await realpath(current),...suffix);}catch(e){if(e.code!=='ENOENT')throw new SecurityError('CONFIG_INVALID','A configured security/privacy path could not be verified.');const parent=path.dirname(current);if(parent===current)return input;suffix.unshift(path.basename(current));current=parent;}}}

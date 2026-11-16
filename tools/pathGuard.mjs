import path from 'node:path';
import fs from 'node:fs';
import {promisify} from 'node:util';
import {ToolError} from './errors.mjs';
import {assertPathPolicy,hardExecutableTypes} from '../safety/pathRules.mjs';
// Callback-backed operations also handle Windows names that cannot be resolved
// by older Node fs/promises native bindings without an orphaned rejection.
const lstat=promisify(fs.lstat),realpath=promisify(fs.realpath.native),stat=promisify(fs.stat);
const capabilities=new WeakSet();
export const isValidatedPath=value=>!!value&&capabilities.has(value);

export function validatePathText(value,platform=process.platform){
  if(typeof value!=='string'||!value||/[\x00-\x1f]/.test(value))throw new ToolError('INVALID_PATH','A valid local path is required.');
  if(Array.from(value).some(ch=>{const n=ch.codePointAt(0);return n>=0xd800&&n<=0xdfff;}))throw new ToolError('INVALID_PATH','Malformed Unicode paths are not allowed.');
  if(/^[\\/]{2}/.test(value))throw new ToolError('UNC_DISABLED','UNC and Windows device paths are not allowed. Use a local drive folder.');
  if(value.split(/[\\/]/).includes('..'))throw new ToolError('PATH_TRAVERSAL','Parent-directory traversal is not allowed.');
  if(platform==='win32'){
    if(/[<>"|?*]/.test(value))throw new ToolError('INVALID_PATH','Invalid Windows path characters are not allowed.');
    if(value.split(/[\\/]/).some(part=>/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))throw new ToolError('INVALID_PATH','Windows device names are not allowed.');
    if(value.replace(/^[a-z]:/i,'').includes(':')||value.split(/[\\/]/).some(part=>/[. ]$/.test(part)&&part!=='.'))throw new ToolError('INVALID_PATH','Alternate data streams and ambiguous Windows paths are not allowed.');
    if(!path.win32.isAbsolute(value)||/^[\\/]/.test(value))throw new ToolError('INVALID_PATH','Use an absolute local drive path.');
  }else if(!path.isAbsolute(value))throw new ToolError('INVALID_PATH','Use an absolute local path.');
  return value;
}
export function containsPath(root,target,platform=process.platform){
  const p=platform==='win32'?path.win32:path.posix;
  const normalize=v=>{const normalized=p.resolve(v);return platform==='win32'?normalized.toLowerCase():normalized;};
  const relative=p.relative(normalize(root),normalize(target));
  return relative===''||(!relative.startsWith(`..${p.sep}`)&&relative!=='..'&&!p.isAbsolute(relative));
}
async function rejectLinks(target,inspectLink=lstat){
  const base=path.parse(target).root;
  let current=base;
  for(const segment of target.slice(base.length).split(path.sep).filter(Boolean)){
    current=path.join(current,segment);
    if((await inspectLink(current)).isSymbolicLink())throw new ToolError('LINK_BLOCKED','Symbolic links and junctions are not allowed in file-tool paths.');
  }
}
export class PathGuard {
  constructor(roots,blockedExtensions,security,fsOps={}){this.roots=roots;this.security=security;this.fsOps={lstat,realpath,stat,...fsOps};this.blocked=new Set([...hardExecutableTypes,...blockedExtensions,...security?.filesystem.blockedExecutableTypes||[]].map(x=>x.toLowerCase()));}
  async inspect(input,{opening=false,directory=false}={}){
    validatePathText(input);
    const target=path.resolve(input);
    if(this.storageRoots?.some(root=>containsPath(root,target)))throw new ToolError('PROTECTED_PATH','Index storage is not accessible through file tools.');
    assertPathPolicy(target,this.security,{skipIncludes:true});
    const root=this.roots.find(r=>containsPath(r.path,target));
    if(!root)throw new ToolError('OUTSIDE_ALLOWLIST','That path is outside the allowed folders.');
    await rejectLinks(target,this.fsOps.lstat);
    const [actualRoot,actual]=await Promise.all([this.fsOps.realpath(root.path),this.fsOps.realpath(target)]);
    if(this.storageRoots?.some(root=>containsPath(root,actual)))throw new ToolError('PROTECTED_PATH','Index storage is not accessible through file tools.');
    assertPathPolicy(actual,this.security);
    if(!containsPath(actualRoot,actual))throw new ToolError('OUTSIDE_ALLOWLIST','That file resolves outside the allowed folders.');
    const info=await this.fsOps.stat(actual);
    if(directory?!info.isDirectory():!info.isFile())throw new ToolError('INVALID_FILE',directory?'Choose an allowed folder.':'Only regular files can be opened.');
    if(opening&&!directory&&(!path.extname(actual)||this.blocked.has(path.extname(actual).toLowerCase())))throw new ToolError('BLOCKED_EXTENSION','Opening or revealing this executable/script file type (or an extensionless file) is blocked.');
    if(opening&&!directory&&this.security&&!this.security.filesystem.allowedFileTypes.includes(path.extname(actual).toLowerCase()))throw new ToolError('UNSUPPORTED_FILE','That file type is not approved for opening.');
    const capability=Object.freeze({path:actual,root,stat:info,kind:directory?'directory':'file',guard:this});capabilities.add(capability);return capability;
  }
  async destination(input){
    validatePathText(input);const target=path.resolve(input);assertPathPolicy(target,this.security,{skipIncludes:true});
    if(!this.roots.some(r=>containsPath(r.path,target)))throw new ToolError('OUTSIDE_ALLOWLIST','That destination is outside the allowed roots.');
    let ancestor=target;const proposed=[];
    for(;;){try{await this.fsOps.lstat(ancestor);break;}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(ancestor);if(parent===ancestor)throw new ToolError('NOT_FOUND','A valid destination ancestor could not be resolved.');proposed.unshift(path.basename(ancestor));ancestor=parent;}}
    const checked=await this.inspect(ancestor,{directory:true});
    const result=path.join(checked.path,...proposed);assertPathPolicy(result,this.security);
    const capability=Object.freeze({path:result,ancestor:checked.path,components:Object.freeze(proposed),kind:'destination',guard:this});capabilities.add(capability);return capability;
  }
  async revalidate(capability,options={}){if(!isValidatedPath(capability)||capability.guard!==this)throw new ToolError('PATH_DENIED','An internal validated path is required.');return capability.kind==='destination'?this.destination(capability.path):this.inspect(capability.path,{directory:capability.kind==='directory',...options});}
  async folders(selection){
    if(!selection)return this.roots;
    const alias=this.roots.find(r=>r.id.toLowerCase()===selection.toLowerCase());
    if(alias){await this.inspect(alias.path,{directory:true});return [alias];}
    const allowed=await this.inspect(selection,{directory:true});
    return [{...allowed.root,path:allowed.path}];
  }
}

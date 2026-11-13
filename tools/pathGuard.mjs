import path from 'node:path';
import {lstat,realpath,stat} from 'node:fs/promises';
import {ToolError} from './errors.mjs';

export function validatePathText(value,platform=process.platform){
  if(typeof value!=='string'||!value||/[\x00-\x1f]/.test(value))throw new ToolError('INVALID_PATH','A valid local path is required.');
  if(/^[\\/]{2}/.test(value))throw new ToolError('UNC_DISABLED','UNC and Windows device paths are not allowed. Use a local drive folder.');
  if(value.split(/[\\/]/).includes('..'))throw new ToolError('PATH_TRAVERSAL','Parent-directory traversal is not allowed.');
  if(platform==='win32'){
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
async function rejectLinks(target){
  const base=path.parse(target).root;
  let current=base;
  for(const segment of target.slice(base.length).split(path.sep).filter(Boolean)){
    current=path.join(current,segment);
    if((await lstat(current)).isSymbolicLink())throw new ToolError('LINK_BLOCKED','Symbolic links and junctions are not allowed in file-tool paths.');
  }
}
export class PathGuard {
  constructor(roots,blockedExtensions){this.roots=roots;this.blocked=new Set(blockedExtensions.map(x=>x.toLowerCase()));}
  async inspect(input,{opening=false,directory=false}={}){
    validatePathText(input);
    const target=path.resolve(input);
    const root=this.roots.find(r=>containsPath(r.path,target));
    if(!root)throw new ToolError('OUTSIDE_ALLOWLIST','That path is outside the allowed folders.');
    await rejectLinks(target);
    const [actualRoot,actual]=await Promise.all([realpath(root.path),realpath(target)]);
    if(!containsPath(actualRoot,actual))throw new ToolError('OUTSIDE_ALLOWLIST','That file resolves outside the allowed folders.');
    const info=await stat(actual);
    if(directory?!info.isDirectory():!info.isFile())throw new ToolError('INVALID_FILE',directory?'Choose an allowed folder.':'Only regular files can be opened.');
    if(opening&&(!path.extname(actual)||this.blocked.has(path.extname(actual).toLowerCase())))throw new ToolError('BLOCKED_EXTENSION','Opening or revealing this executable/script file type (or an extensionless file) is blocked.');
    return {path:actual,root,stat:info};
  }
  async folders(selection){
    if(!selection)return this.roots;
    const alias=this.roots.find(r=>r.id.toLowerCase()===selection.toLowerCase());
    if(alias){await this.inspect(alias.path,{directory:true});return [alias];}
    const allowed=await this.inspect(selection,{directory:true});
    return [{...allowed.root,path:allowed.path}];
  }
}

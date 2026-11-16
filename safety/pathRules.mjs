import path from 'node:path';
import {SecurityError} from './errors.mjs';
export const hardExecutableTypes=Object.freeze(['.exe','.com','.dll','.sys','.ocx','.pif','.sct','.msi','.msp','.msix','.appx','.bat','.cmd','.ps1','.psm1','.psd1','.vbs','.vbe','.js','.jse','.mjs','.cjs','.wsf','.wsh','.hta','.scr','.cpl','.lnk','.url','.website','.scf','.reg','.inf','.py','.pyw','.rb','.sh','.bash','.jar','.ahk','.chm','.application','.appref-ms','.docm','.dotm','.xlsm','.xlam','.pptm']);
const deniedSegments=new Set(['windows','system32','syswow64','program files','program files (x86)','programdata','system volume information','$recycle.bin','recycler','windowsapps','appdata','.ssh','.aws','.azure','.gnupg','.kube','.codex','.git','node_modules','.cache','cache','caches','.venv','venv','__pycache__','.mozilla','.config','.secrets','.password-store','user data']);
const credentialNames=new Set(['.env','.npmrc','.pypirc','.netrc','.git-credentials','id_rsa','id_ed25519','id_ecdsa','login data','cookies','web data','key4.db','logins.json','credentials.json','token.json','tokens.json']);
export function isWithin(root,target,platform=process.platform){const p=platform==='win32'?path.win32:path;const norm=s=>platform==='win32'?p.resolve(s).toLowerCase():p.resolve(s);const r=p.relative(norm(root),norm(target));return r===''||(!r.startsWith('..'+p.sep)&&r!=='..'&&!p.isAbsolute(r));}
export function assertPathPolicy(target,security,{skipIncludes=false}={}){
  const parts=target.split(/[\\/]/).filter(Boolean).map(p=>p.toLowerCase());
  if(parts.some(p=>deniedSegments.has(p)||credentialNames.has(p)||p.startsWith('.env.')||/\.(?:pem|key|kdbx|p12|pfx)$/.test(p)))throw new SecurityError('PROTECTED_PATH','Edith cannot access protected system, credential or dependency locations.');
  if([process.env.SystemRoot,process.env.windir,process.env.ProgramFiles,process.env['ProgramFiles(x86)'],process.env.ProgramData,process.env.APPDATA,process.env.LOCALAPPDATA].filter(Boolean).some(p=>isWithin(p,target)))throw new SecurityError('PROTECTED_PATH','Edith cannot access OS-protected application or profile locations.');
  const fs=security?.filesystem;
  if(security?.logging?.directory&&isWithin(security.logging.directory,target))throw new SecurityError('PROTECTED_PATH','Security audit storage is not accessible through file tools.');
  if(fs){
    if(fs.neverTouchPaths.some(p=>isWithin(p,target)))throw new SecurityError('PATH_DENIED','That location is marked never-touch.');
    if(fs.excludedPaths.some(p=>isWithin(p,target)))throw new SecurityError('PATH_DENIED','That location is excluded from tool access.');
    if(!skipIncludes&&fs.includedRoots.length&&!fs.includedRoots.some(p=>isWithin(p,target)))throw new SecurityError('PATH_DENIED','That location is outside the security configuration roots.');
  }
}
export function isLocalOnly(target,security){return security.filesystem.localOnlyPaths.some(p=>isWithin(p,target));}

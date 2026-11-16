import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {SecurityError} from './errors.mjs';
import {requirePermit} from './policy.mjs';
import {isValidatedPath} from '../tools/pathGuard.mjs';
const exec=promisify(execFile);
const windowsRoot=()=>process.env.SystemRoot||'C:\\Windows';
export async function restrictAuditDirectory(directory){
  let current=path.parse(directory).root;
  for(const part of directory.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);try{if((await lstat(current)).isSymbolicLink())throw new SecurityError('AUDIT_WRITE_FAILED','Audit directory links are not permitted.');}catch(e){if(e.code==='ENOENT')break;throw e;}}
  await mkdir(directory,{recursive:true,mode:0o700});
  if((await lstat(directory)).isSymbolicLink())throw new SecurityError('AUDIT_WRITE_FAILED','Audit directory links are not permitted.');
  if(process.platform!=='win32')return;
  try{
    const {stdout}=await exec(path.join(windowsRoot(),'System32','whoami.exe'),['/user','/fo','csv','/nh'],{windowsHide:true,timeout:5000});
    const sid=stdout.match(/S-1-5-[0-9-]+/)?.[0];if(!sid)throw new Error();
    await exec(path.join(windowsRoot(),'System32','icacls.exe'),[directory,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F'],{windowsHide:true,timeout:5000});
  }catch{throw new SecurityError('AUDIT_WRITE_FAILED','Windows could not restrict the new security audit directory. No privileged tools were enabled.');}
}
export async function getDriveInformation({permit,session}={}){
  requirePermit(permit,session,'get_drive_information');
  if(process.platform!=='win32')throw new SecurityError('UNSUPPORTED_OPERATION','Fixed-drive metadata discovery is Windows-only.');
  // Fixed application-authored command, no user/model interpolation. It reads metadata only.
  const script="Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress";
  try{const {stdout}=await exec(path.join(windowsRoot(),'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,maxBuffer:32768});const data=JSON.parse(stdout||'[]');return (Array.isArray(data)?data:[data]).map(d=>({root:d.DeviceID+'\\',type:'fixed',size:d.Size,freeSpace:d.FreeSpace}));}catch{throw new SecurityError('OPERATION_FAILED','Fixed-drive information is unavailable. No drive access was granted.');}
}
export const approvedApplicationContract=Object.freeze({fields:['applicationId','trustedExecutable','allowedArgumentTypes','allowedWorkingDirectories','requiredRiskClassification'],implemented:false});
export function recycleFile(){throw new SecurityError('UNSUPPORTED_OPERATION','Native Recycle Bin operations are deferred; no file was deleted.');}
export function restoreRecycledFile(){throw new SecurityError('UNSUPPORTED_OPERATION','Recycle Bin restoration is not implemented.');}
export function launchApprovedApplication(){throw new SecurityError('UNSUPPORTED_OPERATION','General approved-application launching is a future phase.');}
export function openFolder(){throw new SecurityError('UNSUPPORTED_OPERATION','Opening whole folders is not registered in Phase 1.');}
export async function getFileMetadata(capability,{permit,session}={}){requirePermit(permit,session,'get_file_metadata');if(!isValidatedPath(capability))throw new SecurityError('PATH_DENIED','A validated file reference is required.');const current=await capability.guard.revalidate(capability);return {size:current.stat.size,modifiedAt:current.stat.mtime.toISOString(),kind:current.kind};}

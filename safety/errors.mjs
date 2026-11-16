export class SecurityError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
export function failure(error){
  if(error instanceof SecurityError)return {error:{code:error.code,message:error.message}};
  const messages={ENOENT:['FILE_MISSING','The file or folder no longer exists. Search again.'],EACCES:['PERMISSION_DENIED','Windows denied access to that file or folder.'],EPERM:['PERMISSION_DENIED','Windows denied access to that file or folder.']};
  const [code,message]=messages[error?.code]||['OPERATION_FAILED','The operation could not be completed.'];
  return {error:{code,message}};
}
export function errorStatus(code){return ['AUTH_DENIED','CSRF_DENIED'].includes(code)?401:['ORIGIN_DENIED','PATH_DENIED','PROTECTED_PATH','PRIVACY_DENIED','FORBIDDEN','OUTSIDE_ALLOWLIST'].includes(code)?403:code==='TOOL_NOT_FOUND'?404:code?.startsWith('CONFIRMATION_')?409:['AUDIT_WRITE_FAILED','OPERATION_FAILED'].includes(code)?500:400;}

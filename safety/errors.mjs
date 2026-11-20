export class SecurityError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
export function failure(error){
  if(error instanceof SecurityError)return {error:{code:error.code,message:error.message}};
  const messages={ENOENT:['FILE_MISSING','The file or folder no longer exists. Search again.'],EACCES:['PERMISSION_DENIED','Windows denied access to that file or folder.'],EPERM:['PERMISSION_DENIED','Windows denied access to that file or folder.']};
  const [code,message]=messages[error?.code]||['OPERATION_FAILED','The operation could not be completed.'];
  return {error:{code,message}};
}
export function errorStatus(code){return ['AUTH_DENIED','CSRF_DENIED'].includes(code)?401:['ORIGIN_DENIED','PATH_DENIED','PROTECTED_PATH','PRIVACY_DENIED','FORBIDDEN','OUTSIDE_ALLOWLIST','COMPANION_DISABLED','COMPANION_NOT_PAIRED','CAPABILITY_DENIED','APP_NOT_APPROVED','APP_DISABLED'].includes(code)?403:['TOOL_NOT_FOUND','NOT_FOUND','APP_NOT_INSTALLED','ACTION_NOT_FOUND'].includes(code)?404:['CANCELLED','FILE_EXISTS','FILE_CHANGED','INVALID_STATE_TRANSITION','PAIRING_INVALID','PAIRING_EXPIRED','NOT_UNDOABLE','UNDO_PRECONDITION_FAILED'].includes(code)||code?.startsWith('CONFIRMATION_')?409:code==='FILE_TOO_LARGE'?413:['EXTRACTION_UNSUPPORTED'].includes(code)?422:['LOOP_DETECTED','RESOURCE_LIMIT'].includes(code)?429:code==='COMPANION_UNAVAILABLE'?503:code==='TOOL_TIMEOUT'?504:['AUDIT_WRITE_FAILED','OPERATION_FAILED'].includes(code)?500:400;}

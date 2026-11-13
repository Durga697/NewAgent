export class ToolError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
export function toolFailure(error){
  if(error instanceof ToolError)return {error:{code:error.code,message:error.message}};
  const messages={ENOENT:['FILE_MISSING','The file or folder no longer exists. Search again.'],EACCES:['PERMISSION_DENIED','Windows denied access to that file or folder.'],EPERM:['PERMISSION_DENIED','Windows denied access to that file or folder.']};
  const [code,message]=messages[error?.code]||['TOOL_FAILED','The local tool could not complete the request.'];
  return {error:{code,message}};
}

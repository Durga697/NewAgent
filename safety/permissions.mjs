export const toolSecurity={
  list_allowed_folders:{riskLevel:'READ_ONLY',requiredPermissions:['files.read'],requiresPathValidation:false,requiresConfirmation:false},
  search_files:{riskLevel:'READ_ONLY',requiredPermissions:['files.read'],requiresPathValidation:true,requiresConfirmation:false},
  open_file:{riskLevel:'READ_ONLY',requiredPermissions:['files.open'],requiresPathValidation:true,requiresConfirmation:false},
  reveal_in_folder:{riskLevel:'READ_ONLY',requiredPermissions:['files.reveal'],requiresPathValidation:true,requiresConfirmation:false},
  open_folder:{riskLevel:'READ_ONLY',requiredPermissions:['files.reveal'],requiresPathValidation:true,requiresConfirmation:false},
  get_file_metadata:{riskLevel:'READ_ONLY',requiredPermissions:['files.read'],requiresPathValidation:true,requiresConfirmation:false},
  resolve_file_reference:{riskLevel:'READ_ONLY',requiredPermissions:['files.read'],requiresPathValidation:false,requiresConfirmation:false},
  get_index_status:{riskLevel:'READ_ONLY',requiredPermissions:['index.read'],requiresPathValidation:false,requiresConfirmation:false},
  get_drive_information:{riskLevel:'READ_ONLY',requiredPermissions:['drives.read'],requiresPathValidation:false,requiresConfirmation:false},
  index_control:{riskLevel:'READ_ONLY',requiredPermissions:['index.control'],requiresPathValidation:false,requiresConfirmation:false},
  check_availability:{riskLevel:'READ_ONLY',requiredPermissions:['calendar.read'],requiresPathValidation:false,requiresConfirmation:false},
  prepare_booking:{riskLevel:'READ_ONLY',requiredPermissions:['calendar.draft'],requiresPathValidation:false,requiresConfirmation:false}
};
export function userPermissions(text,{fileContinuation=false}={}){
  const permissions=['calendar.read','calendar.draft'];
  const fileRequest=/\b(?:find|search|locate|files?|folders?|downloads|documents?|invoice|bill|resume|open|reveal|explorer|pdfs?|excel|spreadsheets?|powerpoint|images?|photos?|pictures?|videos?|audio|python|projects?|onedrive|screenshots?)\b/i.test(text);
  const selection=fileContinuation&&/^(?:open |show |the |yes|first|second|third|[1-9])/i.test(text.trim());
  if(fileRequest||selection)permissions.push('files.read','files.open','files.reveal','cloud.metadata','confirmation.create','confirmation.approve');
  if(/\b(?:index|indexing|scan|scanning)\b/i.test(text))permissions.push('index.read');
  if(/\b(?:start|pause|resume|cancel|rebuild|rescan)\b.*\b(?:index|indexing|scan|scanning)\b/i.test(text))permissions.push('index.control');
  if(/\b(?:drive|drives|volume|volumes)\b/i.test(text))permissions.push('drives.read');
  return permissions;
}

import {AuditService} from '../safety/audit.mjs';
export function auditLogger(filename){
  const service=new AuditService(filename);return record=>service.append(record);
}

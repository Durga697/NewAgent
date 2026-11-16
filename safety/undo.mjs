import {SecurityError} from './errors.mjs';
export const UndoState=Object.freeze({PENDING:'PENDING',COMPLETED:'COMPLETED',UNDONE:'UNDONE',FAILED:'FAILED',NOT_UNDOABLE:'NOT_UNDOABLE'});
/** Future Phase 4 contract. No file mutation or restore is implemented. */
export function undoDescriptor({operationId,operationType,affectedFileIds=[],originalLocation=null,newLocation=null}={}){
  if(typeof operationId!=='string'||typeof operationType!=='string'||!Array.isArray(affectedFileIds))throw new SecurityError('INVALID_ARGUMENTS','Invalid undo descriptor.');
  return Object.freeze({operationId,operationType,timestamp:new Date().toISOString(),originalLocation,newLocation,affectedFileIds:Object.freeze([...affectedFileIds]),operationStatus:UndoState.NOT_UNDOABLE,undoAvailability:false,undoExpiration:null});
}

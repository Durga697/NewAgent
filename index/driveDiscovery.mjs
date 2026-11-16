import {getDriveInformation} from '../safety/windowsContracts.mjs';
import {containsPath} from '../tools/pathGuard.mjs';
export async function discoverDrives(context){const drives=await getDriveInformation({permit:context.execution,session:context.session});return {drives:drives.map(d=>({...d,id:d.root.replace(/[\\/]$/,''),eligible:context.files.config.roots.some(r=>containsPath(d.root,r.path)),authorizedRoots:context.files.config.roots.filter(r=>containsPath(d.root,r.path)).map(r=>r.id)})),message:'Discovery does not grant indexing permission. Only configured roots may be indexed.'};}

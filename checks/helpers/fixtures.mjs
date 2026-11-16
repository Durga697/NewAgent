import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
export const fixtureBase=path.resolve('data/test-fixtures');
export async function disposable(prefix){await mkdir(fixtureBase,{recursive:true});return mkdtemp(path.join(fixtureBase,prefix));}
export async function removeDisposable(dir){const target=path.resolve(dir);if(!target.startsWith(fixtureBase+path.sep)||target===fixtureBase)throw new Error('Refusing cleanup outside disposable fixtures.');await rm(target,{recursive:true,force:true});}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadEnvironment} from '../environment.mjs';

test('local settings replace stale inherited credentials; production and tests stay isolated',()=>{
  const dir=mkdtempSync(join(tmpdir(),'frontdesk-env-')),localPath=join(dir,'.env.local'),basePath=join(dir,'.env');
  try{
    writeFileSync(localPath,'GEMINI_API_KEY=local-sentinel\nPORT=3999\n');
    writeFileSync(basePath,'GEMINI_API_KEY=base-sentinel\nGEMINI_VOICE=Kore\n');
    const env={GEMINI_API_KEY:'inherited-sentinel'};
    loadEnvironment({env,localPath,basePath});
    assert.equal(env.GEMINI_API_KEY,'local-sentinel');assert.equal(env.PORT,'3999');assert.equal(env.GEMINI_VOICE,'Kore');
    for(const mode of ['production','test']){
      const isolated={NODE_ENV:mode,GEMINI_API_KEY:'explicit-sentinel'};
      loadEnvironment({env:isolated,localPath,basePath});
      assert.equal(isolated.GEMINI_API_KEY,'explicit-sentinel');assert.equal(isolated.PORT,undefined);
    }
  }finally{unlinkSync(localPath);unlinkSync(basePath);rmdirSync(dir);}
});

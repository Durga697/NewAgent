import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,utimes,mkdir,symlink,rm,readFile,realpath,rmdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {loadFileConfig} from '../tools/config.mjs';
import {PathGuard,containsPath,validatePathText} from '../tools/pathGuard.mjs';
import {FileService} from '../tools/service.mjs';
import {ToolRegistry,fileTools} from '../tools/registry.mjs';
import {auditLogger} from '../tools/audit.mjs';
import {toolFailure} from '../tools/errors.mjs';

async function fixture(){
  const dir=await mkdtemp(path.join(tmpdir(),'edith-tools-')),root=path.join(dir,'Downloads'),outside=path.join(dir,'Outside');
  await mkdir(root);await mkdir(outside);
  const config={...await loadFileConfig(),enabled:true,roots:[{id:'Downloads',path:root}],auditFile:path.join(dir,'audit.jsonl'),resultTtlSeconds:60,maxFiles:100,maxDepth:4};
  const launches=[],service=new FileService(config,{launch:async(action,file)=>launches.push({action,file})});
  const registry=new ToolRegistry(fileTools,auditLogger(config.auditFile));
  const session={id:'sample-session',fileSpeechAt:Date.now()},context={session,files:service,source:'voice'};
  async function add(name,modified='2026-01-01T12:00:00Z',contents='PRIVATE CONTENT MUST NEVER LEAVE THE COMPUTER'){
    const file=path.join(root,name);await writeFile(file,contents);await utimes(file,new Date(modified),new Date(modified));return file;
  }
  async function close(){await service.close();const target=path.resolve(dir);assert(target.startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(target).startsWith('edith-tools-'));await rm(target,{recursive:true,force:true});}
  return {dir,root,outside,config,service,registry,session,context,launches,add,close,call:(name,args={},ctx=context)=>registry.call(name,args,ctx)};
}
test('Windows containment is case-insensitive, separator aware and refuses UNC, ADS and traversal',()=>{
  assert(containsPath('C:\\Users\\Sam\\Downloads','c:\\users\\SAM\\downloads\\bill.pdf','win32'));
  assert(!containsPath('C:\\Users\\Sam\\Downloads','C:\\Users\\Sam\\Downloads-old\\bill.pdf','win32'));
  assert(!containsPath('C:\\Users\\Sam\\Downloads','D:\\Downloads\\bill.pdf','win32'));
  for(const candidate of ['C:\\Users\\Sam\\Downloads\\..\\private.pdf','\\\\server\\share\\bill.pdf','\\\\?\\C:\\Downloads\\bill.pdf','C:\\Downloads\\bill.pdf:run.ps1','C:\\Downloads\\bill.pdf.','C:relative.pdf','C:\\Downloads\\NUL.pdf'])assert.throws(()=>validatePathText(candidate,'win32'));
});
test('path guard rejects outside paths, traversal, symlink/junction escapes and blocked uppercase extensions',async()=>{
  const f=await fixture();try{
    const guard=f.service.guard;
    const inside=await f.add('bill.pdf');assert.equal((await guard.inspect(inside)).path,await realpath(inside));
    await assert.rejects(()=>guard.inspect(path.join(f.outside,'secret.pdf')),/outside/);
    await assert.rejects(()=>guard.inspect(f.root+path.sep+'..'+path.sep+'Outside'+path.sep+'secret.pdf'),/traversal/);
    await writeFile(path.join(f.outside,'secret.pdf'),'private');
    const link=path.join(f.root,'escape');await symlink(f.outside,link,process.platform==='win32'?'junction':'dir');
    await assert.rejects(()=>guard.inspect(path.join(link,'secret.pdf')),/links and junctions/);
    const bad=await f.add('invoice.PS1');await assert.rejects(()=>guard.inspect(bad,{opening:true}),/blocked/);
    if(process.platform==='win32'){const upper=inside.toUpperCase();assert.equal((await guard.inspect(upper)).path.toLowerCase(),(await realpath(inside)).toLowerCase());}
  }finally{await f.close();}
});
test('search handles typos, word order, latest, extension/date filters, empty matches and metadata only',async()=>{
  const f=await fixture();try{
    await f.add('Electricity bill January.pdf','2026-01-10T10:00:00Z');await f.add('February bill electricity.pdf','2026-02-12T10:00:00Z');await f.add('electricity bill draft.docx','2026-02-15T10:00:00Z');await f.add('holiday.jpg');
    await f.service.start();
    const result=await f.call('search_files',{query:'my latest electrcity bil',folder:'downloads',extensions:['pdf'],sortBy:'modifiedDesc'});
    assert.equal(result.results.length,2);assert.equal(result.results[0].name,'February bill electricity.pdf');assert.equal(result.results[1].ordinal,2);
    assert(!JSON.stringify(result).includes('PRIVATE CONTENT'));assert(result.results[0].path);assert(result.results[0].size>0);
    const filtered=await f.call('search_files',{query:'bill electricity',modifiedAfter:'2026-02-01',modifiedBefore:'2026-02-12',extensions:['.pdf']});assert.equal(filtered.results.length,1);
    assert.deepEqual((await f.call('search_files',{query:'definitelyunrelatedxyz'})).results,[]);
    assert.equal((await f.call('search_files',{query:'bill',modifiedAfter:'2026-02-30'})).error.code,'INVALID_DATE');
  }finally{await f.close();}
});
test('voice chooses second result; ambiguous/unrequested actions wait; UI click can choose a result',async()=>{
  const f=await fixture();try{
    await f.add('electricity bill old.pdf','2026-01-01T12:00:00Z');await f.add('electricity bill new.pdf','2026-02-01T12:00:00Z');await f.service.start();
    const found=await f.call('search_files',{query:'electricity bill'});const second=found.results[1];
    f.session.fileUserSpeech='Find my latest electricity bill';
    assert.equal((await f.call('open_file',{resultId:second.resultId})).status,'confirmation_required');assert.equal(f.launches.length,0);
    f.session.fileUserSpeech='Open the first one';assert.equal((await f.call('open_file',{resultId:second.resultId})).status,'confirmation_required');
    f.session.fileUserSpeech='Open the second one';assert.equal((await f.call('open_file',{resultId:second.resultId})).status,'launched');assert.equal(f.launches[0].file,second.path);
    f.session.fileSpeechAt=Date.now();f.session.fileUserSpeech="Don't open the second one";assert.equal((await f.call('open_file',{resultId:second.resultId})).status,'confirmation_required');
    assert.equal((await f.call('reveal_in_folder',{resultId:second.resultId},{...f.context,source:'ui'})).status,'launched');assert.equal(f.launches.at(-1).action,'reveal');
    const records=(await readFile(f.config.auditFile,'utf8')).trim().split('\n').map(JSON.parse);assert(records.some(x=>x.tool==='open_file'&&x.outcome==='launched'));assert(records.every(x=>x.timestamp&&x.args&&typeof x.resultCount==='number'));
  }finally{await f.close();}
});
test('invalid arguments, raw paths and cross-session/expired IDs fail; refusals are audited',async()=>{
  const f=await fixture();try{
    await f.add('bill.pdf');await f.service.start();const found=await f.call('search_files',{query:'bill'}),id=found.results[0].resultId;
    for(const args of [{},{query:'bill',limit:0},{query:'bill',limit:'2'},{query:'bill',extensions:['../exe']},{query:'bill',arbitrary:true}])assert.equal((await f.call('search_files',args)).error.code,'INVALID_ARGUMENTS');
    assert.equal((await f.call('open_file',{path:found.results[0].path})).error.code,'INVALID_ARGUMENTS');
    assert.equal((await f.call('open_file',{resultId:id},{...f.context,session:{id:'other'},source:'ui'})).error.code,'UNKNOWN_RESULT');
    assert.equal((await f.call('search_files',{query:'bill',folder:f.outside})).error.code,'OUTSIDE_ALLOWLIST');
    assert.equal((await f.call('search_files',{query:'..\\secret.pdf'})).error.code,'INVALID_QUERY');
    assert.equal((await f.call('search_files',{query:'bill',folder:f.root+path.sep+'..'+path.sep+'Outside'})).error.code,'PATH_TRAVERSAL');
    const same=await f.call('search_files',{query:'bill'});assert.equal(same.results[0].resultId,id);
    f.service.results.state(f.session).entries.get(id).expiresAt=0;
    assert.equal((await f.call('open_file',{resultId:id},{...f.context,source:'ui'})).error.code,'RESULT_EXPIRED');assert.equal(f.launches.length,0);
    const log=await readFile(f.config.auditFile,'utf8');assert(log.includes('OUTSIDE_ALLOWLIST'));assert(log.includes('PATH_TRAVERSAL'));
  }finally{await f.close();}
});
test('blocked, removed, replaced and link-swapped search results never reach Windows',async()=>{
  const f=await fixture();try{
    const bad=await f.add('bill.exe');const gone=await f.add('bill-gone.pdf');const swapped=await f.add('bill-changed.pdf');await f.service.start();
    const found=await f.call('search_files',{query:'bill'});const id=name=>found.results.find(x=>x.name===name).resultId;
    assert.equal((await f.call('open_file',{resultId:id('bill.exe')},{...f.context,source:'ui'})).error.code,'BLOCKED_EXTENSION');
    await rm(gone);assert.equal((await f.call('open_file',{resultId:id('bill-gone.pdf')},{...f.context,source:'ui'})).error.code,'FILE_MISSING');
    await writeFile(swapped,'replacement contents are different');assert.equal((await f.call('open_file',{resultId:id('bill-changed.pdf')},{...f.context,source:'ui'})).error.code,'FILE_CHANGED');
    assert.equal(f.launches.length,0);
    const sub=path.join(f.service.config.roots[0].path,'safe');await mkdir(sub);const file=path.join(sub,'bill.pdf');await writeFile(file,'test');await f.service.index.upsert(file);
    const prior=await f.call('search_files',{query:'bill',folder:sub});const resultId=prior.results[0].resultId;
    await rm(file);await rmdir(sub);await writeFile(path.join(f.outside,'bill.pdf'),'outside');await symlink(f.outside,sub,process.platform==='win32'?'junction':'dir');
    assert.equal((await f.call('open_file',{resultId},{...f.context,source:'ui'})).error.code,'LINK_BLOCKED');assert.equal(f.launches.length,0);
  }finally{await f.close();}
});
test('watcher adds/removes filenames; missing folders and permission errors are explicit',async()=>{
  const f=await fixture();try{
    await f.service.start();const file=await f.add('new-bill.pdf');
    const wait=async condition=>{for(let i=0;i<80;i++){if(await condition())return;await new Promise(r=>setTimeout(r,50));}assert.fail('watcher update timed out');};
    const canonical=await realpath(file);await wait(()=>f.service.index.entries.has(f.service.index.key(canonical)));await rm(file);await wait(()=>!f.service.index.entries.has(f.service.index.key(canonical)));
    assert.equal(toolFailure({code:'EACCES'}).error.code,'PERMISSION_DENIED');
    const missing=new FileService({...f.config,roots:[{id:'Missing',path:path.join(f.dir,'Missing')}]});await missing.start();assert.equal(missing.index.folders()[0].available,false);await missing.close();
  }finally{await f.close();}
});
test('audit failure prevents action execution',async()=>{
  let ran=false;const registry=new ToolRegistry([{name:'sample',parameters:{type:'object',properties:{}},run:()=>{ran=true;return {};}}],()=>{throw {code:'EACCES'};});
  const result=await registry.call('sample',{}, {session:{id:'x'}});assert(result.error);assert.equal(ran,false);
});
test('one clear match accepts confirmation once; quoted names and stale/cancelled actions do not open',async()=>{
  const f=await fixture();try{
    await f.add('open me.pdf');await f.service.start();
    let found=await f.call('search_files',{query:'open me'});const resultId=found.results[0].resultId;
    f.session.fileUserSpeech='Find the file named open me pdf';assert.equal((await f.call('open_file',{resultId})).status,'confirmation_required');assert.equal(f.launches.length,0);
    f.session.fileUserSpeech='Yes please';f.session.fileSpeechAt=Date.now();assert.equal((await f.call('open_file',{resultId})).status,'launched');assert.equal(f.launches.length,1);
    f.session.fileUserSpeech='Open it';f.session.fileSpeechAt=Date.now()-61000;assert.equal((await f.call('open_file',{resultId})).status,'confirmation_required');
    assert.equal((await f.call('open_file',{resultId},{...f.context,source:'ui',isCancelled:()=>true})).error.code,'CANCELLED');assert.equal(f.launches.length,1);
    assert.equal((await f.call('search_files',{query:'open me'},{...f.context,isCancelled:()=>true})).error.code,'CANCELLED');
  }finally{await f.close();}
});

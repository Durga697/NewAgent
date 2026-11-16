import {csrfHeaders} from './security.js';
const $=id=>document.getElementById(id);
let latest=null,folders=[],searchController;

async function call(name,args,signal){
  const response=await fetch(`/api/file-tools/${name}`,{method:'POST',headers:{'Content-Type':'application/json',...csrfHeaders()},body:JSON.stringify(args),signal});
  const body=await response.json();if(!response.ok||body.error)throw new Error(body.error?.message||body.error||'The file tool could not finish.');return body;
}
const text=(tag,value,className)=>{const el=document.createElement(tag);el.textContent=value;if(className)el.className=className;return el;};
function showAction(value){$('fileAction').textContent=value?.status==='confirmation_required'?value.message:value?.message||'';}
function formatSize(size){return size<1024?`${size} B`:size<1024*1024?`${(size/1024).toFixed(1)} KB`:`${(size/1024/1024).toFixed(1)} MB`;}
function render(output){
  latest=output;$('fileResults').replaceChildren();$('fileNext').classList.toggle('hidden',!output?.nextCursor);
  if(!output){$('fileResults').append(text('p','Matching files will appear here.'));return;}
  if(output.filters){$('fileQuery').value=output.query||$('fileQuery').value;if(output.filters.fileType)$('fileType').value=output.filters.fileType;if(output.filters.sortBy)$('fileSort').value=output.filters.sortBy;}
  if(output.warnings?.length)$('fileResults').append(text('p',output.warnings.join(' '),'file-warning'));
  if(!output.results.length){$('fileResults').append(text('p','No matching filenames. Try fewer words, a different file type, or another allowed folder.'));return;}
  for(const [index,item] of output.results.entries()){
    const row=text('article','','file-result'),details=text('div','','file-details');
    details.append(text('span',item.isDirectory?'Folder':item.extension||item.fileType||'File','file-metadata'));
    details.append(text('h3',`${index+1}. ${item.name}`),text('p',item.folder,'file-folder'),text('p',`${new Date(item.modifiedAt).toLocaleString()} · ${formatSize(item.size)}`,'file-metadata'));
    const actions=text('div','','file-buttons');
    for(const [name,label] of [['open_file','Open'],['reveal_in_folder','Show in folder'],['open_folder','Open folder']]){
      const button=text('button',label,'secondary');
      button.type='button';button.setAttribute('aria-label',`${label}: ${item.name}`);
      button.onclick=async()=>{
        actions.querySelectorAll('button').forEach(b=>b.disabled=true);
        try{showAction(await call(name,{resultId:item.resultId}));}catch(error){$('fileAction').textContent=error.message;}
        finally{actions.querySelectorAll('button').forEach(b=>b.disabled=false);}
      };actions.append(button);
    }
    row.append(details,actions);$('fileResults').append(row);
  }
  if(output.limited)$('fileResults').append(text('p','Showing a limited set of results. Narrow your filename words, folder or file type.','file-metadata'));
}
window.addEventListener('edith:ready',event=>{
  const settings=event.detail;
  if(settings.hosted){
    $('localFiles').hidden=true;
    document.querySelector('.page-head h1').textContent='Book an appointment with Edith';
    document.querySelector('.page-head p').textContent='Ask about available times or choose one from the demo calendar.';
    $('voiceHint').textContent='Tell Edith which appointment you would like to book.';
    return;
  }
  folders=settings.folders||[];renderIndex(settings.indexStatus);$('indexSettings').textContent=JSON.stringify(settings.settings||{});
  $('fileFolder').replaceChildren();const all=text('option','All authorized roots');all.value='';$('fileFolder').append(all);
  for(const folder of folders){const option=text('option',`${folder.id}${folder.available?'':' (unavailable)'}`);option.value=folder.id;$('fileFolder').append(option);}
  const enabled=settings.enabled&&folders.some(f=>f.available);
  $('fileQuery').disabled=!enabled;$('fileFolder').disabled=!enabled;$('fileSearchButton').disabled=!enabled;
  $('fileFolderStatus').textContent=!settings.enabled?'Local file tools are disabled.':folders.map(f=>`${f.id}: ${f.available?f.path:(f.error?.message||'unavailable')}`).join(' · ')||'No folders are configured.';
  render(settings.results);
});
window.addEventListener('edith:files',event=>{render(event.detail);$('localFiles').scrollIntoView({behavior:'smooth',block:'start'});});
window.addEventListener('edith:file-action',event=>showAction(event.detail));

async function runSearch(cursor){
  searchController?.abort();searchController=new AbortController();$('fileSearchButton').disabled=true;$('fileNext').disabled=true;$('fileAction').textContent='Searching filenames…';
  try{
    const args=cursor?{cursor}:{query:$('fileQuery').value.trim()};
    if(!cursor){for(const [id,key] of [['fileFolder','folder'],['fileType','fileType'],['fileSort','sortBy'],['fileAfter','modifiedAfter'],['fileBefore','modifiedBefore']])if($(id).value)args[key]=$(id).value;if($('fileDrive').value)args.drive=$('fileDrive').value.toUpperCase()+':';if($('fileMinSize').value)args.minSize=Math.round(Number($('fileMinSize').value)*1024*1024);}
    const result=await call('search_files',args,searchController.signal);render(result);$('fileAction').textContent=`${result.results.length} matching file${result.results.length===1?'':'s'}.`;
  }catch(error){if(error.name!=='AbortError')$('fileAction').textContent=error.message;}
  finally{$('fileSearchButton').disabled=false;$('fileNext').disabled=false;}
}
$('fileSearchForm').onsubmit=event=>{event.preventDefault();runSearch();};
$('fileNext').onclick=()=>{if(latest?.nextCursor)runSearch(latest.nextCursor);};
function renderIndex(status){
  if(!status)return;$('indexBadge').textContent=status.status||'idle';$('indexBusy').classList.toggle('hidden',!status.indexing);
  $('indexProgress').textContent=`${status.count||0} indexed · ${status.scanned||0} entries scanned · ${status.directories||0} folders · ${status.skipped||0} skipped · ${status.permissionErrors||0} permission errors · ${status.filesPerSecond||0}/sec · ${Math.round((status.elapsedMs||0)/1000)} sec${status.currentRoot?' · '+status.currentRoot:''}${status.lastSuccessfulScan?' · Last complete scan '+new Date(status.lastSuccessfulScan).toLocaleString():''}${status.lastErrorCode?' · '+status.lastErrorCode:''}${status.watcherWarning?' · '+status.watcherWarning:''}`;
  for(const button of document.querySelectorAll('[data-index]'))button.disabled=button.dataset.index==='start'?['running','paused'].includes(status.status):button.dataset.index==='pause'?status.status!=='running':button.dataset.index==='resume'?status.status!=='paused':false;
}
window.addEventListener('edith:index',event=>renderIndex(event.detail));
for(const button of document.querySelectorAll('[data-index]'))button.onclick=async()=>{
  button.disabled=true;try{const result=await call('index_control',{action:button.dataset.index});$('fileAction').textContent=result.message;$('indexRebuildReview').classList.add('hidden');const response=await fetch('/api/index/status');renderIndex(await response.json());}catch(e){$('fileAction').textContent=e.message;}finally{button.disabled=false;}
};
$('indexRebuild').onclick=()=>$('indexRebuildReview').classList.toggle('hidden');
$('discoverDrives').onclick=async()=>{try{const result=await call('get_drive_information',{});$('driveStatus').textContent=result.drives.map(d=>`${d.id}: ${d.eligible?'configured roots available':'not authorized for indexing'}`).join(' · ');}catch(e){$('driveStatus').textContent=e.message;}};

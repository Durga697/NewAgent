const $=id=>document.getElementById(id);
let latest=null,folders=[];
async function call(name,args){
  const response=await fetch(`/api/file-tools/${name}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});
  const body=await response.json();if(!response.ok||body.error)throw new Error(body.error?.message||body.error||'The file tool could not finish.');return body;
}
const text=(tag,value,className)=>{const el=document.createElement(tag);el.textContent=value;if(className)el.className=className;return el;};
function showAction(value){$('fileAction').textContent=value?.status==='confirmation_required'?value.message:value?.message||'';}
function formatSize(size){return size<1024?`${size} B`:size<1024*1024?`${(size/1024).toFixed(1)} KB`:`${(size/1024/1024).toFixed(1)} MB`;}
function render(output){
  latest=output;$('fileResults').replaceChildren();
  if(!output){$('fileResults').append(text('p','Matching files will appear here.'));return;}
  if(output.warnings?.length)$('fileResults').append(text('p',output.warnings.join(' '),'file-warning'));
  if(!output.results.length){$('fileResults').append(text('p','No matching filenames. Try fewer words, a different file type, or another allowed folder.'));return;}
  for(const [index,item] of output.results.entries()){
    const row=text('article','','file-result'),details=text('div','','file-details');
    details.append(text('h3',`${index+1}. ${item.name}`),text('p',item.folder,'file-folder'),text('p',`${new Date(item.modifiedAt).toLocaleString()} · ${formatSize(item.size)}`,'file-metadata'));
    const actions=text('div','','file-buttons');
    for(const [name,label] of [['open_file','Open'],['reveal_in_folder','Show in folder']]){
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
  const settings=event.detail;folders=settings.folders||[];
  $('fileFolder').replaceChildren();
  for(const folder of folders){const option=text('option',`${folder.id}${folder.available?'':' (unavailable)'}`);option.value=folder.id;$('fileFolder').append(option);}
  const enabled=settings.enabled&&folders.some(f=>f.available);
  $('fileQuery').disabled=!enabled;$('fileFolder').disabled=!enabled;$('fileSearchButton').disabled=!enabled;
  $('fileFolderStatus').textContent=!settings.enabled?'Local file tools are disabled.':folders.map(f=>`${f.id}: ${f.available?f.path:(f.error?.message||'unavailable')}`).join(' · ')||'No folders are configured.';
  render(settings.results);
});
window.addEventListener('edith:files',event=>{render(event.detail);$('localFiles').scrollIntoView({behavior:'smooth',block:'start'});});
window.addEventListener('edith:file-action',event=>showAction(event.detail));
$('fileSearchForm').onsubmit=async event=>{
  event.preventDefault();$('fileSearchButton').disabled=true;$('fileAction').textContent='Searching filenames…';
  try{const result=await call('search_files',{query:$('fileQuery').value.trim(),folder:$('fileFolder').value,sortBy:'modifiedDesc'});render(result);$('fileAction').textContent=`${result.results.length} matching file${result.results.length===1?'':'s'}.`;}
  catch(error){$('fileAction').textContent=error.message;}
  finally{$('fileSearchButton').disabled=false;}
};

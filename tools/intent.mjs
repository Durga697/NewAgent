import {normalizeName} from './fileIndex.mjs';
export function hasActionConsent(store,session,item,action,source){
  if(source==='ui')return true;
  const state=store.state(session),text=normalizeName(session.fileUserSpeech||'');
  if(!session.fileSpeechAt||Date.now()-session.fileSpeechAt>60000)return false;
  if(!text||/\b(?:not|never|dont|don t|cancel|stop)\b/.test(text))return false;
  const choice=state.latest.indexOf(item.resultId);
  if(choice<0)return false;
  const ordinals=['first','second','third','fourth','fifth','sixth','seventh','eighth','ninth','tenth'];
  const picked=ordinals.findIndex((word,i)=>new RegExp(`\\b(?:${word}|${i+1}(?:st|nd|rd|th)?)\\b`).test(text));
  // Do not treat a quoted filename such as "find a file named open me" as permission.
  const verb=action==='open'?/^(?:(?:edith|please|can you|could you|will you|i want you to)\s+)*(?:open|launch)\b|\b(?:and|then)\s+(?:please\s+)?open\b/:/^(?:(?:edith|please|can you|could you)\s+)*(?:show|reveal)\b|\b(?:and|then)\s+(?:show|reveal)\b/;
  if(picked>=0)return picked===choice&&(verb.test(text)||/\b(?:one|file)\b/.test(text));
  if(/^(yes|yes please|sure|go ahead|open it|please do)$/.test(text)&&state.pending?.resultId===item.resultId&&state.pending.action===action)return true;
  if(!verb.test(text))return false;
  if(state.latest.length===1)return true;
  const named=state.latest.filter(id=>{
    const entry=state.entries.get(id);if(!entry)return false;
    const name=normalizeName(entry.name.replace(/\.[^.]+$/,''));return name.length>1&&text.includes(name);
  });
  return named.length===1&&named[0]===item.resultId;
}

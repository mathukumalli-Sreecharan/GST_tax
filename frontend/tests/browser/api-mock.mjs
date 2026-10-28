// Component browser tests use synthetic HTTP fixtures, never real service keys.
async function checked(response){const body=await response.json();if(!response.ok)throw new Error(body.detail||'Request failed');return body;}
export function approvalApi(path,init={}){return fetch('/api'+path,init).then(checked);}
export function parseProcessResponse(value){return value;}
export function parseReviewSession(value){return value;}
export function inspectWorkbook(file){const body=new FormData();body.append('file',file);return fetch('/api/excel/inspect',{method:'POST',body}).then(checked);}
export function processWorkbook(file,fields){const body=new FormData();body.append('file',file);for(const [key,value] of Object.entries(fields))body.append(key,String(value));return fetch('/api/excel/process',{method:'POST',body}).then(checked);}
async function download(path,filename){const response=await fetch(path);if(!response.ok)throw new Error('Download unavailable');const url=URL.createObjectURL(await response.blob());const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function downloadSavedFile(id,name){return download('/api/files/'+id+'/download',name);}
export function downloadResult(id,kind,name){return download('/api/excel/'+kind+'/'+id,name);}

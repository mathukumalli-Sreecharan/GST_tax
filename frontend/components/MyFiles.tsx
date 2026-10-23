'use client';
import Link from 'next/link';
import {useCallback,useEffect,useRef,useState} from 'react';
import {FileSpreadsheet,ArrowDownToLine,Trash2,Search,Menu} from 'lucide-react';
import {approvalApi,downloadSavedFile} from '@/lib/api';
import {formatFileSize,type FileList,type GeneratedFile} from '@/lib/files';

export function MyFiles(){
 const [data,setData]=useState<FileList|null>(null),[draft,setDraft]=useState(''),[query,setQuery]=useState(''),[sort,setSort]=useState('newest'),[offset,setOffset]=useState(0);
 const [busy,setBusy]=useState(true),[working,setWorking]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[sidebar,setSidebar]=useState(false);
 const [selected,setSelected]=useState<GeneratedFile|null>(null);
 const dialog=useRef<HTMLDialogElement>(null),generation=useRef(0);
 const load=useCallback(async()=>{
  const current=++generation.current;setBusy(true);setError('');
  try{const next=await approvalApi<FileList>(`/files?search=${encodeURIComponent(query)}&sort=${sort}&offset=${offset}`);if(current===generation.current)setData(next);}
  catch(e){if(current===generation.current){setData(null);setError(e instanceof Error?e.message:'Unable to load your files.');}}
  finally{if(current===generation.current)setBusy(false);}
 },[query,sort,offset]);
 const invalidate=useCallback(()=>{generation.current++;},[]);
 useEffect(()=>{void load();return invalidate;},[load,invalidate]);
 useEffect(()=>{if(selected)dialog.current?.showModal();else dialog.current?.close();},[selected]);
 async function download(file:GeneratedFile){setWorking(true);setError('');try{await downloadSavedFile(file.id,file.output_filename);}catch(e){setError(e instanceof Error?e.message:'Unable to download this file.');}finally{setWorking(false);}}
 async function remove(){if(!selected)return;setWorking(true);setError('');try{
  const result=await approvalApi<{queued:boolean;message?:string}>(`/files/${selected.id}`,{method:'DELETE'});
  setNotice(result.queued?result.message||'Storage deletion queued.':'File deleted.');setSelected(null);
  if(data?.files.length===1 && offset>0)setOffset(Math.max(0,offset-20));else await load();
 }catch(e){setError(e instanceof Error?e.message:'Unable to delete this file.');}finally{setWorking(false);}}
 return <div className="shell"><aside className={`sidebar ${sidebar?'open':''}`}><div className="brand"><span className="brand-mark"><FileSpreadsheet size={16}/></span><span>GST Ledger Studio</span></div><div className="nav-label">Workspace</div><nav className="nav-list"><Link className="nav-item" href="/">Dashboard</Link><Link className="nav-item active" href="/my-files">My Files</Link></nav><div className="local-note">Private beta · free access</div></aside>
 <main className="main"><header className="topbar"><div className="file-page-title"><button className="btn btn-small mobile-menu" aria-label="Open navigation" onClick={()=>setSidebar(!sidebar)}><Menu size={15}/></button><div><div className="top-title">My Files</div><div className="top-subtitle">Private generated workbook history</div></div></div><Link className="btn btn-small" href="/">Process Excel</Link></header><div className="content">
 <div className="page-head"><div><div className="eyebrow">YOUR PRIVATE WORKBOOKS</div><h1>My Files</h1><p className="subtext">Access your generated workbooks across browsers and devices.</p></div><button className="btn" disabled={busy||working} onClick={()=>void load()}>Refresh</button></div>
 <div className="inline-alert" style={{marginBottom:18}}>Generated files are retained for 30 days. You can delete them earlier. Original uploads are not stored in your history.</div>
 {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p className="success-note" role="status">{notice}</p>}
 <section className="panel"><div className="panel-head"><h2>Generated workbooks</h2><span className="subtext">{data?.total??0} files</span></div><div className="panel-body">
 <div className="toolbar files-toolbar"><form onSubmit={e=>{e.preventDefault();setOffset(0);setQuery(draft.trim());}} className="file-search"><label className="search-field"><Search size={14}/><input className="search" aria-label="Search filenames" placeholder="Search filenames" maxLength={200} value={draft} onChange={e=>setDraft(e.target.value)}/></label><button className="btn btn-small" disabled={working}>Search</button></form>
 <label className="file-sort">Sort<select className="search" aria-label="Sort files" value={sort} disabled={working} onChange={e=>{setSort(e.target.value);setOffset(0);}}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="name">Filename A–Z</option><option value="size">Largest first</option></select></label></div>
 {busy?<div className="loading" role="status"><span className="spinner"/>Loading your files…</div>:data && (data.files.length===0?<div className="empty-state"><FileSpreadsheet className="empty-icon" size={24}/><h2>{query?'No matching files':'No saved workbooks yet'}</h2><p className="subtext">{query?'Try another filename.':'Successfully processed workbooks will appear here after saving to private storage.'}</p><Link className="btn btn-primary" href="/">Process a workbook</Link></div>:<>
 <div className="data-wrap"><table className="data-table files-table"><thead><tr><th>Generated filename</th><th>Original filename</th><th>Processed</th><th>Size</th><th>Verification warnings</th><th>Expires</th><th>Actions</th></tr></thead><tbody>{data.files.map(file=><tr key={file.id}><td>{file.output_filename}</td><td>{file.original_filename}</td><td>{new Date(file.created_at).toLocaleString()}</td><td>{formatFileSize(file.file_size)}</td><td>{file.verification_count}</td><td>{new Date(file.expires_at).toLocaleDateString()}</td><td><div className="approval-actions"><button className="btn btn-small" disabled={working} aria-label={`Download ${file.output_filename}`} onClick={()=>void download(file)}><ArrowDownToLine size={13}/>Download</button><button className="btn btn-small" disabled={working} aria-label={`Delete ${file.output_filename}`} onClick={()=>{setError('');setSelected(file);}}><Trash2 size={13}/>Delete</button></div></td></tr>)}</tbody></table></div>
 <div className="pagination"><span>{offset+1}–{Math.min(offset+20,data.total)} of {data.total}</span><div className="toolbar"><button className="btn btn-small" disabled={offset===0||working} onClick={()=>setOffset(Math.max(0,offset-20))}>Previous</button><button className="btn btn-small" disabled={offset+20>=data.total||working} onClick={()=>setOffset(offset+20)}>Next</button></div></div></>)}
 </div></section></div></main>
 <dialog ref={dialog} className="approval-dialog" aria-labelledby="file-delete-title" onCancel={e=>{if(working)e.preventDefault();else setSelected(null);}}>{selected && <><h2 id="file-delete-title">Delete generated workbook?</h2><p>{selected.output_filename}</p><p className="subtext">This removes the workbook from My Files and blocks further downloads. This action cannot be undone.</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="approval-actions"><button className="btn" disabled={working} onClick={()=>setSelected(null)}>Cancel</button><button className="btn btn-primary" disabled={working} onClick={()=>void remove()}>{working?'Deleting…':'Delete file'}</button></div></>}</dialog></div>;
}

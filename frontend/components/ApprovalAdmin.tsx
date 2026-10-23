'use client';
import Link from 'next/link';
import {useCallback,useEffect,useRef,useState} from 'react';
import {approvalApi} from '@/lib/api';
import type {Applicant,ApprovalList,ApprovalStatus} from '@/lib/approvals';

type Action = 'approved'|'rejected'|'revoked';
const verbs:Record<Action,string>={approved:'Approve account',rejected:'Reject account',revoked:'Revoke access'};
export function ApprovalAdmin({overview=false}:{overview?:boolean}) {
 const [data,setData]=useState<ApprovalList|null>(null),[status,setStatus]=useState(''),[offset,setOffset]=useState(0);
 const [busy,setBusy]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [decision,setDecision]=useState<{user:Applicant;action:Action}|null>(null);
 const dialog=useRef<HTMLDialogElement>(null);
 const generation=useRef(0);
 const load=useCallback(async()=>{
  const current=++generation.current;
  setBusy(true);setError('');setData(null);
  try {
   const result=await approvalApi<ApprovalList>(`/admin/approvals?offset=${offset}${status?`&status=${status}`:''}`);
   if(current===generation.current)setData(result);
  } catch(e){if(current===generation.current)setError(e instanceof Error?e.message:'Unable to load approvals.');}
  finally{if(current===generation.current)setBusy(false);}
 },[offset,status]);
 const invalidate=useCallback(()=>{generation.current++;},[]);
 useEffect(()=>{void load();return invalidate;},[load,invalidate]);
 useEffect(()=>{if(decision)dialog.current?.showModal();else dialog.current?.close();},[decision]);
 async function decide(){
  if(!decision)return;
  setSaving(true);setError('');setNotice('');
  try {
   await approvalApi(`/admin/approvals/${decision.user.user_id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:decision.action,expected_status:decision.user.status})});
   setNotice(`${verbs[decision.action]} completed. The decision was audited and a notification queued when a verified email is available.`);
   setDecision(null);await load();
  } catch(e){setError(e instanceof Error?e.message:'Unable to save decision.');}
  finally{setSaving(false);}
 }
 return <><div className="page-head"><div><div className="eyebrow">OWNER ADMINISTRATION</div><h1>{overview?'Access overview':'User approvals'}</h1><p className="subtext">Manage verified beta access. Every decision is recorded.</p></div><button className="btn" disabled={busy||saving} onClick={()=>void load()}>Refresh</button></div>
 {error && <p role="alert" className="inline-error">{error}</p>}{notice && <p role="status" className="success-note">{notice}</p>}
 {busy && <p role="status" className="subtext">Loading approval records…</p>}
 {data && <><div className="metric-grid admin-metrics">{(['total','pending','approved','rejected','revoked'] as const).map(key=><div className="metric" key={key}><div className="metric-label">{key==='total'?'Total registered users':`${key[0].toUpperCase()}${key.slice(1)} users`}</div><div className="metric-value">{data.counts[key].toLocaleString()}</div></div>)}</div>
 <div className="inline-alert notification-summary">Notifications waiting or retrying: {data.notifications.pending}. Requiring delivery review: {data.notifications.needs_review}. Requests remain recorded regardless of email delivery.</div>
 {overview?<section className="panel panel-body"><h2>Approval queue</h2><p className="subtext">{data.counts.pending} accounts await a decision. Email verification is required before approval.</p><Link className="btn btn-primary" href="/admin/approvals">Manage approvals</Link></section>:<section className="panel"><div className="panel-head"><h2>Applicants</h2><label className="field">Status<select aria-label="Filter approval status" disabled={saving} value={status} onChange={e=>{setStatus(e.target.value);setOffset(0);}}><option value="">All statuses</option>{(['pending','approved','rejected','revoked'] as ApprovalStatus[]).map(value=><option key={value} value={value}>{value}</option>)}</select></label></div>
 <div className="data-wrap"><table className="summary-table admin-table"><thead><tr><th>Applicant</th><th>Verified email</th><th>Registered</th><th>Status</th><th>Last decision</th><th>Actions</th></tr></thead><tbody>
 {data.users.length===0?<tr><td colSpan={6}>No applicants match this filter.</td></tr>:data.users.map(user=><tr key={user.user_id}><td>{user.full_name||'Name not provided'}<small className="applicant-id">{user.user_id}</small></td><td>{user.verified_email||'Awaiting email verification'}</td><td>{new Date(user.registered_at).toLocaleString()}</td><td><span className={`status ${user.status==='approved'?'MATCHED':user.status==='pending'?'REVIEW_REQUIRED':'UNMATCHED'}`}>{user.status}</span></td><td>{user.decided_at?<><span>{new Date(user.decided_at).toLocaleString()}</span><small className="applicant-id">By {user.decided_by}</small></>:'No decision yet'}</td><td><div className="approval-actions">
 {user.is_owner?<span className="subtext">Owner · protected</span>:<>
 {user.status!=='approved' && <button className="btn btn-small" disabled={!user.verified_email||saving} onClick={()=>setDecision({user,action:'approved'})}>Approve</button>}
 {user.status==='pending' && <button className="btn btn-small" disabled={saving} onClick={()=>setDecision({user,action:'rejected'})}>Reject</button>}
 {user.status==='approved' && <button className="btn btn-small" disabled={saving} onClick={()=>setDecision({user,action:'revoked'})}>Revoke</button>}</>}
 </div></td></tr>)}
 </tbody></table></div><div className="panel-body approval-pagination"><span>{data.filtered_total===0?'0':offset+1}–{Math.min(offset+50,data.filtered_total)} of {data.filtered_total}</span><button className="btn btn-small" disabled={offset===0||saving} onClick={()=>setOffset(Math.max(0,offset-50))}>Previous</button><button className="btn btn-small" disabled={offset+50>=data.filtered_total||saving} onClick={()=>setOffset(offset+50)}>Next</button></div></section>}</>}
 <dialog ref={dialog} className="approval-dialog" aria-labelledby="approval-dialog-title" onCancel={e=>{if(saving)e.preventDefault();else setDecision(null);}}>{decision && <><h2 id="approval-dialog-title">{verbs[decision.action]}?</h2><p>{decision.user.full_name||'This applicant'} · {decision.user.verified_email||'Email not verified'}</p><p className="subtext">{decision.action==='approved'?'This permits Excel processing and downloads.':'This blocks Excel processing and all existing downloads.'} The action records your identity and the decision time.</p>{error && <p role="alert" className="inline-error">{error}</p>}<div className="approval-actions"><button className="btn" disabled={saving} onClick={()=>setDecision(null)}>Cancel</button><button className="btn btn-primary" disabled={saving} onClick={()=>void decide()}>{saving?'Saving…':verbs[decision.action]}</button></div></>}</dialog>
 </>;
}

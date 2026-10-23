'use client';
import Link from 'next/link';
import {useCallback, useEffect, useRef, useState} from 'react';
import {approvalApi} from '@/lib/api';
import type {Applicant} from '@/lib/approvals';

export function ApprovalConfirmation({userId, decision}: {userId: string; decision: 'approved'|'rejected'}) {
 const [applicant,setApplicant] = useState<Applicant|null>(null);
 const [error,setError] = useState('');
 const [notice,setNotice] = useState('');
 const [busy,setBusy] = useState(false);
 const submitting = useRef(false);
 const destination = `/approval-action?user=${encodeURIComponent(userId)}&decision=${decision}`;
 const load = useCallback(async()=> {
  const result = await approvalApi<Applicant>(`/admin/approvals/${encodeURIComponent(userId)}`);
  setApplicant(result);
 },[userId]);
 useEffect(()=> {
  const signIn = ()=>window.location.assign(`/login?next=${encodeURIComponent(destination)}`);
  window.addEventListener('auth-required',signIn);
  void load().catch(e=>setError(e instanceof Error?e.message:'Unable to load applicant.'));
  return ()=>window.removeEventListener('auth-required',signIn);
 },[load,destination]);
 async function confirm() {
  if (!applicant || applicant.is_owner || applicant.status !== 'pending' || submitting.current || notice) return;
  submitting.current=true; setBusy(true); setError('');
  try {
   await approvalApi(`/admin/approvals/${encodeURIComponent(userId)}`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({status:decision,expected_status:'pending'})
   });
   setNotice(`Account ${decision}. Your decision has been recorded in the audit log.`);
   setApplicant({...applicant,status:decision});
  } catch(e) {
   setError(e instanceof Error?e.message:'Unable to confirm decision.');
   // Require a fresh explicit review after any ambiguous response or conflict.
   setApplicant(null);
   try {await load();} catch { /* Keep confirmation disabled until reload. */ }
  } finally {submitting.current=false;setBusy(false);}
 }
 return <main className="approval-shell"><section className="panel approval-card">
  <p className="eyebrow">GST LEDGER STUDIO / OWNER ADMINISTRATION</p>
  <h1>{decision==='approved'?'Approve':'Reject'} account?</h1>
  <p className="subtext">Review this verified applicant before confirming. Opening the email link does not change account access.</p>
  {error && <p role="alert" className="inline-error">{error}</p>}
  {notice && <p role="status" className="success-note">{notice}</p>}
  {!applicant && !error && <p role="status">Loading applicant details...</p>}
  {applicant && <><dl style={{overflowWrap:'anywhere'}}>
   <dt>Name</dt><dd>{applicant.full_name||'Name not provided'}</dd>
   <dt>Verified email</dt><dd>{applicant.verified_email||'Email not verified'}</dd>
   <dt>Registered</dt><dd>{new Date(applicant.registered_at).toLocaleString()}</dd>
   <dt>Current status</dt><dd>{applicant.status}</dd>
  </dl>
  {applicant.status!=='pending' && !notice && <p role="status">This account is already {applicant.status}. This request can no longer be confirmed from this email. Review any further changes in the dashboard.</p>}
  {applicant.is_owner && <p role="alert">The owner account is protected.</p>}
  {applicant.status==='pending' && !applicant.is_owner && <button className="btn btn-primary" disabled={busy||!applicant.verified_email||Boolean(notice)} onClick={()=>void confirm()}>
   {busy?'Saving...':`Confirm ${decision==='approved'?'approval':'rejection'}`}
  </button>}</>}
  <p><Link className="btn" href="/admin/approvals">Return to Admin Approval Dashboard</Link></p>
 </section></main>;
}

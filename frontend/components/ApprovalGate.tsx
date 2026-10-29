'use client';
import {useCallback,useEffect,useState,type ReactNode} from 'react';
import {approvalApi} from '@/lib/api';
import {approvalMessage,canUseWorkspace,type ApprovalState} from '@/lib/approvals';

export function ApprovalGate({initial,error:initialError,children}:{initial:ApprovalState|null;error:string;children:ReactNode}) {
 const [state,setState]=useState(initial),[error,setError]=useState(initialError),[busy,setBusy]=useState(false);
 const refresh=useCallback(async()=>{
  setBusy(true);
  try {setState(await approvalApi<ApprovalState>('/account/approval'));setError('');}
  // A failed network/auth check is not an approval decision. Keep the last
  // server-confirmed status so a brief outage cannot lock an approved user out.
  catch(e){setError(e instanceof Error?e.message:'Unable to check approval.');}
  finally {setBusy(false);}
 },[]);
 useEffect(()=>{
  const check=()=>{void refresh();};
  const timer=setInterval(check,30000);
  window.addEventListener('approval-required',check);
  window.addEventListener('focus',check);
  return ()=>{clearInterval(timer);window.removeEventListener('approval-required',check);window.removeEventListener('focus',check);};
 },[refresh]);
 if(state && canUseWorkspace(state)) return <>{error&&<div className="approval-refresh-notice" role="status"><span>{error} Your approved workspace remains available.</span><button className="btn btn-small" disabled={busy} onClick={()=>void refresh()}>{busy?'Checking…':'Retry access check'}</button></div>}{children}</>;
 const title=error?'Account access unavailable':state?.status==='rejected'?'Access request rejected':state?.status==='revoked'?'Access revoked':!state?.email_verified?'Email verification required':'Pending approval';
 return <main className="approval-shell"><section className="panel approval-card"><div className="eyebrow">GST LEDGER STUDIO · BETA ACCESS</div><h1>{title}</h1>
 <p role={error?'alert':'status'} className="subtext">{error || (state?approvalMessage(state):'Checking your account access.')}</p>
 <p className="subtext">Your account remains available for sign-in and password recovery. Excel processing and downloads require administrator approval.</p>
 <button className="btn btn-primary" disabled={busy} onClick={()=>void refresh()}>{busy?'Checking…':'Check approval status'}</button></section></main>;
}

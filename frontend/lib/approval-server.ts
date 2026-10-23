import 'server-only';
import {serverClient} from '@/lib/supabase/server';
import type {ApprovalState} from '@/lib/approvals';

export async function serverApproval(): Promise<{state: ApprovalState | null; forbidden: boolean; error: string}> {
 const client = await serverClient();
 // Token is passed only to FastAPI, which validates it independently.
 const {data: {session}} = await client.auth.getSession();
 if (!session) return {state:null,forbidden:true,error:'Sign in again to check account access.'};
 try {
  const base = (process.env.API_INTERNAL_BASE ?? process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8000').replace(/\/+$/, '');
  const response = await fetch(`${base}/api/account/approval`, {headers:{Authorization:`Bearer ${session.access_token}`},cache:'no-store',signal:AbortSignal.timeout(12000)});
  if (!response.ok) return {state:null,forbidden:response.status===401||response.status===403,error:response.status===503?'Approval service is unavailable or owner setup is incomplete. Please try again shortly.':'Unable to verify account access. Please sign in again.'};
  return {state:await response.json() as ApprovalState,forbidden:false,error:''};
 } catch {return {state:null,forbidden:false,error:'Unable to reach the approval service. Please try again shortly.'};}
}

import { serverClient } from '@/lib/supabase/server';
import Workspace from '@/components/Workspace';
import { Account } from '@/components/Account';
import {serverApproval} from '@/lib/approval-server';
import {ApprovalGate} from '@/components/ApprovalGate';
import {canManageApprovals,canUseWorkspace} from '@/lib/approvals';
import Link from 'next/link';
import {FileSpreadsheet,ArrowRight} from 'lucide-react';
export const dynamic = 'force-dynamic';
export default async function Page() {
 const {data:{user}} = await (await serverClient()).auth.getUser();
 if (!user) return <main className="auth-shell"><aside className="auth-brand"><FileSpreadsheet size={44} strokeWidth={1}/><p>GST LEDGER STUDIO</p><h2>Precision in every ledger.</h2><p>A considered workspace for GST review and Excel automation.</p><small>FINANCIAL DATA AUTOMATION</small></aside><section className="auth-panel"><div className="auth-form"><p className="auth-eyebrow">YOUR SECURE WORKSPACE</p><h1>Welcome to GST Ledger Studio</h1><p>Choose an option to continue.</p><div className="auth-choices"><Link className="auth-choice" href="/login"><span><strong>Existing user</strong><small>Sign in to your account</small></span><ArrowRight size={18}/></Link><Link className="auth-choice" href="/register"><span><strong>New user</strong><small>Create an account</small></span><ArrowRight size={18}/></Link></div></div></section></main>;
 const approval=await serverApproval();
 return <><Account userId={user.id} email={user.email ?? ''} name={user.user_metadata.full_name ?? ''} isAdmin={!!approval.state && canManageApprovals(approval.state)} showFiles={!!approval.state && canUseWorkspace(approval.state)} /><ApprovalGate initial={approval.state} error={approval.error}><Workspace /></ApprovalGate></>;
}

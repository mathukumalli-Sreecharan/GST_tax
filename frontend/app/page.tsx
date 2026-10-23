import { redirect } from 'next/navigation';
import { serverClient } from '@/lib/supabase/server';
import Workspace from '@/components/Workspace';
import { Account } from '@/components/Account';
import {serverApproval} from '@/lib/approval-server';
import {ApprovalGate} from '@/components/ApprovalGate';
import {canManageApprovals,canUseWorkspace} from '@/lib/approvals';
export const dynamic = 'force-dynamic';
export default async function Page() {
 const {data:{user}} = await (await serverClient()).auth.getUser();
 if (!user) redirect('/login');
 const approval=await serverApproval();
 return <><Account userId={user.id} email={user.email ?? ''} name={user.user_metadata.full_name ?? ''} isAdmin={!!approval.state && canManageApprovals(approval.state)} showFiles={!!approval.state && canUseWorkspace(approval.state)} /><ApprovalGate initial={approval.state} error={approval.error}><Workspace /></ApprovalGate></>;
}

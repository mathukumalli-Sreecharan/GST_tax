import {redirect} from 'next/navigation';
import {serverClient} from '@/lib/supabase/server';
import {serverApproval} from '@/lib/approval-server';
import {canManageApprovals,canUseWorkspace} from '@/lib/approvals';
import {ApprovalGate} from '@/components/ApprovalGate';
import {Account} from '@/components/Account';
import {MyFiles} from '@/components/MyFiles';
export const dynamic='force-dynamic';
export default async function MyFilesPage(){
 const {data:{user}}=await (await serverClient()).auth.getUser();
 if(!user)redirect('/login?next=/my-files');
 const approval=await serverApproval();
 return <><Account userId={user.id} email={user.email??''} name={user.user_metadata.full_name??''} isAdmin={!!approval.state&&canManageApprovals(approval.state)} showFiles={!!approval.state&&canUseWorkspace(approval.state)}/><ApprovalGate initial={approval.state} error={approval.error}><MyFiles/></ApprovalGate></>;
}

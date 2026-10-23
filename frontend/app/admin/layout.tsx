import Link from 'next/link';
import {notFound,redirect} from 'next/navigation';
import {serverClient} from '@/lib/supabase/server';
import {serverApproval} from '@/lib/approval-server';
import {canManageApprovals} from '@/lib/approvals';
import {Account} from '@/components/Account';
export const dynamic='force-dynamic';
export default async function AdminLayout({children}:{children:React.ReactNode}) {
 const {data:{user}}=await (await serverClient()).auth.getUser();
 if(!user) redirect('/login?next=/admin');
 const approval=await serverApproval();
 if(approval.forbidden || (approval.state && !canManageApprovals(approval.state))) notFound();
 if(!approval.state) return <main className="approval-shell"><section className="panel approval-card"><h1>Administration unavailable</h1><p role="alert">{approval.error}</p><Link className="btn" href="/">Return to workspace</Link></section></main>;
 return <><Account userId={user.id} email={user.email??''} name={user.user_metadata.full_name??''} isAdmin showFiles/>
 <main className="admin-shell"><nav className="admin-nav"><Link href="/">GST Ledger Studio</Link><Link href="/admin">Overview</Link><Link href="/admin/approvals">User approvals</Link></nav>{children}</main></>;
}

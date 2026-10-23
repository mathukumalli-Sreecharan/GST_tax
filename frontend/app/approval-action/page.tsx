import Link from 'next/link';
import {notFound, redirect} from 'next/navigation';
import {serverClient} from '@/lib/supabase/server';
import {serverApproval} from '@/lib/approval-server';
import {canManageApprovals} from '@/lib/approvals';
import {ApprovalConfirmation} from '@/components/ApprovalConfirmation';
export const dynamic = 'force-dynamic';

export default async function ApprovalActionPage({searchParams}: {
 searchParams: Promise<{user?: string; decision?: string}>;
}) {
 const params = await searchParams;
 const user = params.user ?? '';
 const decision = params.decision;
 if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user) ||
     (decision !== 'approved' && decision !== 'rejected')) notFound();
 const destination = `/approval-action?user=${encodeURIComponent(user)}&decision=${decision}`;
 const {data:{user:actor}} = await (await serverClient()).auth.getUser();
 if (!actor) redirect(`/login?next=${encodeURIComponent(destination)}`);
 const approval = await serverApproval();
 if (approval.forbidden) redirect(`/login?next=${encodeURIComponent(destination)}`);
 if (approval.state && !canManageApprovals(approval.state)) notFound();
 if (!approval.state) return <main className="approval-shell"><section className="panel approval-card"><h1>Administration unavailable</h1><p role="alert">{approval.error}</p><Link href={destination}>Try again</Link></section></main>;
 return <ApprovalConfirmation userId={user} decision={decision}/>;
}

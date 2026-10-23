import { redirect } from 'next/navigation';
import { serverClient } from '@/lib/supabase/server';
import Workspace from '@/components/Workspace';
import { Account } from '@/components/Account';
export const dynamic = 'force-dynamic';
export default async function Page() {
 const {data:{user}} = await (await serverClient()).auth.getUser();
 if (!user) redirect('/login');
 return <><Account userId={user.id} email={user.email ?? ''} name={user.user_metadata.full_name ?? ''} /><Workspace /></>;
}

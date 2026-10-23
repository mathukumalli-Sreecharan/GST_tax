import { AuthForm } from '@/components/AuthForm';
import { serverClient } from '@/lib/supabase/server';
import Link from 'next/link';
export const dynamic = 'force-dynamic';
export default async function Page() {
 const {data:{user}} = await (await serverClient()).auth.getUser();
 if(!user) return <div className="auth-form"><h1>Request a new link</h1><p>Your reset session is missing or expired.</p><Link href="/forgot-password">Request password reset</Link></div>;
 return <AuthForm mode="reset-password"/>;
}

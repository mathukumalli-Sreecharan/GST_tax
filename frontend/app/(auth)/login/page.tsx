import { AuthForm } from '@/components/AuthForm';
export default async function Page({searchParams}:{searchParams:Promise<{error?:string}>}) {
 const params=await searchParams;
 return <div>{params.error && <p role="alert">This email link is invalid or expired. Request a new link.</p>}<AuthForm mode="login"/></div>;
}

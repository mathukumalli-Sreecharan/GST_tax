"use client";
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { browserClient } from '@/lib/supabase/browser';
import { safeDestination } from '@/lib/auth';
export type AuthMode = 'login' | 'register' | 'forgot-password' | 'reset-password';
const titles = {login:'Welcome back',register:'Create your account','forgot-password':'Reset your password','reset-password':'Choose a new password'};
export function AuthForm({mode, onSignedIn}:{mode:AuthMode; onSignedIn?:()=>void}) {
 const [busy,setBusy]=useState(false), [error,setError]=useState(''), [message,setMessage]=useState(''), [show,setShow]=useState(false);
 async function submit(event:FormEvent<HTMLFormElement>) {
  event.preventDefault(); setBusy(true); setError('');
  const form = new FormData(event.currentTarget), email = String(form.get('email') ?? '').trim(), password = String(form.get('password') ?? '');
  try {
   const client = browserClient();
   if (mode === 'register' || mode === 'reset-password') {
    if (password.length < 12) throw new Error('Use at least 12 characters.');
    if (password !== form.get('confirm')) throw new Error('Passwords do not match.');
   }
   if(mode==='login') {
    const {error}=await client.auth.signInWithPassword({email,password});
    if(error) throw new Error('Unable to sign in. Check your credentials and verify your email.');
    if(onSignedIn) { onSignedIn(); return; }
    window.location.assign(safeDestination(new URLSearchParams(window.location.search).get('next')));
   } else if(mode==='register') {
    const {error}=await client.auth.signUp({email,password,options:{data:{full_name:String(form.get('name')).trim()},emailRedirectTo:window.location.origin+'/auth/callback'}});
    if(error) throw new Error('Unable to register. Check your details or try again later.');
    setMessage('Check your email for a verification link before signing in. If you already have an account, sign in or reset your password.');
   } else if(mode==='forgot-password') {
    await client.auth.resetPasswordForEmail(email,{redirectTo:window.location.origin+'/auth/callback?flow=recovery'});
    setMessage('If an account is eligible, a password reset link will arrive by email. Open it in this browser.');
   } else {
    const {data:{user},error:validation}=await client.auth.getUser();
    if(validation || !user) throw new Error('This reset link has expired. Request a new link.');
    const {error}=await client.auth.updateUser({password});
    if(error) throw new Error('Unable to update your password. Request a new link and try again.');
    await client.auth.signOut();
    window.location.assign('/login');
   }
  } catch(e) {setError(e instanceof Error ? e.message : 'Please try again.');} finally {setBusy(false);}
 }
 return <section className="auth-form-card"><div className="auth-form"><p className="auth-panel-eyebrow">{mode==='login'?'EXISTING ACCOUNT':mode==='register'?'NEW ACCOUNT':mode==='forgot-password'?'ACCOUNT RECOVERY':'SECURE PASSWORD UPDATE'}</p><h2>{titles[mode]}</h2><p className="auth-form-intro">{mode==='login'?'Sign in to continue to your GST workspace.':mode==='register'?'Create a secure account to begin.':mode==='forgot-password'?'We’ll send a secure link if your account is eligible.':'Choose a new password for your account.'}</p>
 {message ? <div role="status" className="auth-success"><p>{message}</p><Link className="auth-inline-link" href="/login">Return to sign in</Link></div> : <form onSubmit={submit}>
 {mode==='register' && <label>Full name<input name="name" autoComplete="name" required maxLength={120}/></label>}
 {mode!=='reset-password' && <label>Email address<input name="email" type="email" autoComplete="email" required maxLength={254}/></label>}
 {mode!=='forgot-password' && <><label>Password<input name="password" type={show?'text':'password'} autoComplete={mode==='login'?'current-password':'new-password'} minLength={mode==='login'?1:12} maxLength={256} required/></label><button className="auth-text" type="button" aria-pressed={show} onClick={()=>setShow(!show)}>{show?'Hide':'Show'} password</button></>}
 {(mode==='register'||mode==='reset-password') && <label>Confirm password<input name="confirm" type={show?'text':'password'} autoComplete="new-password" required minLength={12} maxLength={256}/></label>}
 {error && <p role="alert" className="auth-error">{error}</p>}
 <button className="auth-submit" disabled={busy}>{busy?'Please wait…':mode==='login'?'Sign in':mode==='register'?'Create account':mode==='forgot-password'?'Send reset link':'Update password'}</button>
 </form>}
 <nav className="auth-form-links"><Link className="auth-back-link" href="/">← Back to account selection</Link>{mode==='login'&&<><Link href="/forgot-password">Forgot password?</Link><Link href="/register">Create an account</Link></>}{mode==='register'&&<Link href="/login">Already have an account? Sign in</Link>}{mode==='forgot-password'&&<Link href="/login">Return to sign in</Link>}{mode==='reset-password'&&<Link href="/login">Return to sign in</Link>}</nav></div></section>;
}

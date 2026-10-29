"use client";
import {useEffect,useState,useRef} from 'react';
import {browserClient} from '@/lib/supabase/browser';
import {AuthForm} from './AuthForm';
import Link from 'next/link';
import {ChevronDown,ShieldCheck} from 'lucide-react';
export function Account({email,name,userId,isAdmin=false,showFiles=false}:{email:string;name:string;userId:string;isAdmin?:boolean;showFiles?:boolean}) {
 const dialog = useRef<HTMLDialogElement>(null);
 const [expired,setExpired]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  const expire=()=>setExpired(true);
  window.addEventListener('auth-required',expire);
  const {data:{subscription}}=browserClient().auth.onAuthStateChange((event)=>{if(event==='SIGNED_OUT') setExpired(true);});
  return ()=>{window.removeEventListener('auth-required',expire);subscription.unsubscribe();};
 },[]);
 useEffect(()=>{if(expired) dialog.current?.showModal();else dialog.current?.close();},[expired]);
 async function resume(){
  const {data:{user}}=await browserClient().auth.getUser();
  if(user?.id!==userId) {window.location.assign('/');return;}
  setExpired(false);
 }
 async function logout(){const {error}=await browserClient().auth.signOut();if(error)setError('Unable to sign out. Try again.');else window.location.assign('/login');}
 const initials=(name||email).trim().split(/\s+/).filter(Boolean).slice(0,2).map(part=>part[0]).join('').toUpperCase();
 return <><details className="account-menu"><summary className="account-trigger" aria-label="Open account menu"><span className="account-avatar">{initials}</span><span className="account-label"><strong title={name||email}>{name||email}</strong><small>{isAdmin?'Administrator':'Standard User'}</small></span><ChevronDown className="account-chevron" size={15}/></summary><div className="account-dropdown"><div className="account-email"><ShieldCheck size={15}/><span>{email}</span></div>{showFiles&&<Link href="/my-files">My Files</Link>}{isAdmin&&<Link href="/admin">Administration</Link>}<button className="account-signout" onClick={logout}>Sign out</button>{error&&<span role="alert">{error}</span>}</div></details><dialog ref={dialog} className="auth-modal" aria-label="Session expired" onCancel={e=>e.preventDefault()}><div><p>Your session ended. Sign in to continue with your selected workbook.</p><AuthForm mode="login" onSignedIn={resume}/></div></dialog></>;
}

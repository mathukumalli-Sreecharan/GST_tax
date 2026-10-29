import Link from 'next/link';
import {ArrowRight,LogIn,ShieldCheck,UserRoundPlus} from 'lucide-react';

export function AuthChoices() {
 return <section className="auth-choice-panel" id="account-options" aria-labelledby="auth-choice-title">
  <p className="auth-panel-eyebrow">GET STARTED</p><h2 id="auth-choice-title">How would you like to continue?</h2>
  <div className="auth-choice-list">
   <Link className="auth-choice-card auth-choice-existing" href="/login"><span className="auth-choice-icon"><LogIn size={19}/></span><span className="auth-choice-copy"><strong>Welcome Back</strong><small>Continue to your GST workspace.</small></span><span className="auth-choice-action">Sign In <ArrowRight size={15}/></span></Link>
   <Link className="auth-choice-card auth-choice-new" href="/register"><span className="auth-choice-icon"><UserRoundPlus size={19}/></span><span className="auth-choice-copy"><strong>Get Started</strong><small>Create your account and start processing GST workbooks.</small></span><span className="auth-choice-action">Create Account <ArrowRight size={15}/></span></Link>
  </div>
  <p className="auth-choice-note"><ShieldCheck size={14}/> Secure sign-in and email verification are handled by your account.</p>
 </section>;
}

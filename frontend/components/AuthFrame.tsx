import Link from 'next/link';
import {ArrowDownRight,Check,FileSpreadsheet,ShieldCheck} from 'lucide-react';

export function AuthFrame({children}:{children:React.ReactNode}) {
 return <main className="auth-experience">
  <div className="auth-orb auth-orb-coral"/><div className="auth-orb auth-orb-cyan"/><div className="auth-orb auth-orb-violet"/>
  <header className="auth-topbar">
   <Link className="auth-wordmark" href="/" aria-label="GST Ledger Studio home"><span className="auth-logo"><FileSpreadsheet size={19}/></span><span>GST Ledger <b>Studio</b></span></Link>
   <div className="auth-header-note"><ShieldCheck size={15}/> PRIVATE FINANCIAL WORKSPACE</div>
  </header>
  <section className="auth-hero">
   <div className="auth-hero-copy">
    <p className="auth-eyebrow">CLEAR BOOKS. CONFIDENT DECISIONS.</p>
    <h1>GST reconciliation,<br/><span>reimagined.</span></h1>
    <p className="auth-hero-description">Review, reconcile, and process your GST workbooks with clarity and confidence.</p>
    <div className="auth-trust-points"><span><Check size={14}/> Careful workbook review</span><span><Check size={14}/> Your decisions stay yours</span></div>
    <div className="auth-ledger-preview" aria-label="Illustrative workbook review preview">
     <div className="auth-preview-head"><span className="auth-preview-icon"><FileSpreadsheet size={16}/></span><span><b>Workbook review</b><small>Illustrative preview</small></span><span className="auth-preview-dot"/></div>
     <div className="auth-preview-grid"><span>INVOICE</span><span>TAXABLE</span><span>STATUS</span><b>INV-2048</b><b>₹ 42,500</b><em>Matched</em><b>INV-2049</b><b>₹ 18,200</b><i>Review</i></div>
     <div className="auth-preview-foot"><span>Review each transaction with care</span><ArrowDownRight size={15}/></div>
    </div>
   </div>
   <div className="auth-content">{children}</div>
  </section>
  <footer className="auth-footer"><span>GST LEDGER STUDIO</span><span>Thoughtful tools for accurate work.</span></footer>
 </main>;
}

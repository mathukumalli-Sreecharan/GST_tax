import { FileSpreadsheet } from 'lucide-react';
export default function AuthLayout({children}:{children:React.ReactNode}) {
 return <main className="auth-shell"><aside className="auth-brand"><FileSpreadsheet size={44} strokeWidth={1}/><p>GST LEDGER STUDIO</p><h2>Precision in every ledger.</h2><p>A considered workspace for GST review and Excel automation.</p><small>FINANCIAL DATA AUTOMATION</small></aside><section className="auth-panel">{children}</section></main>;
}

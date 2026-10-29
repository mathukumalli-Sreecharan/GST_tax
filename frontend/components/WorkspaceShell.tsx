'use client';
import {useState,type ReactNode} from 'react';
import Link from 'next/link';
import {BarChart3,FileSpreadsheet,FileWarning,Gauge,Menu,Settings2,ShieldCheck} from 'lucide-react';

export type WorkspaceNav='Dashboard'|'Process Excel'|'Verification'|'Settings'|'My Files';
const items=[
 {name:'Dashboard' as const,icon:Gauge,href:'/?page=Dashboard'},
 {name:'Process Excel' as const,icon:FileSpreadsheet,href:'/?page=Process%20Excel'},
 {name:'Verification' as const,icon:FileWarning,href:'/?page=Verification'},
 {name:'Settings' as const,icon:Settings2,href:'/?page=Settings'},
 {name:'My Files' as const,icon:FileSpreadsheet,href:'/my-files'},
];
export function WorkspaceShell({active,subtitle,children,accountActions,headerExtra,onNavigate}:{active:WorkspaceNav;subtitle:string;children:ReactNode;accountActions?:ReactNode;headerExtra?:ReactNode;onNavigate?:(page:WorkspaceNav)=>void}){
 const [mobileOpen,setMobileOpen]=useState(false);
 return <div className="app-shell">
  {mobileOpen&&<button className="nav-scrim" aria-label="Close navigation" onClick={()=>setMobileOpen(false)}/>}
  <aside className={`app-sidebar ${mobileOpen?'open':''}`}>
   <Link className="app-brand" href="/" onClick={()=>setMobileOpen(false)}><span className="app-brand-mark"><BarChart3 size={18}/></span><span>GST Ledger <b>Studio</b></span></Link>
   <p className="app-nav-caption">WORKSPACE</p><nav className="app-nav" aria-label="Main navigation">{items.map(({name,icon:Icon,href})=>{
    const content=<><Icon size={17} strokeWidth={1.8}/><span>{name}</span>{name==='My Files'&&<span className="nav-arrow">↗</span>}</>;
    return onNavigate&&name!=='My Files'?<button type="button" key={name} aria-current={active===name?'page':undefined} className={`app-nav-item ${active===name?'active':''}`} onClick={()=>{onNavigate(name);setMobileOpen(false);}}>{content}</button>:<Link key={name} aria-current={active===name?'page':undefined} className={`app-nav-item ${active===name?'active':''}`} href={href} onClick={()=>setMobileOpen(false)}>{content}</Link>;
   })}</nav>
   <div className="sidebar-security"><span><ShieldCheck size={16}/></span><div><b>Private workspace</b><small>Your files stay protected</small></div></div>
   <div className="sidebar-foot">GST LEDGER STUDIO <span>FINANCIAL WORKFLOW</span></div>
  </aside>
  <main className="app-main">
   <header className="app-topbar"><div className="topbar-context"><button className="btn icon-button mobile-menu" aria-label="Open navigation" aria-expanded={mobileOpen} onClick={()=>setMobileOpen(true)}><Menu size={17}/></button><div className="topbar-heading"><span className="topbar-kicker">{active.toUpperCase()} · GST LEDGER STUDIO</span><h1>Workspace</h1><p>{subtitle}</p></div></div><div className="topbar-tools">{headerExtra}{accountActions}</div></header>
   <div className="app-content">{children}</div>
  </main>
 </div>;
}

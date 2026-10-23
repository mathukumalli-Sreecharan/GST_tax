'use client';
export default function ErrorState({reset}:{reset:()=>void}){return <section className="panel approval-card"><h1>Administration unavailable</h1><p role="alert">Unable to load account administration.</p><button className="btn" onClick={reset}>Try again</button></section>;}

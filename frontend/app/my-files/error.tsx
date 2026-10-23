'use client';
export default function FileError({reset}:{reset:()=>void}){return <main className="approval-shell"><section className="panel approval-card"><h1>My Files is unavailable</h1><p role="alert">Unable to load private file history. Please try again.</p><button className="btn" onClick={reset}>Retry</button></section></main>;}

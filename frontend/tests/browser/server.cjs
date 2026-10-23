const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const esbuild=require('esbuild');
async function main(){
 const mocks={
  '@/lib/api':path.resolve('tests/browser/api-mock.mjs'),
  '@/lib/supabase/browser':path.resolve('tests/browser/auth-mock.mjs'),
  'next/link':path.resolve('tests/browser/link-mock.jsx')
 };
 await esbuild.build({entryPoints:['tests/browser/harness.jsx'],bundle:true,outfile:'.beta-browser/app.js',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'test-only-adapters',setup(build){build.onResolve({filter:/^(?:@\/lib\/(?:api|supabase\/browser)|next\/link)$/},args=>({path:mocks[args.path]}));}}]});
 const css=fs.readFileSync('app/globals.css','utf8').replace('@import "tailwindcss";','');
 const server=http.createServer((req,res)=>{
  if(req.url==='/__shutdown'){res.end('bye');setTimeout(()=>{server.close();process.exit(0);},50);return;}
  if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync('.beta-browser/app.js'));return;}
  if(req.url==='/app.css'){res.setHeader('Content-Type','text/css');res.end(css);return;}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
 });
 server.listen(3199,'127.0.0.1');
}
main().catch(()=>{process.exitCode=1;});

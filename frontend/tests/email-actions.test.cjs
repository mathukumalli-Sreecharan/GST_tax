const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
function load(file,modules={},globals={}){
 const exports={};
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(code,{exports,URL,process:{env:{}},require:name=>name in modules?modules[name]:require(name),...globals});return exports;
}
const userId='22222222-2222-4222-8222-222222222222';
const user={user_id:userId,status:'pending',full_name:'Applicant',verified_email:'applicant@example.com',registered_at:'2026-10-24T10:00:00Z',is_owner:false};
function find(node,predicate){
 if(!node||typeof node!=='object')return null;
 if(predicate(node))return node;
 for(const child of [].concat(node.props?.children??[])){const result=find(child,predicate);if(result)return result;}
 return null;
}

test('confirmation page preserves safe login destination and rejects non-owner or invalid links',async()=>{
 let actor=null;
 let state={ready:true,status:'approved',email_verified:true,is_admin:true};
 let mutation=0;
 const rules=load('lib/approvals.ts');
 const Page=load('app/approval-action/page.tsx',{
  '@/lib/supabase/server':{serverClient:async()=>({auth:{getUser:async()=>({data:{user:actor}})}})},
  '@/lib/approval-server':{serverApproval:async()=>({state,forbidden:false,error:''})},
  '@/lib/approvals':rules,'@/components/ApprovalConfirmation':{ApprovalConfirmation:()=>{mutation++;return null;}},
  'next/link':{default:()=>null},'next/navigation':{notFound:()=>{throw Error('NOT_FOUND');},redirect:to=>{throw Error(to);}}
 }).default;
 const params={searchParams:Promise.resolve({user:userId,decision:'approved'})};
 await assert.rejects(()=>Page(params),e=>e.message===`/login?next=${encodeURIComponent(`/approval-action?user=${userId}&decision=approved`)}`);
 actor={id:'regular'};state={...state,is_admin:false};
 await assert.rejects(()=>Page(params),/NOT_FOUND/);
 actor={id:'owner'};state={...state,is_admin:true};
 assert.ok(await Page(params));assert.equal(mutation,0); // GET renders controls; no decision execution.
 await assert.rejects(()=>Page({searchParams:Promise.resolve({user:'https://evil.example',decision:'approved'})}),/NOT_FOUND/);
 const {safeDestination}=load('lib/auth.ts');
 assert.equal(safeDestination(`/approval-action?user=${userId}&decision=rejected`),`/approval-action?user=${userId}&decision=rejected`);
});

function harness({decision='approved',status='pending',conflict=false}={}){
 const slots=[],effects=[],calls=[],listeners={};let index=0,initial=true,redirect='';
 let current={...user,status};
 const react={
  useState:value=>{const i=index++;if(!(i in slots))slots[i]=value;return [slots[i],value=>{slots[i]=value;}];},
  useRef:value=>{const i=index++;return slots[i]??(slots[i]={current:value});},
  useCallback:fn=>fn,
  useEffect:fn=>{if(initial)effects.push(fn);}
 };
 const Component=load('components/ApprovalConfirmation.tsx',{
  react,'next/link':{default:()=>null},'@/lib/api':{approvalApi:async(path,init)=>{
   calls.push({path,init});
   if(init?.method==='POST'){
    if(conflict){current={...current,status:'rejected'};throw Error('Approval changed. Refresh and try again.');}
    current={...current,status:decision};return current;
   }
   return current;
  }}
 },{window:{addEventListener:(name,fn)=>{listeners[name]=fn;},removeEventListener(){},location:{assign:to=>{redirect=to;}}}}).ApprovalConfirmation;
 return {calls,listeners,redirect:()=>redirect,
  render(){index=0;const tree=Component({userId,decision});initial=false;return tree;},
  async mount(){this.render();effects.forEach(fn=>fn());await new Promise(setImmediate);return this.render();}
 };
}
for(const decision of ['approved','rejected'])test(`email ${decision} requires explicit confirmation and blocks duplicate clicks`,async()=>{
 const h=harness({decision});const tree=await h.mount();
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].init,undefined);
 const button=find(tree,node=>node.type==='button');assert.ok(button);
 const first=button.props.onClick();const second=button.props.onClick();
 await Promise.all([first,second]);await new Promise(setImmediate);
 const posts=h.calls.filter(call=>call.init?.method==='POST');
 assert.equal(posts.length,1);
 assert.deepEqual(JSON.parse(posts[0].init.body),{status:decision,expected_status:'pending'});
 assert.equal(find(h.render(),node=>node.type==='button'),null);
});
for(const status of ['approved','rejected','revoked'])test(`old email cannot change an already ${status} applicant`,async()=>{
 const h=harness({status});const tree=await h.mount();
 assert.equal(find(tree,node=>node.type==='button'),null);
 assert.equal(h.calls.filter(call=>call.init?.method==='POST').length,0);
});
test('conflicting confirmation reloads status; session expiry resumes the same action after login',async()=>{
 const h=harness({conflict:true});let tree=await h.mount();
 find(tree,node=>node.type==='button').props.onClick();await new Promise(setImmediate);
 tree=h.render();assert.equal(find(tree,node=>node.type==='button'),null);
 assert.equal(h.calls.filter(call=>call.init?.method==='POST').length,1);
 h.listeners['auth-required']();
 assert.equal(h.redirect(),`/login?next=${encodeURIComponent(`/approval-action?user=${userId}&decision=approved`)}`);
});

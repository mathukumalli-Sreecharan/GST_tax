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
test('workspace access requires approval and verified email; admin flag alone never permits workspace',()=>{
 const {canUseWorkspace,canManageApprovals,approvalMessage}=load('lib/approvals.ts');
 for(const status of ['pending','rejected','revoked']){
  const state={ready:true,status,email_verified:true,is_admin:true};
  assert.equal(canUseWorkspace(state),false);assert.equal(canManageApprovals(state),false);
 }
 const state={ready:true,status:'approved',email_verified:true,is_admin:false};
 assert.equal(canUseWorkspace(state),true);assert.equal(canManageApprovals(state),false);
 assert.equal(canUseWorkspace({...state,email_verified:false}),false);
 assert.equal(canUseWorkspace({...state,ready:false}),false);
 assert.equal(canManageApprovals({...state,is_admin:true}),true);
 assert.equal(approvalMessage({...state,status:'pending'}),'Your account is awaiting administrator approval.');
});
test('admin server layout rejects regular users and unauthenticated users before rendering controls',async()=>{
 const rules=load('lib/approvals.ts');
 let user={id:'regular',email:'regular@example.com',user_metadata:{role:'admin'}};
 let state={ready:true,status:'approved',email_verified:true,is_admin:false};
 const {default:Layout}=load('app/admin/layout.tsx',{
  '@/lib/supabase/server':{serverClient:async()=>({auth:{getUser:async()=>({data:{user}})}})},
  '@/lib/approval-server':{serverApproval:async()=>({state,forbidden:false,error:''})},
  '@/lib/approvals':rules,'@/components/Account':{Account:()=>null},'next/link':{default:()=>null},
  'next/navigation':{notFound:()=>{throw new Error('NOT_FOUND');},redirect:()=>{throw new Error('REDIRECT_LOGIN');}}
 });
 await assert.rejects(()=>Layout({children:'Admin controls'}),/NOT_FOUND/);
 user=null;await assert.rejects(()=>Layout({children:'Admin controls'}),/REDIRECT_LOGIN/);
 user={id:'owner',email:'owner@example.com',user_metadata:{}};state={...state,is_admin:true};
 assert.ok(await Layout({children:'Admin controls'}));
});
test('public registration requests email verification and never supplies approval privileges',async()=>{
 let submitted, message='';
 const fields={name:'New Applicant',email:'applicant@example.com',password:'a-long-password',confirm:'a-long-password'};
 const {AuthForm}=load('components/AuthForm.tsx',{
  react:{useState:value=>[value,next=>{if(typeof next==='string')message=next;}]},
  '@/lib/supabase/browser':{browserClient:()=>({auth:{signUp:async input=>{submitted=input;return {error:null};}}})},
  '@/lib/auth':{safeDestination:()=> '/'},'next/link':{default:()=>null}
 },{window:{location:{origin:'https://gst.example.com'}},FormData:class{get(key){return fields[key];}}});
 const tree=AuthForm({mode:'register'});
 function find(node){if(!node||typeof node!=='object')return null;if(node.type==='form')return node;for(const child of [].concat(node.props?.children??[])){const found=find(child);if(found)return found;}return null;}
 await find(tree).props.onSubmit({preventDefault(){},currentTarget:{}});
 assert.equal(submitted.options.emailRedirectTo,'https://gst.example.com/auth/callback');
 assert.deepEqual(Object.keys(submitted.options.data),['full_name']);
 assert.equal(submitted.email,'applicant@example.com');
 assert.match(message,/verification link/);
});

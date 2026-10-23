const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, globals={}) {
 const exports={};
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 vm.runInNewContext(code,{exports,URL,process:{env:{}},...globals});
 return exports;
}
test('redirect destinations stay within the application',()=>{
 const {safeDestination}=load('lib/auth.ts');
 for(const input of ['https://evil.test','//evil.test','/\\evil.test','/login','/auth/callback','/../login',null,'/foo\nbar']) assert.equal(safeDestination(input),'/');
 assert.equal(safeDestination('/?tab=verification'),'/?tab=verification');
});
test('API refresh retries the same workbook with a fresh bearer token',async()=>{
 let calls=[];
 const session={access_token:'old'};
 const client={auth:{getSession:async()=>({data:{session}}),refreshSession:async()=>({data:{session:{access_token:'new'}}})}};
 const api=load('lib/api.ts',{require:()=>({browserClient:()=>client}),FormData,fetch:async(url,init)=>{calls.push(init);return {status:calls.length===1?401:200,ok:calls.length!==1,json:async()=>({filename:'book.xlsx'})};},window:{dispatchEvent(){assert.fail('should refresh without prompting');}}});
 assert.equal((await api.inspectWorkbook(new Blob(['workbook']))).filename,'book.xlsx');
 assert.equal(calls.length,2);
 assert.equal(calls[0].headers.Authorization,'Bearer old');
 assert.equal(calls[1].headers.Authorization,'Bearer new');
 assert.equal(calls[0].body,calls[1].body);
});
test('missing session prompts sign-in without uploading the file',async()=>{
 let prompted=false;
 const api=load('lib/api.ts',{require:()=>({browserClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})}),FormData,Event,window:{dispatchEvent(){prompted=true;}},fetch:()=>assert.fail('must not upload')});
 await assert.rejects(()=>api.inspectWorkbook(new Blob(['workbook'])),/source workbook is retained/);
 assert.ok(prompted);
});

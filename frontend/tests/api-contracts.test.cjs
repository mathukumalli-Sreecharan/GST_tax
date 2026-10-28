const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function loadApi(globals={}) {
 const exports={};
 const code=ts.transpileModule(fs.readFileSync('lib/api.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 vm.runInNewContext(code,{exports,URL,process:{env:{}},require:()=>({browserClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'token'}}})}})}),...globals});
 return exports;
}

const processResponse={file_id:'file-1',filename:'book.xlsx',worksheet:'Sheet1',summary:{total:1,matched:1,review_required:0,unmatched:0,status_counts:{}},rows:[],verification:[]};
const reviewSession={review_id:'review-1',filename:'book.xlsx',worksheet:'Sheet1',version:1,expires_at:1,state:'open',rows:[],excluded_rows:[],decisions:{},progress:{total:1,matched:0,requiring_review:1,verified:0,remaining:1},result:null};

test('process route accepts a review session and rejects the legacy result schema',()=>{
 const api=loadApi();
 assert.equal(api.parseReviewSession(reviewSession).progress.total,1);
 assert.throws(()=>api.parseReviewSession(processResponse),/incompatible with this application version/);
});

test('generated results require summary totals and reject a review session',()=>{
 const api=loadApi();
 assert.equal(api.parseProcessResponse(processResponse).summary.total,1);
 assert.throws(()=>api.parseProcessResponse(reviewSession),/incompatible with this application version/);
 assert.throws(()=>api.parseProcessResponse({...processResponse,summary:{...processResponse.summary,total:undefined}}),/incompatible with this application version/);
});

test('processWorkbook reports a clear contract error for an old backend response',async()=>{
 const client={auth:{getSession:async()=>({data:{session:{access_token:'token'}}})}};
 const api=loadApi({require:()=>({browserClient:()=>client}),FormData,fetch:async()=>({ok:true,json:async()=>processResponse})});
 await assert.rejects(()=>api.processWorkbook(new Blob(['workbook']),{worksheet:'Sheet1',headerRow:1,invoiceColumn:'A',taxableColumn:'B',invoiceHeaderRow:1,taxableHeaderRow:1,recalculateExisting:false,confirmOverwrite:false}),/incompatible with this application version/);
});

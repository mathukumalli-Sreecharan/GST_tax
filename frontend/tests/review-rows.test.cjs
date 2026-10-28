const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');

function load(){
 const exports={};
 const code=ts.transpileModule(fs.readFileSync('lib/review-rows.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 vm.runInNewContext(code,{exports});
 return exports;
}

test('reviewable rows exclude only MATCHED and retain original row identity and details',()=>{
 const rows=[
  {excel_row:10,invoice_number:'INV-MATCHED',status:'MATCHED'},
  {excel_row:12,invoice_number:'INV-REVIEW',status:'REVIEW_REQUIRED'},
  {excel_row:19,invoice_number:'INV-UNRESOLVED',status:'UNRESOLVED'},
  {excel_row:24,invoice_number:'INV-INVALID',status:'INVALID'},
 ];
 const filtered=load().reviewableRows(rows);
 assert.deepEqual(filtered.map(row=>row.excel_row),[12,19,24]);
 assert.equal(filtered[0].invoice_number,'INV-REVIEW');
 assert.deepEqual(rows.map(row=>row.excel_row),[10,12,19,24]);
});

test('reviewable rows handle empty and all-matched sessions',()=>{
 const {reviewableRows}=load();
 assert.deepEqual(reviewableRows([]),[]);
 assert.deepEqual(reviewableRows([{excel_row:10,status:'MATCHED'}]),[]);
});

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');

function loadSplitHelpers(){
 const exports={};
 const code=ts.transpileModule(fs.readFileSync('lib/split-allocation.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 vm.runInNewContext(code,{exports,Intl,BigInt});
 return exports;
}

test('manual slab invoice sums every entered tax component using integer cents',()=>{
 const helpers=loadSplitHelpers();
 const slab={taxable:'100.00',igst:'18.00',cgst:'0',sgst:'0',cess:'2.50'};
 assert.equal(helpers.allocationInvoice(slab),12050n);
 assert.equal(helpers.formatCents(helpers.allocationInvoice(slab)),'₹120.50');
});

test('totals and differences expose field-level reconciliation without adjusting values',()=>{
 const {allocationTotals}=loadSplitHelpers();
 const summary=allocationTotals([
  {taxable:'60.00',igst:'10.80',cgst:'0.00',sgst:'0.00',cess:'1.00'},
  {taxable:'40.00',igst:'7.20',cgst:'0.00',sgst:'0.00',cess:'0.50'},
 ],{invoice:'119.50',taxable:'100.00',igst:'18.00',cgst:'0.00',sgst:'0.00',cess:'1.50'});
 assert.equal(summary.totals.invoice,11950n);
 assert.equal(summary.differences.taxable,0n);
 assert.equal(summary.differences.igst,0n);
 assert.equal(summary.differences.cess,0n);
});

test('allocation inputs require all five finite amounts with at most two decimals',()=>{
 const {allocationsComplete}=loadSplitHelpers();
 const row={taxable:'0.00',igst:'0.00',cgst:'0.00',sgst:'0.00',cess:'0.00'};
 assert.equal(allocationsComplete([row,{...row}]),true);
 assert.equal(allocationsComplete([row,{...row,cess:'0.001'}]),false);
 assert.equal(allocationsComplete([row,{...row,sgst:'-'}]),false);
});

test('equivalent decimal spellings compare as the same allocation but changed cents do not',()=>{
 const {sameAllocations}=loadSplitHelpers();
 const left=[{taxable:'10',igst:'1.80',cgst:'0',sgst:'0',cess:'0'}];
 assert.equal(sameAllocations(left,[{taxable:'10.00',igst:'1.8',cgst:'0.00',sgst:'0',cess:'0'}]),true);
 assert.equal(sameAllocations(left,[{taxable:'10.01',igst:'1.80',cgst:'0',sgst:'0',cess:'0'}]),false);
});

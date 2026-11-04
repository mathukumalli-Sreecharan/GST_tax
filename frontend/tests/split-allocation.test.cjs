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
const rupee=String.fromCharCode(0x20b9);

test('manual slab invoice sums every entered tax component without rounding precision',()=>{
 const helpers=loadSplitHelpers();
 const slab={taxable:'100.0001',igst:'18.000018',cgst:'0',sgst:'0',cess:'2.500005'};
 const invoice=helpers.allocationInvoice(slab);
 assert.equal(invoice.units,120500123n);
 assert.equal(invoice.scale,6);
 assert.equal(helpers.formatAmount(invoice),`${rupee}120.500123`);
});

test('totals and differences expose exact field reconciliation without adjusting values',()=>{
 const {allocationTotals,formatAmount}=loadSplitHelpers();
 const summary=allocationTotals([
  {taxable:'60.0001',igst:'10.800018',cgst:'0.00',sgst:'0.00',cess:'1.000005'},
  {taxable:'40.0002',igst:'7.200036',cgst:'0.00',sgst:'0.00',cess:'0.500007'},
 ],{invoice:'119.500366',taxable:'100.0003',igst:'18.000054',cgst:'0.00',sgst:'0.00',cess:'1.500012'});
 assert.equal(formatAmount(summary.totals.invoice),`${rupee}119.500366`);
 assert.equal(formatAmount(summary.differences.taxable),`${rupee}0.0000`);
 assert.equal(formatAmount(summary.differences.igst),`${rupee}0.000000`);
 assert.equal(formatAmount(summary.differences.cess),`${rupee}0.000000`);
});

test('allocation inputs accept more than two decimal places and reject malformed amounts',()=>{
 const {allocationsComplete,allocationInvoice,formatAmount}=loadSplitHelpers();
 const row={taxable:'0.00',igst:'0.00',cgst:'0.00',sgst:'0.00',cess:'0.00'};
 assert.equal(allocationsComplete([row,{...row}]),true);
 const precise={taxable:'1.001',igst:'0.18018',cgst:'0',sgst:'0',cess:'0.0005'};
 assert.equal(allocationsComplete([precise,{...precise}]),true);
 assert.equal(formatAmount(allocationInvoice(precise)),`${rupee}1.18168`);
 assert.equal(allocationsComplete([row,{...row,sgst:'-'}]),false);
});

test('equivalent decimal spellings compare numerically but distinct precision does not',()=>{
 const {sameAllocations}=loadSplitHelpers();
 const left=[{taxable:'10',igst:'1.80',cgst:'0',sgst:'0',cess:'0'}];
 assert.equal(sameAllocations(left,[{taxable:'10.00',igst:'1.8',cgst:'0.00',sgst:'0',cess:'0'}]),true);
 assert.equal(sameAllocations(left,[{taxable:'10.0001',igst:'1.80',cgst:'0',sgst:'0',cess:'0'}]),false);
});

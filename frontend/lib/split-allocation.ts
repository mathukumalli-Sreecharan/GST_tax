export type SplitAllocationInput = {
 taxable:string; igst:string; cgst:string; sgst:string; cess:string;
};

export type SplitAllocationField = keyof SplitAllocationInput;
export type ExactAmount = {units:bigint;scale:number};
export const splitAllocationFields:SplitAllocationField[]=['taxable','igst','cgst','sgst','cess'];

export function decimalAmount(value:string):ExactAmount|null {
 const clean=value.trim();
 if(!/^[+-]?\d+(?:\.\d+)?$/.test(clean))return null;
 const negative=clean.startsWith('-'),unsigned=clean.replace(/^[+-]/,''),[whole,fraction='']=unsigned.split('.');
 const scale=fraction.length,units=BigInt(whole+fraction);
 return {units:negative?BigInt(0)-units:units,scale};
}

function aligned(value:ExactAmount,scale:number):bigint {
 return value.units*BigInt(10)**BigInt(scale-value.scale);
}

function add(left:ExactAmount,right:ExactAmount):ExactAmount {
 const scale=Math.max(left.scale,right.scale);
 return {units:aligned(left,scale)+aligned(right,scale),scale};
}

function subtract(left:ExactAmount,right:ExactAmount):ExactAmount {
 return add(left,{units:BigInt(0)-right.units,scale:right.scale});
}

export function formatAmount(value:ExactAmount):string {
 const scale=Math.max(2,value.scale),negative=value.units<BigInt(0);
 const absolute=(negative?BigInt(0)-value.units:value.units)*BigInt(10)**BigInt(scale-value.scale);
 const digits=absolute.toString().padStart(scale+1,'0'),whole=scale?digits.slice(0,-scale):digits;
 const fraction=scale?digits.slice(-scale):'';
 const grouped=new Intl.NumberFormat('en-IN',{maximumFractionDigits:0}).format(BigInt(whole));
 return `${negative?'-':''}${String.fromCharCode(0x20b9)}${grouped}.${fraction}`;
}

export function allocationInvoice(allocation:SplitAllocationInput):ExactAmount|null {
 const amounts=splitAllocationFields.map(field=>decimalAmount(allocation[field]));
 if(amounts.some(value=>value===null))return null;
 return (amounts as ExactAmount[]).reduce(add,{units:BigInt(0),scale:0});
}

export function allocationTotals(allocations:SplitAllocationInput[],original:Record<string,string>) {
 const totals:Record<string,ExactAmount|null>={};
 for(const field of splitAllocationFields){
  const values=allocations.map(part=>decimalAmount(part[field]));
  totals[field]=values.some(value=>value===null)?null:(values as ExactAmount[]).reduce(add,{units:BigInt(0),scale:0});
 }
 const invoices=allocations.map(allocationInvoice);
 totals.invoice=invoices.some(value=>value===null)?null:(invoices as ExactAmount[]).reduce(add,{units:BigInt(0),scale:0});
 const originalAmounts:Record<string,ExactAmount>={};
 for(const field of [...splitAllocationFields,'invoice'])originalAmounts[field]=decimalAmount(original[field]??'')??{units:BigInt(0),scale:0};
 const differences:Record<string,ExactAmount|null>={};
 for(const field of [...splitAllocationFields,'invoice'])differences[field]=totals[field]===null?null:subtract(totals[field]!,originalAmounts[field]);
 return {totals,original:originalAmounts,differences};
}

export function allocationsComplete(allocations:SplitAllocationInput[]):boolean {
 return allocations.length>=2&&allocations.every(part=>splitAllocationFields.every(field=>decimalAmount(part[field])!==null));
}

export function sameAllocations(left:SplitAllocationInput[],right:SplitAllocationInput[]):boolean {
 return left.length===right.length&&left.every((part,index)=>splitAllocationFields.every(field=>{
  const a=decimalAmount(part[field]),b=decimalAmount(right[index]?.[field]??'');
  return a!==null&&b!==null&&aligned(a,Math.max(a.scale,b.scale))===aligned(b,Math.max(a.scale,b.scale));
 }));
}

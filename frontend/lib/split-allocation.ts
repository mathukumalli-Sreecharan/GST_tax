export type SplitAllocationInput = {
 taxable:string; igst:string; cgst:string; sgst:string; cess:string;
};

export type SplitAllocationField = keyof SplitAllocationInput;
export const splitAllocationFields:SplitAllocationField[]=['taxable','igst','cgst','sgst','cess'];

export function cents(value:string):bigint|null {
 const clean=value.trim();
 if(!/^[+-]?\d+(?:\.\d{0,2})?$/.test(clean))return null;
 const negative=clean.startsWith('-'),unsigned=clean.replace(/^[+-]/,'');
 const [whole,fraction='']=unsigned.split('.');
 const amount=BigInt(whole)*BigInt(100)+BigInt((fraction+'00').slice(0,2));
 return negative?BigInt(0)-amount:amount;
}

export function formatCents(value:bigint):string {
 const negative=value<BigInt(0),absolute=negative?BigInt(0)-value:value;
 const rupees=absolute/BigInt(100),paise=(absolute%BigInt(100)).toString().padStart(2,'0');
 const grouped=new Intl.NumberFormat('en-IN',{maximumFractionDigits:0}).format(rupees);
 return (negative?'-':'')+String.fromCharCode(0x20b9)+grouped+'.'+paise;
}

export function allocationInvoice(allocation:SplitAllocationInput):bigint|null {
 const amounts=splitAllocationFields.map(field=>cents(allocation[field]));
 if(amounts.some(value=>value===null))return null;
 return (amounts as bigint[]).reduce((total,value)=>total+value,BigInt(0));
}

export function allocationTotals(allocations:SplitAllocationInput[],original:Record<string,string>) {
 const totals:Record<string,bigint|null>={};
 for(const field of splitAllocationFields){
  const values=allocations.map(part=>cents(part[field]));
  totals[field]=values.some(value=>value===null)?null:(values as bigint[]).reduce((sum,value)=>sum+value,BigInt(0));
 }
 const invoices=allocations.map(allocationInvoice);
 totals.invoice=invoices.some(value=>value===null)?null:(invoices as bigint[]).reduce((sum,value)=>sum+value,BigInt(0));
 const originalCents:Record<string,bigint>={};
 for(const field of [...splitAllocationFields,'invoice'])originalCents[field]=cents(original[field]??'')??BigInt(0);
 const differences:Record<string,bigint|null>={};
 for(const field of [...splitAllocationFields,'invoice'])differences[field]=totals[field]===null?null:totals[field]!-originalCents[field];
 return {totals,original:originalCents,differences};
}

export function allocationsComplete(allocations:SplitAllocationInput[]):boolean {
 return allocations.length>=2&&allocations.every(part=>splitAllocationFields.every(field=>cents(part[field])!==null));
}

export function sameAllocations(left:SplitAllocationInput[],right:SplitAllocationInput[]):boolean {
 return left.length===right.length&&left.every((part,index)=>splitAllocationFields.every(field=>{
  const a=cents(part[field]),b=cents(right[index]?.[field]??'');
  return a!==null&&a===b;
 }));
}

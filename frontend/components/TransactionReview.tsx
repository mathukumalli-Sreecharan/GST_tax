'use client';
import {useEffect,useState} from 'react';
import type {ColumnDef} from '@tanstack/react-table';
import {approvalApi,parseProcessResponse,parseReviewSession} from '@/lib/api';
import {DataTable} from '@/components/DataTable';
import type {ReviewSession,ReviewRow,ProcessResponse} from '@/lib/types';
import {reviewableRows} from '@/lib/review-rows';
import {allocationInvoice,allocationTotals,allocationsComplete,formatAmount,sameAllocations,type SplitAllocationInput} from '@/lib/split-allocation';

const fields: [keyof ReviewRow,string][]=[['supplier_gstin','Supplier GSTIN'],['supplier_name','Supplier name'],['invoice_number','Invoice number'],['invoice_date','Invoice date'],['invoice_value','Invoice value'],['taxable_value','Taxable value'],['igst','IGST'],['cgst','CGST'],['sgst','SGST/UTGST'],['cess','Cess']];
const columns:ColumnDef<ReviewRow,unknown>[]=[{accessorKey:'excel_row',header:'Excel row'},...fields.map(([accessorKey,header])=>({accessorKey,header})),{accessorKey:'rate',header:'Assigned rate'},{accessorKey:'status',header:'Status'},{accessorKey:'reason',header:'Reason for review'}];
export function TransactionReview({initial,onUpdate,onGenerated,onResume}:{initial?:ReviewSession;onUpdate:(review:ReviewSession)=>void;onGenerated:(result:ProcessResponse)=>void;onResume?:()=>void}){
 const [sessions,setSessions]=useState<{review_id:string;filename:string;state:string}[]>([]);
 const [selected,setSelected]=useState<number|null>(null),[choice,setChoice]=useState(''),[count,setCount]=useState(0),[rates,setRates]=useState<string[]>([]);
 const [allocations,setAllocations]=useState<SplitAllocationInput[]>([]);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[saveNotice,setSaveNotice]=useState('');
 const reviewRows=initial?reviewableRows(initial.rows,initial.decisions):[];
 const row=reviewRows.find(item=>item.excel_row===selected)??reviewRows[0];
 const decision=row?initial?.decisions[String(row.excel_row)]:undefined;
 useEffect(()=>{if(!initial)void approvalApi<{reviews:typeof sessions}>('/excel/reviews').then(data=>setSessions(data.reviews)).catch(()=>{});},[initial]);
 useEffect(()=>{setChoice(decision?.choice??'');setCount(decision?.rates.length??0);setRates(decision?.rates??[]);setAllocations(decision?.split_preview?.allocations??Array.from({length:decision?.rates.length??0},()=>({taxable:'',igst:'',cgst:'',sgst:'',cess:''})));},[row?.excel_row,decision]);
 async function resume(id:string){setBusy(true);setError('');try{const review=parseReviewSession(await approvalApi<unknown>(`/excel/reviews/${id}`));onUpdate(review);onResume?.();if(review.result)onGenerated(parseProcessResponse(review.result));}catch(e){setError(e instanceof Error?e.message:'Unable to resume review.');}finally{setBusy(false);}}
 async function save(selectedChoice=choice){if(!initial||!row)return;setBusy(true);setError('');setSaveNotice('');try{
   const updated=parseReviewSession(await approvalApi<unknown>(`/excel/reviews/${initial.review_id}/rows/${row.excel_row}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:initial.version,choice:selectedChoice,...(selectedChoice==='WRONG'?{slab_count:count,rates}: {})})}));
   onUpdate(updated);
   const currentIndex=reviewRows.findIndex(item=>item.excel_row===row.excel_row),nextRow=reviewRows[currentIndex+1];
   const needsAllocations=selectedChoice==='WRONG'&&rates.length>1;
   setSaveNotice(needsAllocations?`Rates saved for Excel row ${row.excel_row}. Enter and confirm the complete tax breakup for every slab before generating.`:nextRow?`Decision saved for Excel row ${row.excel_row}. Next transaction selected.`:`Decision saved for Excel row ${row.excel_row}. This was the final transaction.`);
   if(nextRow&&!needsAllocations)setSelected(nextRow.excel_row);
 }catch(e){setError(e instanceof Error?e.message:'Unable to save decision. Reload the review before retrying.');}finally{setBusy(false);}}
 async function split(action:'split-preview'|'split-confirm'){if(!initial||!row)return;setBusy(true);setError('');try{
  const body=action==='split-confirm'?{version:initial.version,preview_id:decision?.split_preview?.preview_id}:{version:initial.version,allocations};
   onUpdate(parseReviewSession(await approvalApi<unknown>(`/excel/reviews/${initial.review_id}/rows/${row.excel_row}/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})));
 }catch(e){setError(e instanceof Error?e.message:'Unable to validate the split.');}finally{setBusy(false);}}
 async function generate(){if(!initial)return;setBusy(true);setError('');try{const result=parseProcessResponse(await approvalApi<unknown>(`/excel/reviews/${initial.review_id}/generate`,{method:'POST'}));onUpdate({...initial,state:'generated',result});onGenerated(result);}catch(e){setError(e instanceof Error?e.message:'Unable to generate workbook.');}finally{setBusy(false);}}
 if(!initial)return <>{sessions.length>0&&<section className="panel panel-body"><h2>Resume a review</h2><p className="subtext">Reviews are retained for up to 24 hours on this server.</p>{sessions.map(item=><div key={item.review_id} className="toolbar"><button className="btn" disabled={busy} onClick={()=>void resume(item.review_id)}>{item.filename} ({item.state})</button><button className="btn btn-small" disabled={busy} onClick={()=>{void approvalApi(`/excel/reviews/${item.review_id}`,{method:'DELETE'}).then(()=>setSessions(sessions.filter(s=>s.review_id!==item.review_id))).catch(e=>setError(e instanceof Error?e.message:'Unable to delete review.'));}}>Delete review</button></div>)}</section>}{error&&<p role="alert" className="inline-error">{error}</p>}</>;
 const progress=initial.progress;
 const unconfirmedSplit=Object.values(initial.decisions).some(d=>d.choice==='WRONG'&&d.rates.length>1&&!d.split_confirmed);
 const index=row?reviewRows.findIndex(item=>item.excel_row===row.excel_row):-1;
 const preview=decision?.split_preview;
 const savedSlabs=choice==='WRONG'&&JSON.stringify(rates)===JSON.stringify(decision?.rates);
 const unsavedDecision=decision&&(choice!==decision.choice||(choice==='WRONG'&&!savedSlabs));
 const previewChanged=!preview?.allocations||!sameAllocations(allocations,preview.allocations);
 const allocationSummary=allocationTotals(allocations,{invoice:row?.invoice_value??'',taxable:row?.taxable_value??'',igst:row?.igst??'',cgst:row?.cgst??'',sgst:row?.sgst??'',cess:row?.cess??''});
 const allocationHeaders:Record<string,string>={taxable:'Taxable Value',igst:'Integrated Tax',cgst:'Central Tax',sgst:'State/UT Tax',cess:'Cess',invoice:'Invoice Value'};
 const editable=!busy&&initial.state==='open';
 return <section aria-label="Transaction verification">
  <div className="page-head"><div><h2>Verify transactions before generating Excel</h2><p className="subtext">{initial.filename} | {initial.worksheet}. Every uncertain transaction needs your decision.</p></div><button className="btn" disabled={busy} onClick={()=>void resume(initial.review_id)}>Reload review</button></div>
  <div className="metric-grid">{Object.entries({ 'Total transactions':progress.total,'Matched transactions':progress.matched,'Requiring review':progress.requiring_review,'Verified transactions':progress.verified,'Remaining transactions':progress.remaining}).map(([label,value])=><div className="metric" key={label}><div className="metric-label">{label}</div><div className="metric-value">{value}</div></div>)}</div>
  {error&&<p role="alert" className="inline-error">{error}</p>}
  {initial.state==='generating'&&<p className="subtext">Generation is in progress. Reload this review to check its state. An interrupted generation can be recovered after its ten-minute lease expires.</p>}
  {initial.state==='generating'&&initial.lease_until&&initial.lease_until*1000<Date.now()&&<button className="btn" disabled={busy} onClick={()=>{setBusy(true);void approvalApi<ReviewSession>(`/excel/reviews/${initial.review_id}/recover`,{method:'POST'}).then(onUpdate).catch(e=>setError(e instanceof Error?e.message:'Recovery failed.')).finally(()=>setBusy(false));}}>Recover interrupted generation</button>}
  {initial.generation_blockers?.map(message=><p className="inline-error" key={message}>{message}</p>)}
  <section className="panel panel-body"><h3>Transactions requiring verification ({reviewRows.length})</h3><DataTable rows={reviewRows} columns={columns} statusFilter emptyText="No transactions require verification. All transactions are matched or no reviewable transactions remain." onRowClick={item=>{setSaveNotice('');setSelected(item.excel_row);}} />
  <details><summary>Excluded structural rows ({initial.excluded_rows.length})</summary><ul>{initial.excluded_rows.map(item=><li key={item.row}>Excel row {item.row}: {item.reason}</li>)}</ul></details></section>
  {row&&<section className="panel panel-body" style={{marginTop:16}}><h3>Review Excel row {row.excel_row}</h3><p className="subtext">{row.status}: {row.reason||'The assigned rate matches the existing calculation rules.'}</p>
   <dl className="detail-list">{fields.map(([key,label])=><div className="detail-item" key={key}><dt className="detail-label">{label}</dt><dd className="detail-value">{String(row[key]??'')||'Unavailable'}</dd></div>)}<div className="detail-item"><dt>Currently assigned rate</dt><dd>{row.rate===null?'Not assigned':`${row.rate}%`}</dd></div></dl>
   <div className="toolbar" style={{marginTop:16}}><button className="btn" aria-pressed={choice==='CORRECT'} disabled={!editable||row.rate===null} onClick={()=>{setChoice('CORRECT');void save('CORRECT');}}>CORRECT</button><button className="btn" aria-pressed={choice==='WRONG'} disabled={!editable} onClick={()=>setChoice('WRONG')}>WRONG</button></div>
   {choice==='WRONG'&&<div className="form-grid" style={{marginTop:16}}><label className="field">How many GST slabs does this invoice contain?<input aria-label="Number of GST slabs" type="number" min={1} max={10} value={count||''} disabled={!editable} onChange={event=>{const value=Math.max(0,Math.min(10,Math.trunc(Number(event.target.value))));setCount(value);setRates(Array.from({length:value},(_,i)=>rates[i]??''));}}/></label>{Array.from({length:count},(_,i)=><label className="field" key={i}>GST rate for slab {i+1} (%)<input aria-label={`GST rate for slab ${i+1}`} type="number" min={0} max={100} step="0.01" value={rates[i]??''} disabled={!editable} onChange={event=>setRates(rates.map((rate,j)=>j===i?event.target.value:rate))}/></label>)}</div>}
   {choice==='WRONG'&&<p className="subtext">Enter the actual rates for this invoice, then save them. For multiple slabs, enter taxable value, each tax component, and Cess for every slab. Amounts must keep the original transaction sign.</p>}
   {saveNotice&&<p className="success-note" role="status" style={{marginTop:14}}>{saveNotice}</p>}
   <div className="toolbar" style={{marginTop:16}}><button className="btn btn-primary" disabled={!editable||!choice||(choice==='WRONG'&&(!count||rates.some(value=>!value.trim())))} onClick={()=>void save()}>{busy?'Saving...':decision?'Update decision':'Save decision'}</button><button className="btn" disabled={busy||index<=0} onClick={()=>{setSaveNotice('');setSelected(reviewRows[index-1].excel_row);}}>Previous transaction</button><button className="btn" disabled={busy||index<0||index>=reviewRows.length-1} onClick={()=>{setSaveNotice('');setSelected(reviewRows[index+1].excel_row);}}>Next transaction</button>{decision&&<span role="status">Decision saved: {decision.choice}</span>}</div>
  </section>}
  {row&&decision?.choice==='WRONG'&&decision.rates.length>1&&<section className="panel panel-body" style={{marginTop:16}} aria-label="Mixed-rate allocation">
   <h3>Replacement rows for Excel row {row.excel_row}</h3>
   <p className="subtext">Enter each slab's complete tax breakup. Decimal precision is preserved. Amounts must keep the original transaction sign and reconcile exactly to the source totals. Invoice Value is calculated automatically.</p>
   <div className="data-wrap split-allocation-wrap"><table className="data-table split-allocation-table"><thead><tr>{['Tax Rate (%)','Taxable Value (₹)','Integrated Tax (₹)','Central Tax (₹)','State/UT Tax (₹)','Cess (₹)'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{decision.rates.map((rate,index)=>{const part=allocations[index]??{taxable:'',igst:'',cgst:'',sgst:'',cess:''};return <tr key={`${rate}-${index}`}><th scope="row">{rate}%</th>{(['taxable','igst','cgst','sgst','cess'] as const).map(field=><td key={field}><input className="split-allocation-input" type="text" inputMode="decimal" maxLength={128} aria-label={`${field.toUpperCase()} allocation for slab ${index+1} at ${rate}%`} placeholder="0.00" disabled={!editable||!savedSlabs} value={part[field]} onChange={event=>setAllocations(current=>current.map((value,i)=>i===index?{...value,[field]:event.target.value}:value))}/></td>)}</tr>;})}</tbody></table></div>
   <div className="split-invoice-preview"><h4>Calculated invoice value by slab</h4><div className="data-wrap"><table className="data-table"><thead><tr><th>Tax Rate (%)</th><th>Calculated Invoice Value (₹)</th></tr></thead><tbody>{decision.rates.map((rate,index)=>{const invoice=allocationInvoice(allocations[index]??{taxable:'',igst:'',cgst:'',sgst:'',cess:''});return <tr key={`${rate}-${index}`}><td>{rate}%</td><td>{invoice===null?'Enter valid amounts':formatAmount(invoice)}</td></tr>;})}</tbody></table></div></div>
   <div className="split-reconciliation"><h4>Original and replacement totals</h4><div className="data-wrap"><table className="data-table"><thead><tr><th>Field</th><th>Original (₹)</th><th>Replacement (₹)</th><th>Difference (₹)</th></tr></thead><tbody>{['taxable','igst','cgst','sgst','cess','invoice'].map(field=>{const original=allocationSummary.original[field],total=allocationSummary.totals[field],difference=allocationSummary.differences[field];return <tr key={field}><th scope="row">{allocationHeaders[field]}</th><td>{formatAmount(original)}</td><td>{total===null?'—':formatAmount(total)}</td><td>{difference===null?'—':formatAmount(difference)}</td></tr>;})}</tbody></table></div></div>
   <div className="toolbar split-actions"><button className="btn" disabled={!editable||!savedSlabs||!allocationsComplete(allocations)} onClick={()=>void split('split-preview')}>Validate allocations</button><button className="btn btn-primary" disabled={!editable||!savedSlabs||!preview?.valid||previewChanged||decision.split_confirmed} onClick={()=>void split('split-confirm')}>Confirm replacement rows</button></div>
   {!allocationsComplete(allocations)&&<p className="subtext" role="status">Enter all five amounts for every slab. Use 0.00 where a component does not apply.</p>}
   {preview&&preview.errors?.length>0&&<ul className="inline-error split-errors" role="alert">{preview.errors.map((message,index)=><li key={`${index}-${message}`}>{message}</li>)}</ul>}
   {preview?.valid&&<p className="success-note" role="status">Allocations validated. {preview.rounding}</p>}
   {previewChanged&&preview&&<p className="subtext" role="status">Allocations changed after validation. Validate them again before confirming.</p>}
   {decision.split_confirmed&&<p className="success-note" role="status">Replacement rows confirmed and saved.</p>}
  </section>}
  <div className="result-actions" style={{marginTop:20}}><button className="btn btn-primary" disabled={busy||Boolean(initial.generation_blockers?.length)||Boolean(unsavedDecision)||Boolean(decision?.split_confirmed&&previewChanged)||progress.remaining>0||unconfirmedSplit||initial.state==='generating'||!progress.total} onClick={()=>void generate()}>Generate Excel</button><span className="subtext">{progress.remaining} required reviews remaining.</span></div>
 </section>;
}


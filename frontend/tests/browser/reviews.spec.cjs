const {test,expect}=require('@playwright/test');

test('review pagination, manual slabs, persistence, edits and generation gate',async({page})=>{
 let state={review_id:'test-review',filename:'review.xlsx',worksheet:'Invoices',version:1,state:'open',excluded_rows:[],decisions:{},result:null,
  rows:Array.from({length:15},(_,i)=>({excel_row:i+7,supplier_gstin:'GSTIN-'+i,supplier_name:'Supplier '+i,invoice_number:'INV-'+i,invoice_date:'2026-10-25',invoice_value:i===14?'':'118',taxable_value:i===14?'':'100',igst:'18',cgst:'0',sgst:'0',cess:'0',rate:i===14?null:18,inferred_rate:i===14?null:18,status:i===14?'UNRESOLVED':i===1?'REVIEW_REQUIRED':'MATCHED',reason:i===14?'Missing monetary values':i===1?'Verify inconsistent tax details':''})),
  progress:{total:15,matched:13,requiring_review:2,verified:0,remaining:2}};
 let generated=0;const decisions=[];
 await page.route('**/api/excel/reviews**',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.pathname.endsWith('/generate')){
   if(state.progress.remaining)return route.fulfill({status:409,json:{detail:'Complete reviews first'}});
   generated++;
   return route.fulfill({json:{file_id:'output',filename:'verified.xlsx',worksheet:'Invoices',summary:{total:15,matched:13,review_complete:true,review_required:2,unmatched:0,status_counts:{},rate_counts:{}},rows:[],verification:[],rate_column:{letter:'D',index:4}}});
  }
  if(request.method()==='POST'){
   const body=request.postDataJSON();decisions.push(body);
   if(body.version!==state.version)return route.fulfill({status:409,json:{detail:'Review changed'}});
   if(url.pathname.endsWith('/split-preview')||url.pathname.endsWith('/split-confirm')){
    const row=Number(url.pathname.split('/').at(-2));const d=state.decisions[row];
    if(url.pathname.endsWith('/split-preview'))d.split_preview={preview_id:'preview',manual_required:false,method:'calculated',rows:d.rates.map(rate=>({rate,invoice:'59',taxable:'50',igst:'9',cgst:'0',sgst:'0',cess:'0'})),taxable_allocations:body.taxable_allocations??null,requested_mode:body.tax_mode??null};
    else d.split_confirmed=true;
    state={...state,version:state.version+1,decisions:{...state.decisions,[row]:{...d}}};
    return route.fulfill({json:state});
   }
   const row=Number(url.pathname.split('/').at(-1));
   state={...state,version:state.version+1,decisions:{...state.decisions,[row]:{choice:body.choice,rates:body.rates??[],saved_at:1}}};
   const verified=Object.keys(state.decisions).length;
   state.progress={...state.progress,verified,remaining:2-verified};
  }
  return route.fulfill({json:url.pathname==='/api/excel/reviews'?{reviews:[{review_id:state.review_id,filename:state.filename,state:state.state}]}:state});
 });
 async function resume(){
  await page.goto('/?screen=workspace');
  const skip=page.getByRole('button',{name:'Skip introduction'});if(await skip.isVisible())await skip.click();
  await page.getByRole('button',{name:'Process Excel',exact:true}).click();
  await page.getByRole('button',{name:'review.xlsx (open)',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Verify transactions before generating Excel'})).toBeVisible();
 }
 await resume();
 await expect(page.getByRole('button',{name:'Generate Excel',exact:true})).toBeDisabled();expect(generated).toBe(0);
 await expect(page.locator('.data-table tbody tr')).toHaveCount(10);
 await page.getByRole('button',{name:'Next page',exact:true}).click();
 await expect(page.locator('.data-table tbody tr')).toHaveCount(5);
 await expect(page.locator('.data-table').getByText('INV-14',{exact:true})).toBeVisible();
 // The default detail is the first suspicious transaction, independent of table pagination.
 await page.getByRole('button',{name:'CORRECT',exact:true}).click();
 await page.getByRole('button',{name:'Save decision',exact:true}).click();
 await expect(page.getByText('Decision saved: CORRECT')).toBeVisible();
 await page.getByRole('button',{name:'Next page',exact:true}).click();
 await expect(page.getByRole('button',{name:'Generate Excel',exact:true})).toBeDisabled();
 await page.locator('.data-table').getByText('INV-14',{exact:true}).click();
 await expect(page.getByRole('heading',{name:'Review Excel row 21',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'CORRECT',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'WRONG',exact:true}).click();
 await page.getByLabel('Number of GST slabs').fill('2');
 await expect(page.getByLabel('GST rate for slab 1',{exact:true})).toHaveValue('');
 await page.getByLabel('GST rate for slab 1',{exact:true}).fill('5');
 await page.getByLabel('GST rate for slab 2',{exact:true}).fill('12');
 await page.getByRole('button',{name:'Save decision',exact:true}).click();
 await expect(page.getByText('Decision saved: WRONG')).toBeVisible();
 await expect(page.getByRole('button',{name:'Generate Excel',exact:true})).toBeDisabled();
 expect(generated).toBe(0);
 await resume(); // Saved decisions survive component/browser reload.
 await page.getByRole('button',{name:'Next page',exact:true}).click();
 await page.locator('.data-table').getByText('INV-14',{exact:true}).click();
 await expect(page.getByLabel('GST rate for slab 2',{exact:true})).toHaveValue('12');
 await page.getByLabel('GST rate for slab 2',{exact:true}).fill('18');
 await page.getByRole('button',{name:'Update decision',exact:true}).click();
 await expect.poll(()=>state.decisions['21'].rates[1]).toBe('18');
 await page.getByRole('button',{name:'Calculate replacement rows',exact:true}).click();
 await expect(page.getByRole('button',{name:'Generate Excel',exact:true})).toBeDisabled();
 await expect(page.getByRole('button',{name:'Confirm replacement rows',exact:true})).toBeEnabled();
 await page.getByLabel('Taxable allocation for slab 1').fill('50');
 await expect(page.getByRole('button',{name:'Confirm replacement rows',exact:true})).toBeDisabled();
 await page.getByLabel('Taxable allocation for slab 2').fill('50');
 await page.getByRole('button',{name:'Preview manual allocations',exact:true}).click();
 await expect(page.getByRole('button',{name:'Confirm replacement rows',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Confirm replacement rows',exact:true}).click();
 await expect(page.getByText('Split confirmed and saved.')).toBeVisible();
 await expect(page.getByRole('button',{name:'Generate Excel',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Generate Excel',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Processed rows',exact:true})).toBeVisible();
 expect(generated).toBe(1);
 expect(decisions[0]).toEqual({version:1,choice:'CORRECT'});
 expect(decisions[1].rates).toEqual(['5','12']);
});

const {test,expect}=require('@playwright/test');
const fs=require('node:fs/promises');

test('synthetic full journey uses production API client and real local FastAPI/Excel processing',async({page,request})=>{
 const source=await request.get('/__audit/fixture');expect(source.ok()).toBeTruthy();
 await page.goto('/?screen=workspace');
 const skip=page.getByRole('button',{name:'Skip introduction'});if(await skip.isVisible())await skip.click();
 await page.getByRole('button',{name:'Process Excel',exact:true}).click();
 await page.locator('input[type=file]').setInputFiles({name:'SYNTHETIC-b2b-audit.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:await source.body()});
 await page.getByRole('button',{name:'Continue to processing'}).click();
 await page.getByRole('button',{name:'Calculate GST Rates',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Verify transactions before generating Excel'})).toBeVisible();
 const generate=page.getByRole('button',{name:'Generate Excel',exact:true});
 await expect(generate).toBeDisabled();
 const all=await request.get('/api/excel/reviews');const id=(await all.json()).reviews[0].review_id;
 expect((await request.post(`/api/excel/reviews/${id}/generate`)).status()).toBe(409);
 await expect(page.locator('.data-table').getByText('AUDIT-9',{exact:true})).toBeVisible();
 async function select(row){await page.locator('.data-table').getByText('AUDIT-'+row,{exact:true}).click();}
 async function wrong(rates){
  await page.getByRole('button',{name:'WRONG',exact:true}).click();
  await page.getByLabel('Number of GST slabs').fill(String(rates.length));
  for(let i=0;i<rates.length;i++)await page.getByLabel(`GST rate for slab ${i+1}`,{exact:true}).fill(String(rates[i]));
  await page.getByRole('button',{name:'Save decision',exact:true}).click();
  await expect(page.getByText('Decision saved: WRONG',{exact:true})).toBeVisible();
 }
 await select(7);await wrong([18,12]);
 await page.getByRole('button',{name:'Calculate replacement rows',exact:true}).click();
 await expect(page.getByRole('button',{name:'Confirm replacement rows',exact:true})).toBeEnabled();
 await expect(generate).toBeDisabled();
 await page.getByRole('button',{name:'Confirm replacement rows',exact:true}).click();
 await expect(page.getByText('Split confirmed and saved.')).toBeVisible();
 await select(8);await wrong([5,12,18]);
 await page.getByRole('button',{name:'Calculate replacement rows',exact:true}).click();
 await expect(page.getByText(/source does not determine a unique solution/)).toBeVisible();
 for(const [i,value] of ['100','200','299'].entries())await page.getByLabel(`Taxable allocation for slab ${i+1}`).fill(value);
 await page.getByRole('button',{name:'Preview manual allocations',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('sum exactly');
 await page.getByLabel('Taxable allocation for slab 3').fill('300');
 await page.getByRole('button',{name:'Preview manual allocations',exact:true}).click();
 await page.getByRole('button',{name:'Confirm replacement rows',exact:true}).click();
 await expect(page.getByText('Split confirmed and saved.')).toBeVisible();
 // Refresh and explicitly resume the persisted, confirmed review.
 await page.reload();await page.getByRole('button',{name:'Process Excel',exact:true}).click();
 await page.getByRole('button',{name:'SYNTHETIC-b2b-audit.xlsx (open)',exact:true}).click();
 await select(8);await expect(page.getByLabel('Taxable allocation for slab 3')).toHaveValue('300');
 await expect(page.getByText('Split confirmed and saved.')).toBeVisible();
 // Save an edit of a previously confirmed decision; it must invalidate confirmation.
 await page.getByRole('button',{name:'Update decision',exact:true}).click();
 await expect(page.getByText('Split confirmed and saved.')).toHaveCount(0);
 await expect(generate).toBeDisabled();
 for(const [i,value] of ['100','200','300'].entries())await page.getByLabel(`Taxable allocation for slab ${i+1}`).fill(value);
 await page.getByRole('button',{name:'Preview manual allocations',exact:true}).click();
 await page.getByRole('button',{name:'Confirm replacement rows',exact:true}).click();
 await select(9);await wrong([18]);await select(10);await wrong([18]);
 await select(11);await page.getByRole('button',{name:'CORRECT',exact:true}).click();
 await page.getByRole('button',{name:'Save decision',exact:true}).click();
 await expect(generate).toBeEnabled();
 await generate.click();await expect(page.getByRole('heading',{name:'Processed rows',exact:true})).toBeVisible();
 const pending=page.waitForEvent('download');
 await page.getByRole('button',{name:'Download Updated Excel',exact:true}).click();
 const downloaded=await pending;const buffer=await fs.readFile(await downloaded.path());
 const checked=await request.post('/__audit/validate',{multipart:{file:{name:'download.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer}}});
 expect(await checked.json()).toEqual({zip_valid:true,sheets:['B2B','Unrelated'],totals:{invoice:'1031',taxable:'900',igst:'131',cgst:'0',sgst:'0',cess:'0'},rates:[18,12,5,12,18,18,18,18],q7_mapped_empty:true});
 // Reprocess actual downloaded bytes, not an HTTP workbook fixture.
 const again=await request.post('/api/excel/process',{multipart:{file:{name:'reprocessed.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer},worksheet:'B2B',first_data_row:'7',invoice_col:'6',taxable_col:'9'}});
 expect(again.ok()).toBeTruthy();const resumed=await again.json();expect(resumed.rows).toHaveLength(8);
 await page.getByRole('button',{name:'Process another',exact:true}).click();
 await page.getByRole('button',{name:'reprocessed.xlsx (open)',exact:true}).click();
 await request.post(`/__audit/expire/${resumed.review_id}`);
 await page.getByRole('button',{name:'Reload review',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('not found or expired');
 await expect(page.getByRole('button',{name:'Generate Excel',exact:true})).toBeDisabled();
 expect((await request.get(`/api/excel/reviews/${resumed.review_id}`)).status()).toBe(404);
 expect((await request.post(`/api/excel/reviews/${resumed.review_id}/generate`)).status()).toBe(404);
});

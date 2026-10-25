const {test,expect}=require('@playwright/test');

test('real local workbook: all rows visible, four reviews required, no decisions or final export',async({page,request})=>{
 const list=await request.get('/__audit/real-fixtures');const available=(await list.json()).count;
 test.skip(!available,'No real local workbook available; acceptance pending.');
 const source=await request.get('/__audit/real-fixture/0');expect(source.ok()).toBeTruthy();
 await page.goto('/?screen=workspace');
 const skip=page.getByRole('button',{name:'Skip introduction'});if(await skip.isVisible())await skip.click();
 await page.getByRole('button',{name:'Process Excel',exact:true}).click();
 await page.locator('input[type=file]').setInputFiles({name:'private-real-acceptance.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:await source.body()});
 await page.getByRole('button',{name:'Continue to processing'}).click();
 await page.getByRole('button',{name:'Calculate GST Rates',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Verify transactions before generating Excel'})).toBeVisible();
 const generate=page.getByRole('button',{name:'Generate Excel',exact:true});await expect(generate).toBeDisabled();
 const reviews=await request.get('/api/excel/reviews');const all=(await reviews.json()).reviews;
 const id=all.find(item=>item.filename==='private-real-acceptance.xlsx').review_id;
 const detail=await request.get('/api/excel/reviews/'+id);const view=await detail.json();
 expect(view.rows).toHaveLength(62);expect(view.progress.remaining).toBe(4);expect(view.decisions).toEqual({});
 // These expected rows characterize this supplied acceptance fixture only.
 const filter=page.getByLabel('Filter by verification status');
 await filter.selectOption('REVIEW_REQUIRED');
 await expect(page.locator('.data-table tbody tr')).toHaveCount(2);
 await expect(page.locator('.data-table tbody tr td:first-child')).toHaveText(['8','59']);
 await filter.selectOption('UNRESOLVED');
 await expect(page.locator('.data-table tbody tr td:first-child')).toHaveText(['20','45']);
 await filter.selectOption('ALL');
 let count=0;
 for(let n=0;n<7;n++){
  count+=await page.locator('.data-table tbody tr').count();
  const next=page.getByRole('button',{name:'Next page',exact:true});if(await next.isDisabled())break;await next.click();
 }
 expect(count).toBe(62);
 expect((await request.post(`/api/excel/reviews/${id}/generate`)).status()).toBe(409);
 await expect(generate).toBeDisabled();
 // Deliberately do not save CORRECT/WRONG, slabs, confirmations or a final workbook.
 const unchanged=await request.get('/api/excel/reviews/'+id);expect((await unchanged.json()).decisions).toEqual({});
});

const {test,expect}=require('@playwright/test');
const bad=/[\u00c2\u00c3\ufffd\u0080-\u009f]|\u00e2[\u0080-\u00bf\u2000-\u2122]/u;
async function openWorkspace(page){
 await page.goto('/?screen=workspace');
 const skip=page.getByRole('button',{name:'Skip introduction'});
 if(await skip.isVisible())await skip.click();
}
for(const width of [1280,390])test(`clean settings and upload copy at ${width}px`,async({page},testInfo)=>{
 await page.setViewportSize({width,height:900});await openWorkspace(page);
 if(width===390)await page.getByRole('button',{name:'Open navigation'}).click();
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 if(width===390)await expect.poll(()=>page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
 await expect(page.getByRole('heading',{name:'Calculation policy'})).toBeVisible();
 for(const text of ['Less than \u20b91','\u20b91 to less than \u20b950','\u20b950 or greater'])await expect(page.getByText(text,{exact:true})).toBeVisible();
 await expect(page.getByText('Workbook preservation',{exact:true})).toHaveCount(0);
 expect(await page.locator('body').innerText()).not.toMatch(/FastAPI|OpenPyXL|backend|Decimal based/i);
 expect(await page.locator('body').innerText()).not.toMatch(bad);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath(`settings-${width}.png`),fullPage:true,animations:'disabled'});
 if(width===390)await page.getByRole('button',{name:'Open navigation'}).click();
 await page.getByRole('button',{name:'Process Excel',exact:true}).click();
 if(width===390)await expect.poll(()=>page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
 await expect(page.getByText('Drop an Excel workbook here')).toBeVisible();
 await expect(page.getByRole('button',{name:'Browse files',exact:true})).toBeVisible();
 await expect(page.locator('.upload-meta')).toHaveCount(0);
 expect(await page.locator('body').innerText()).not.toMatch(/FastAPI|OpenPyXL|backend/i);
 expect(await page.locator('body').innerText()).not.toMatch(bad);
 for(const label of ['Upload','Column mapping','Process','Results'])await expect(page.locator('.step').filter({hasText:label})).toHaveCount(1);
 await page.screenshot({path:testInfo.outputPath(`upload-${width}.png`),fullPage:true,animations:'disabled'});
});
for(const width of [1280,390])test(`all workspace pages have clean copy at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});await openWorkspace(page);
 for(const name of ['Dashboard','Process Excel','Verification','Settings']){
  if(width===390)await page.getByRole('button',{name:'Open navigation'}).click();
  await page.getByRole('button',{name,exact:true}).click();
  if(width===390)await expect.poll(()=>page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await expect(page.getByRole('heading',{name,exact:true})).toBeVisible();
  expect(await page.locator('body').innerText()).not.toMatch(bad);
  expect(await page.locator('body').innerText()).not.toMatch(/FastAPI|OpenPyXL|backend/i);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 }
});
test('filename and uploaded cell text are displayed unchanged',async({page})=>{
 const original='Source-\u00c2\u00b7.xlsx',cell='Original \u00c3 text';
 await page.route('**/api/excel/inspect',route=>route.fulfill({json:{filename:original,size_bytes:12,max_upload_bytes:20971520,sheets:[{
  name:'Sheet',max_row:2,max_column:3,detected:{invoice_col:1,taxable_col:2,invoice_header_row:1,taxable_header_row:1},existing_rate:null,
  columns:[{index:1,letter:'A',header:'Invoice Value'},{index:2,letter:'B',header:'Taxable Value'},{index:3,letter:'C',header:'Description'}],
  preview:[{excel_row:2,values:[118,100,cell]}]
 }]}}));
 await openWorkspace(page);await page.getByRole('button',{name:'Process Excel',exact:true}).click();
 await page.locator('input[type=file]').setInputFiles({name:original,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('synthetic')});
 await expect(page.getByText(cell,{exact:true})).toBeVisible();
 await expect(page.locator('.file-chip')).toHaveText(original);
});

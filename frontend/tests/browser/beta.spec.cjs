const {test,expect}=require('@playwright/test');
const file={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',output_filename:'updated_audit.xlsx',original_filename:'audit.xlsx',file_size:2048,created_at:'2026-10-01T10:00:00Z',expires_at:'2026-10-31T10:00:00Z',verification_count:2,processing_summary:{}};
const list={files:[file],total:1,retention_days:30};
test('My Files search, sorting, download and confirmed deletion',async({page})=>{
 const queries=[];let deleted=false;
 await page.route('**/api/files**',async route=>{
  const request=route.request();
  if(request.method()==='DELETE'){deleted=true;return route.fulfill({json:{deleted:true,queued:false}});}
  if(request.url().includes('/download'))return route.fulfill({body:'synthetic workbook'});
  queries.push(request.url());return route.fulfill({json:deleted?{...list,files:[],total:0}:list});
 });
 await page.goto('/');await expect(page.getByText(file.output_filename,{exact:true})).toBeVisible();
 await page.getByLabel('Search filenames').fill('audit');await page.getByRole('button',{name:'Search',exact:true}).click();
 await expect.poll(()=>queries.some(url=>url.includes('search=audit'))).toBe(true);
 await page.getByLabel('Sort files').selectOption('size');await expect.poll(()=>queries.some(url=>url.includes('sort=size'))).toBe(true);
 const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Download '+file.output_filename,exact:true}).click();expect((await downloaded).suggestedFilename()).toBe(file.output_filename);
 await page.getByRole('button',{name:'Delete '+file.output_filename,exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();
 await page.getByRole('button',{name:'Delete file',exact:true}).click();await expect(page.getByText('No matching files')).toBeVisible();expect(deleted).toBe(true);
});
test('My Files loading, error and empty states',async({page})=>{
 let respond;await page.route('**/api/files?**',async route=>{await new Promise(resolve=>{respond=()=>resolve();});await route.fulfill({status:503,json:{detail:'Private storage unavailable'}});});
 await page.goto('/');await expect(page.getByText('Loading your files…')).toBeVisible();respond();await expect(page.getByRole('alert')).toHaveText('Private storage unavailable');
 await page.unroute('**/api/files?**');await page.route('**/api/files?**',route=>route.fulfill({json:{...list,files:[],total:0}}));
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page.getByText('No saved workbooks yet')).toBeVisible();
});
test('My Files pagination and mobile layout',async({page})=>{
 const queries=[];await page.route('**/api/files?**',route=>{queries.push(route.request().url());return route.fulfill({json:{...list,total:21}});});
 await page.setViewportSize({width:390,height:844});await page.goto('/');await expect(page.getByText(file.output_filename,{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Next',exact:true}).click();await expect.poll(()=>queries.some(url=>url.includes('offset=20'))).toBe(true);
 await page.getByLabel('Open navigation').click();await expect(page.locator('.app-sidebar')).toHaveClass(/open/);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
for(const status of ['pending','rejected','revoked'])test(`approval gate blocks ${status} users`,async({page})=>{
 await page.goto('/?screen=gate&status='+status);await expect(page.getByText('Approved workspace content')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Check approval status'})).toBeVisible();
});
test('owner decisions require confirmation and preserve the expected prior status',async({page})=>{
 let applicant={user_id:file.id,is_owner:false,full_name:'Test Auditor',verified_email:'verified@example.com',registered_at:file.created_at,status:'pending',decided_at:null,decided_by:null};const actions=[];
 await page.route('**/api/admin/approvals**',route=>{
  if(route.request().method()==='POST'){const body=route.request().postDataJSON();actions.push(body);applicant={...applicant,status:body.status};return route.fulfill({json:{status:body.status}});}
  return route.fulfill({json:{counts:{total:1,pending:1,approved:0,rejected:0,revoked:0},filtered_total:1,users:[applicant],notifications:{pending:0,needs_review:0}}});
 });
 await page.goto('/?screen=admin');await page.getByRole('button',{name:'Approve',exact:true}).click();expect(actions).toHaveLength(0);
 await page.getByRole('button',{name:'Approve account',exact:true}).click();await expect(page.getByRole('button',{name:'Revoke',exact:true})).toBeVisible();
 expect(actions[0]).toEqual({status:'approved',expected_status:'pending'});
 await page.getByRole('button',{name:'Revoke',exact:true}).click();await page.getByRole('button',{name:'Revoke access',exact:true}).click();await expect(page.getByRole('button',{name:'Approve',exact:true})).toBeVisible();expect(actions[1]).toEqual({status:'revoked',expected_status:'approved'});
 applicant={...applicant,status:'pending'};await page.reload();await page.getByRole('button',{name:'Reject',exact:true}).click();await page.getByRole('button',{name:'Reject account',exact:true}).click();await expect(page.getByRole('button',{name:'Approve',exact:true})).toBeVisible();expect(actions[2]).toEqual({status:'rejected',expected_status:'pending'});
});
test('login remains public and approval refresh opens then removes the workspace',async({page})=>{
 let login;await page.route('**/test-auth/login',route=>{login=route.request().postDataJSON();return route.fulfill({json:{}});});
 await page.route('**/api/files?**',route=>route.fulfill({json:{...list,files:[],total:0}}));
 await page.goto('/?screen=login');await page.getByLabel('Email address').fill('auditor@example.com');await page.getByLabel('Password',{exact:true}).fill('synthetic-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page).toHaveURL('http://127.0.0.1:3199/');expect(login.email).toBe('auditor@example.com');
 let status='approved';await page.route('**/api/account/approval',route=>route.fulfill({json:{ready:true,status,email_verified:true,is_admin:false}}));
 await page.goto('/?screen=gate&status=pending');await page.getByRole('button',{name:'Check approval status'}).click();await expect(page.getByText('Approved workspace content')).toBeVisible();
 status='revoked';await page.evaluate(()=>window.dispatchEvent(new Event('approval-required')));await expect(page.getByText('Approved workspace content')).toHaveCount(0);await expect(page.getByRole('heading',{name:'Access revoked',exact:true})).toBeVisible();
});
test('public registration requests verification and regular account hides admin navigation',async({page})=>{
 let signup;await page.route('**/test-auth/**',route=>{if(route.request().url().endsWith('/register'))signup=route.request().postDataJSON();return route.fulfill({json:{}});});
 await page.goto('/?screen=register');await page.getByLabel('Full name').fill('Beta Auditor');await page.getByLabel('Email address').fill('auditor@example.com');await page.getByLabel('Password',{exact:true}).fill('synthetic-password-123');await page.getByLabel('Confirm password').fill('synthetic-password-123');await page.getByRole('button',{name:'Create account',exact:true}).click();await expect(page.getByText(/Check your email for a verification link/)).toBeVisible();expect(signup.options.data).toEqual({full_name:'Beta Auditor'});
 await page.goto('/?screen=account');await expect(page.getByRole('link',{name:'Administration'})).toHaveCount(0);await expect(page.getByText('Test Auditor',{exact:true})).toHaveCount(1);await page.locator('summary.account-trigger').click();await expect(page.getByRole('link',{name:'My Files'})).toBeVisible();await page.getByRole('button',{name:'Sign out'}).click();await expect(page).toHaveURL(/\/login$/);
});
test('Excel upload and mapping retain read-only notice and honest history failure message',async({page})=>{
 const columns=[{index:1,letter:'A',header:'Invoice Value'},{index:2,letter:'B',header:'Taxable Value'}];
 await page.route('**/api/excel/inspect',route=>route.fulfill({json:{filename:'audit.xlsx',size_bytes:10,max_upload_bytes:20971520,source_info:{read_only_detected:true},sheets:[{name:'Sheet',max_row:2,max_column:2,detected:{invoice_col:1,taxable_col:2,invoice_header_row:1,taxable_header_row:1},existing_rate:null,columns,preview:[{excel_row:1,values:['Invoice Value','Taxable Value']},{excel_row:2,values:[105,100]}]}]}}));
 const generated={file_id:file.id,filename:file.output_filename,worksheet:'Sheet',history:{saved:false,warning:'Permanent save could not be confirmed. Use the current-session download.'},summary:{total:1,matched:1,rate_counts:{5:1,12:0,18:0,28:0},review_required:0,unmatched:0,status_counts:{}},column_totals:{worksheet:'Sheet',columns:{invoice:{label:'Invoice Value',source_column:1,total:'105.00',blank_count:0,invalid_count:0},taxable:{label:'Taxable Value',source_column:2,total:'100.00',blank_count:0,invalid_count:0}},included_rows:[2],excluded_rows:[],issues:[],warnings:[],output:{worksheet:'Sheet',mode:'grand_total_row',row:3}},rows:[],verification:[],rate_column:{letter:'C',index:3}};
 await page.route('**/api/excel/process',route=>route.fulfill({json:{review_id:file.id,filename:'audit.xlsx',worksheet:'Sheet',version:1,state:'open',rows:[],excluded_rows:[],decisions:{},progress:{total:1,matched:1,requiring_review:0,verified:0,remaining:0},result:null}}));
 await page.route('**/api/excel/reviews/'+file.id+'/generate',route=>route.fulfill({json:generated}));
 await page.route('**/api/excel/download/**',route=>route.fulfill({body:'synthetic workbook'}));
 await page.goto('/?screen=workspace');await page.getByRole('button',{name:'Process Excel',exact:true}).click();
 await page.locator('input[type=file]').setInputFiles({name:'audit.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('synthetic')});
 await expect(page.getByText(/Read-only source detected/)).toBeVisible();await page.getByRole('button',{name:'Continue to processing'}).click();await page.getByRole('button',{name:'Calculate GST Rates',exact:true}).click();await page.getByRole('button',{name:'Generate Excel',exact:true}).click();await expect(page.getByText(/Permanent save could not be confirmed/)).toBeVisible();
 await expect(page.getByRole('heading',{name:'GST Column Totals'})).toBeVisible();await expect(page.getByText('\u20b9105.00',{exact:true})).toBeVisible();
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download Updated Excel',exact:true}).click();await download;
});


for(const decision of ['approved','rejected'])test(`email ${decision} confirmation is safe on open and mobile`,async({page})=>{
 const actions=[];
 let applicant={user_id:file.id,is_owner:false,full_name:'Test Auditor',verified_email:'verified@example.com',registered_at:file.created_at,status:'pending',decided_at:null,decided_by:null};
 await page.route('**/api/admin/approvals/**',route=>{
  if(route.request().method()==='POST'){
   const body=route.request().postDataJSON();actions.push(body);applicant={...applicant,status:body.status};
  }
  return route.fulfill({json:applicant});
 });
 await page.setViewportSize({width:390,height:844});
 await page.goto('/?screen=email-action&decision='+decision);
 await expect(page.getByText('verified@example.com',{exact:true})).toBeVisible();
 expect(actions).toHaveLength(0);
 await page.getByRole('button',{name:decision==='approved'?'Confirm approval':'Confirm rejection',exact:true}).click();
 await expect(page.getByText(/Your decision has been recorded/)).toBeVisible();
 expect(actions).toEqual([{status:decision,expected_status:'pending'}]);
 await expect(page.getByRole('button',{name:/Confirm approval|Confirm rejection/})).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

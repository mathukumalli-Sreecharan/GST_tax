const {test,expect}=require('@playwright/test');

test('account selection routes to sign-in and registration, with recovery and back links',async({page})=>{
 await page.goto('/?screen=auth');
 await expect(page.getByRole('heading',{name:'GST reconciliation, reimagined.'})).toBeVisible();
 await expect(page.getByRole('link',{name:/Welcome Back/})).toHaveAttribute('href','/login');
 await expect(page.getByRole('link',{name:/Get Started/})).toHaveAttribute('href','/register');
 await page.getByRole('link',{name:/Welcome Back/}).click();
 await expect(page.getByRole('heading',{name:'Welcome back',exact:true})).toBeVisible();
 await expect(page.getByLabel('Email address')).toBeVisible();
 await expect(page.getByLabel('Password',{exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:'Back to account selection'})).toHaveAttribute('href','/');
 await page.getByRole('link',{name:'Forgot password?'}).click();
 await expect(page.getByRole('heading',{name:'Reset your password'})).toBeVisible();
 await page.getByRole('link',{name:'Return to sign in'}).click();
 await expect(page.getByRole('heading',{name:'Welcome back',exact:true})).toBeVisible();
 await page.goto('/?screen=auth');
 await page.getByRole('link',{name:/Get Started/}).click();
 await expect(page.getByRole('heading',{name:'Create your account'})).toBeVisible();
 await expect(page.getByLabel('Full name')).toBeVisible();
 await expect(page.getByRole('link',{name:'Back to account selection'})).toHaveAttribute('href','/');
 await expect(page.getByRole('link',{name:'Already have an account? Sign in'})).toHaveAttribute('href','/login');
});

test('account choices remain readable and tappable on a narrow mobile viewport',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.goto('/?screen=auth');
 await expect(page.getByRole('link',{name:/Welcome Back/})).toBeVisible();
 await expect(page.getByRole('link',{name:/Get Started/})).toBeVisible();
 const widths=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
 expect(widths.scroll).toBeLessThanOrEqual(widths.client);
});

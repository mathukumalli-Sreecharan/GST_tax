const {defineConfig}=require('@playwright/test');
module.exports=defineConfig({
 testDir:'./tests/browser',testMatch:'**/*.spec.cjs',workers:1,fullyParallel:false,
 use:{baseURL:'http://127.0.0.1:3199',headless:true,launchOptions:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}},
 webServer:{command:'node tests/browser/server.cjs',url:'http://127.0.0.1:3199',reuseExistingServer:false},
 reporter:'list',globalTeardown:'./tests/browser/teardown.cjs'
});

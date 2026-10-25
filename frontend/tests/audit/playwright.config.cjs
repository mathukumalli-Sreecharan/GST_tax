const {defineConfig}=require('@playwright/test');
const path=require('node:path');
const frontend=path.resolve(__dirname,'../..');
module.exports=defineConfig({
 testDir:__dirname,testMatch:'*.spec.cjs',workers:1,timeout:60000,
 use:{baseURL:'http://127.0.0.1:3199',headless:true},
 webServer:[
  {command:'.\\env\\Scripts\\python.exe -m tests.audit_server',cwd:path.resolve(frontend,'..'),url:'http://127.0.0.1:3198/api/health',reuseExistingServer:false},
  {command:'node tests/browser/server.cjs',cwd:frontend,url:'http://127.0.0.1:3199',reuseExistingServer:false,env:{GST_AUDIT_REAL_API:'1'}}
 ],reporter:'list',globalTeardown:path.join(__dirname,'teardown.cjs')
});

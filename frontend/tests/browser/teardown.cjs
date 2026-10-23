// Close only our loopback-only component harness before Playwright's process
// cleanup. This avoids Windows sandbox restrictions on taskkill /T.
module.exports=async()=>{
 try{await fetch('http://127.0.0.1:3199/__shutdown',{signal:AbortSignal.timeout(2000)});}catch{/* Already stopped. */}
};

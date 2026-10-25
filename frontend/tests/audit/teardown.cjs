module.exports=async()=>{
 for(const url of ['http://127.0.0.1:3199/__shutdown','http://127.0.0.1:3198/__audit/shutdown']){
  try{await fetch(url,{signal:AbortSignal.timeout(2000)});}catch{/* Already stopped. */}
 }
};

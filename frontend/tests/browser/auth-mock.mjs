export function browserClient(){return {auth:{
 signUp:async input=>{await fetch('/test-auth/register',{method:'POST',body:JSON.stringify(input)});return {error:null};},
 signInWithPassword:async input=>{await fetch('/test-auth/login',{method:'POST',body:JSON.stringify(input)});return {error:null};},
 signOut:async()=>{await fetch('/test-auth/logout',{method:'POST'});return {error:null};},
 getUser:async()=>({data:{user:{id:'test-user'}}}),
 onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})
}};}

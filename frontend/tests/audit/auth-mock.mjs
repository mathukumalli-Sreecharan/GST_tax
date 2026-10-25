// Only the loopback audit harness uses this test principal. No live auth service.
import {browserClient as componentClient} from '../browser/auth-mock.mjs';
export function browserClient(){return {auth:{...componentClient().auth,
 getSession:async()=>({data:{session:{access_token:'local-audit-test-token'}}}),
 refreshSession:async()=>({data:{session:{access_token:'local-audit-test-token'}}})
}};}

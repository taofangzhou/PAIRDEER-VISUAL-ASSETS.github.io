import {identity,fail,bindings} from '@/lib/server';
export async function GET(){try{const w=await identity();return Response.json({signedIn:!!w.user,admin:w.admin,claimed:w.claimed,email:w.user?.email,storage:bindings.ALIYUN_SIGNER_URL?'aliyun':'cloud'},{headers:{'Cache-Control':'no-store'}})}catch(e){return fail(e)}}

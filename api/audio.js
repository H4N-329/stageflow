import { createHash, timingSafeEqual } from 'node:crypto';
const bucket='stageflow-audio';
const ok=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const validId=id=>/^[a-f0-9-]{36}$/i.test(id||'');
async function supa(path,options={}){
 const base=process.env.SUPABASE_URL?.replace(/\/$/,'');const key=process.env.SUPABASE_SECRET_KEY;
 if(!base||!key)throw Error('Supabase is not configured');
 const r=await fetch(base+path,{...options,headers:{apikey:key,Authorization:`Bearer ${key}`,...options.headers}});
 const body=await r.text();let data;try{data=JSON.parse(body)}catch{data={error:body.slice(0,200)}};
 if(!r.ok)throw Error(`Storage ${r.status}: ${data.message||data.error||'failed'}`);
 return data;
}
async function authorize(id,key){
 if(!/^[a-f0-9]{64}$/i.test(key||''))return false;
 const rows=await supa(`/rest/v1/stageflow_showcases?id=eq.${id}&select=edit_hash`);
 if(!rows.length)return false;
 const expected=Buffer.from(rows[0].edit_hash,'hex'),actual=Buffer.from(createHash('sha256').update(key).digest('hex'),'hex');
 return expected.length===actual.length&&timingSafeEqual(expected,actual);
}
export default {async fetch(req){
 try{
  const u=new URL(req.url),id=u.searchParams.get('id');if(!validId(id))return ok({error:'作品IDが不正です'},400);
  const path=`${bucket}/${id}/showcase.mp3`;
  if(req.method==='POST'){
   if(!(await authorize(id,req.headers.get('X-Edit-Key'))))return ok({error:'編集権限がありません'},403);
   const size=Number(req.headers.get('X-File-Size'));
   if(!Number.isSafeInteger(size)||size<1||size>50*1024*1024)return ok({error:'MP3は50MB以下にしてください'},413);
   const result=await supa(`/storage/v1/object/upload/sign/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({upsert:true})});
   return ok({uploadUrl:`${process.env.SUPABASE_URL.replace(/\/$/,'')}/storage/v1${result.url}`,maxBytes:50*1024*1024});
  }
  if(req.method==='GET'){
   const rows=await supa(`/rest/v1/stageflow_showcases?id=eq.${id}&select=content`);
   if(!rows.length)return ok({error:'作品がありません'},404);
   if(!rows[0].content?.audioCloud)return ok({error:'クラウド音源がありません'},404);
   const signed=await supa(`/storage/v1/object/sign/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expiresIn:3600})});
   return ok({url:`${process.env.SUPABASE_URL.replace(/\/$/,'')}/storage/v1${signed.signedURL}`});
  }
  return ok({error:'Method not allowed'},405);
 }catch(e){console.error('audio API',e);return ok({error:'音源ストレージを利用できません。設定・アップロード状況を確認してください。'},500)}
}};

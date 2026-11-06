import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

function reply(data, status = 200) {
  return Response.json(data, { status, headers: {'Cache-Control':'no-store'} });
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function validId(v) { return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v||''); }
function validateProject(data) {
  if(!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const s=data.stage, ds=data.dancers, ks=data.keyframes;
  if(!s || !Array.isArray(ds) || ds.length > 30 || !Array.isArray(ks) || ks.length < 1 || ks.length > 180) return false;
  if(![s.width,s.depth,s.spacing,s.safeDistance,data.duration].every(Number.isFinite)) return false;
  if(s.width<2 || s.width>40 || s.depth<2 || s.depth>30 || s.spacing<0.25 || s.spacing>5 || s.safeDistance<0.3 || s.safeDistance>3 || data.duration<1 || data.duration>600) return false;
  if(!['bottom','top'].includes(s.front)) return false;
  const ids = new Set();
  for(const d of ds) {
    if(!d || typeof d.id!=='string' || !/^[a-z0-9_-]{1,70}$/i.test(d.id) || ids.has(d.id) || typeof d.name!=='string' || d.name.length>32 || !/^#[0-9a-f]{6}$/i.test(d.color)) return false;
    ids.add(d.id);
  }
  const times = new Set();
  for(const k of ks) {
    if(!Number.isInteger(k.t) || k.t<0 || k.t>data.duration || times.has(k.t) || !k.positions || typeof k.positions!=='object') return false;
    times.add(k.t);
    for(const id of ids){ const p=k.positions[id]; if(!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x)>s.width/2+0.001 || p.y<0 || p.y>s.depth) return false; }
  }
  return times.has(0);
}
async function db(query, {method='GET', body, returnRepresentation=false}={}){
  const url=process.env.SUPABASE_URL, key=process.env.SUPABASE_SECRET_KEY;
  if(!url || !key) throw new Error('Server environment is not configured');
  const res=await fetch(`${url.replace(/\/$/,'')}/rest/v1/stageflow_showcases${query}`, {
    method,
    headers:{'apikey':key,'Content-Type':'application/json',...(returnRepresentation ? {'Prefer':'return=representation'} : {})},
    body:body === undefined ? undefined : JSON.stringify(body)
  });
  const text=await res.text();
  if(!res.ok){ console.error('Database status:',res.status); throw new Error(`Database error (${res.status})`); }
  return text ? JSON.parse(text) : null;
}
export default {
  async fetch(request) {
    try {
      const url=new URL(request.url);
      if(request.method==='GET'){
        const id=url.searchParams.get('id');
        if(!validId(id)) return reply({error:'不正な作品IDです'},400);
        const rows=await db(`?id=eq.${encodeURIComponent(id)}&select=id,title,content,updated_at`);
        if(!rows?.length) return reply({error:'作品が見つかりません'},404);
        const r=rows[0]; return reply({id:r.id,title:r.title,data:r.content,updatedAt:r.updated_at});
      }
      if(!['POST','PUT'].includes(request.method)) return reply({error:'Method not allowed'},405);
      const raw=await request.text();
      if(raw.length>240000) return reply({error:'データが大きすぎます'},413);
      let body;
      try { body=JSON.parse(raw); } catch { return reply({error:'JSONが不正です'},400); }
      if(!validateProject(body.data)) return reply({error:'作品データが正しくありません'},400);
      const title=String(body.title||'無題のショーケース').trim().slice(0,100)||'無題のショーケース';
      if(request.method==='POST') {
        const id=randomUUID(), editKey=randomBytes(32).toString('hex');
        await db('',{method:'POST', body:{id,title,content:body.data,edit_hash:sha256(editKey)},returnRepresentation:true});
        return reply({id,editKey},201);
      }
      const id=url.searchParams.get('id'), secret=request.headers.get('X-Edit-Key') || '';
      if(!validId(id) || !/^[a-f0-9]{64}$/i.test(secret)) return reply({error:'編集権限がありません'},403);
      const rows=await db(`?id=eq.${encodeURIComponent(id)}&select=edit_hash`);
      if(!rows?.length) return reply({error:'作品が見つかりません'},404);
      const expected=Buffer.from(rows[0].edit_hash||'','hex'), actual=Buffer.from(sha256(secret),'hex');
      if(expected.length!==actual.length || !timingSafeEqual(expected,actual)) return reply({error:'編集権限がありません'},403);
      await db(`?id=eq.${encodeURIComponent(id)}`,{method:'PATCH', body:{title,content:body.data,updated_at:new Date().toISOString()}});
      return reply({id,updatedAt:new Date().toISOString()});
    } catch (err) {
      console.error('StageFlow API:',err.message);
      return reply({error:'サーバーで処理できませんでした。Supabase設定を確認してください。'},500);
    }
  }
};

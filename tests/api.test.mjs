import test from 'node:test';
import assert from 'node:assert/strict';
import api from '../api/projects.js';

const records = new Map();
process.env.SUPABASE_URL = 'https://mock.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_for_mock_only';
globalThis.fetch = async (url, opts={}) => {
  assert.equal(opts.headers.apikey, process.env.SUPABASE_SECRET_KEY);
  const request = new URL(url);
  const id = request.searchParams.get('id')?.replace('eq.','');
  if(opts.method==='POST') {
    const row=JSON.parse(opts.body);records.set(row.id,row);return Response.json([row],{status:201});
  }
  if(opts.method==='PATCH') {
    const row=records.get(id);
    if(!row)return Response.json([]);
    Object.assign(row,JSON.parse(opts.body));return new Response(null,{status:204});
  }
  const row=records.get(id);
  if(!row)return Response.json([]);
  const fields=(request.searchParams.get('select')||'').split(',');
  return Response.json([Object.fromEntries(fields.map(k=>[k,row[k]]))]);
};
const p = {
  version:1,title:'テスト',stage:{width:12,depth:8,spacing:1,safeDistance:0.7,front:'bottom',grid:true,paths:true},duration:24,
  dancers:[{id:'d_one',name:'A',color:'#112233'}],keyframes:[{t:0,positions:{d_one:{x:0,y:4}}},{t:8,positions:{d_one:{x:1,y:5}}}]
};
const call = (method,url,body,headers={}) => api.fetch(new Request('https://stageflow.test'+url,{method,headers:{'Content-Type':'application/json',...headers},body:body ? JSON.stringify(body):undefined}));

test('publish, read, forbidden edit, authorized edit',async()=>{
  const published = await call('POST','/api/projects',{title:'最初',data:p});
  assert.equal(published.status,201);
  const {id,editKey}=await published.json();assert.match(id,/^[\da-f-]{36}$/);assert.equal(editKey.length,64);
  const read = await call('GET',`/api/projects?id=${id}`);
  assert.equal(read.status,200);
  assert.equal((await read.json()).title,'最初');
  const forbidden = await call('PUT',`/api/projects?id=${id}`,{title:'破壊',data:p},{'X-Edit-Key':'0'.repeat(64)});
  assert.equal(forbidden.status,403);
  const permitted = await call('PUT',`/api/projects?id=${id}`,{title:'更新',data:p},{'X-Edit-Key':editKey});
  assert.equal(permitted.status,200);
  const final = await call('GET',`/api/projects?id=${id}`);
  assert.equal((await final.json()).title,'更新');
});
test('reject oversized dancer count', async()=>{
  const invalid=structuredClone(p);
  invalid.dancers=Array.from({length:31},(_,i)=>({id:`d_${i}`,name:'n',color:'#112233'}));
  const response=await call('POST','/api/projects',{title:'too many',data:invalid});
  assert.equal(response.status,400);
});

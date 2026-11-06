const $ = id => document.getElementById(id);
const COLORS = ['#5be9d0','#ffbd77','#b9a5ff','#ff8da8','#86ccff','#c6ec83','#ff97e1','#e8d385','#8be1b6','#c6b6fc'];
const STORAGE = 'stageflow.projects.v1';
const BAMI_METERS = 0.9;
const ACTIVE = 'stageflow.active.v1';
const clamp = (n,min,max) => Math.min(max,Math.max(min,n));
const round = (n,p=2) => Math.round(n * 10**p)/10**p;
const uid = () => 'd_' + (crypto.randomUUID ? crypto.randomUUID().replaceAll('-','') : Math.random().toString(36).slice(2));
const clone = value => JSON.parse(JSON.stringify(value));
const esc = value => String(value ?? '').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const fmtTime = t => `${String(Math.floor(t/60)).padStart(2,'0')}:${String(Math.floor(t%60)).padStart(2,'0')}`;
let audioUrl=null, audioLength=0, pendingAudioFile=null, audioLoadSequence=0;
let entries=[], entry=null, selectedId=null, currentTime=0, playing=false, playStart=0, playOrigin=0, raf=0, dragId=null, cloudJobs=new Map(), initialLoading=false, toastTimer=0;

function blankProject(){return {version:1,title:'新しいショーケース',stage:{width:14,depth:9,spacing:1,safeDistance:0.8,unit:'bami',front:'bottom',grid:true,paths:true},duration:32,dancers:[],keyframes:[{t:0,positions:{}}]};}
function demoProject(){
  const p=blankProject();p.title='サンプル：ダンスショーケース';
  const names=['Aki','Haru','Mio','Ren','Sora','Yui'];
  const coords=[[-3,2],[-1.8,2],[1.8,2],[3,2],[-1,5],[1,5]];
  p.dancers=names.map((name,i)=>({id:`demo${i}`,name,color:COLORS[i]}));
  p.keyframes=[
    {t:0,positions:Object.fromEntries(p.dancers.map((d,i)=>[d.id,{x:coords[i][0],y:coords[i][1]}]))},
    {t:8,positions:Object.fromEntries(p.dancers.map((d,i)=>[d.id,{x:(i-2.5)*1.35,y:3.6+(i%2)*0.3}]))},
    {t:16,positions:Object.fromEntries(p.dancers.map((d,i)=>[d.id,{x:(i%3-1)*2.2,y:i<3?2:5.7}]))}
  ];return p;
}
function migrateBami(p){
  if(!p?.stage || p.stage.unit==='bami')return p;
  const s=p.stage;
  s.width=clamp(Math.round(s.width/BAMI_METERS),2,40);
  s.depth=clamp(Math.round(s.depth/BAMI_METERS),2,30);
  s.safeDistance=round((s.safeDistance||0.7)/BAMI_METERS);
  s.spacing=1;s.unit='bami';
  for(const k of p.keyframes||[])for(const v of Object.values(k.positions||{})){
    v.x=round(clamp(v.x/BAMI_METERS,-s.width/2,s.width/2));
    v.y=round(clamp(v.y/BAMI_METERS,0,s.depth));
  }
  return p;
}
function validateLocal(p){
  migrateBami(p);
  if(!p || !p.stage || !Array.isArray(p.dancers) || !Array.isArray(p.keyframes) || p.dancers.length>30 || p.keyframes.length<1 || p.keyframes.length>180)throw Error('ファイルの形式が違うか、人数・登録時刻が上限を超えています');
  const s=p.stage;
  if(!Number.isFinite(s.width)||s.width<2||s.width>40||!Number.isFinite(s.depth)||s.depth<2||s.depth>30||!Number.isFinite(s.spacing)||s.spacing<0.25||s.spacing>5)throw Error('ステージ設定が正しくありません');
  if(!Number.isFinite(s.safeDistance))s.safeDistance=.8;
  s.spacing=1;
  if(!['top','bottom'].includes(s.front))s.front='bottom';
  if(!Number.isInteger(p.duration)||p.duration<1||p.duration>600)throw Error('再生時間は1〜600秒です');
  if(!p.dancers.every(d=>typeof d.id==='string' && /^[\w-]{1,70}$/.test(d.id) && typeof d.name==='string' && d.name.length<=32 && /^#[\da-f]{6}$/i.test(d.color)))throw Error('出演者データが正しくありません');
  if(new Set(p.dancers.map(d=>d.id)).size!==p.dancers.length)throw Error('出演者IDが重複しています');
  const ts=new Set();
  for(const k of p.keyframes){
    if(!Number.isInteger(k.t)||k.t<0||k.t>p.duration||ts.has(k.t)||!k.positions)throw Error('時刻データが正しくありません');ts.add(k.t);
    for(const d of p.dancers){const v=k.positions[d.id];if(!v||!Number.isFinite(v.x)||!Number.isFinite(v.y)||Math.abs(v.x)>s.width/2+0.001||v.y<0||v.y>s.depth)throw Error('立ち位置データが正しくありません');}
  }
  if(!ts.has(0))throw Error('0秒の立ち位置が必要です');
  p.keyframes.sort((a,b)=>a.t-b.t);
  return p;
}
function loadEntries(){try{entries=JSON.parse(localStorage.getItem(STORAGE))||[];}catch{entries=[];}if(!Array.isArray(entries))entries=[];}
function saveEntries(){try{localStorage.setItem(STORAGE,JSON.stringify(entries));localStorage.setItem(ACTIVE,entry?.localId||'');}catch{setStatus('ローカル保存に失敗');}}
function setStatus(value){$('saveStatus').textContent=value;}
function editable(){return !entry?.remoteId || !!entry.editKey;}
function stopPlayback(){playing=false;cancelAnimationFrame(raf);$('showcaseAudio').pause();$('playButton').textContent='▶';}
function syncAudioPosition(){const a=$('showcaseAudio');if(a.src && Number.isFinite(a.duration))a.currentTime=Math.min(currentTime,a.duration);}
function resetAudio(){audioLoadSequence++;pendingAudioFile=null;stopPlayback();if(audioUrl)URL.revokeObjectURL(audioUrl);audioUrl=null;audioLength=0;const a=$('showcaseAudio');a.removeAttribute('src');a.load();$('audioFile').value='';$('audioStatus').textContent='未選択';}

function commit({redraw=true,remote=true}={}){
  if(!entry || !editable())return;
  entry.project.title = $('projectTitle').value.trim().slice(0,100)||'無題のショーケース';
  entry.updatedAt=Date.now();saveEntries();
  setStatus(entry.remoteId?'端末に保存済み・同期待ち':'端末に自動保存済み');
  if(redraw)renderAll();
  if(remote && entry.remoteId && entry.editKey)scheduleCloud();
}
function scheduleCloud(){
  const target=entry;if(!target?.remoteId || !target.editKey)return;
  const job=cloudJobs.get(target.localId)||{dirty:false,running:false,timer:0};cloudJobs.set(target.localId,job);
  job.dirty=true;clearTimeout(job.timer);job.timer=setTimeout(()=>syncCloud(target),1500);
}
async function syncCloud(target){
  const job=cloudJobs.get(target.localId);
  if(!job || !target.remoteId || !target.editKey || !job.dirty || job.running)return;
  job.running=true;job.dirty=false;
  const body={title:target.project.title,data:clone(target.project)};
  if(entry===target)setStatus('クラウド同期中…');
  try{
    const res=await fetch(`/api/projects?id=${encodeURIComponent(target.remoteId)}`,{method:'PUT',headers:{'Content-Type':'application/json','X-Edit-Key':target.editKey},body:JSON.stringify(body)});
    const data=await res.json();if(!res.ok)throw Error(data.error||`同期失敗 ${res.status}`);
    if(entry===target)setStatus(job.dirty?'同期待ち':'クラウド保存済み');
  }catch(e){if(entry===target){setStatus('クラウド同期失敗');toast('クラウド保存に失敗：'+e.message);}}
  finally{job.running=false;if(job.dirty)job.timer=setTimeout(()=>syncCloud(target),600);}
}
function activate(e,{url=true}={}){
  resetAudio();entry=e;currentTime=0;selectedId=null;saveEntries();if(url){try{history.replaceState(null,'',location.pathname);}catch{}}
  $('projectTitle').value=e.project.title;
  setStatus(e.remoteId ? (e.editKey?'共有済み（編集可）':'閲覧専用'):'端末に自動保存済み');
  renderAll();
  if(e.remoteId && e.project.audioCloud)loadCloudAudio(e);
}
function createNew({demo=false}={}){const e={localId:uid(),project:demo?demoProject():blankProject(),updatedAt:Date.now()};entries.unshift(e);activate(e);toast(demo?'サンプルを開きました':'新しい作品を作成しました');}
function duplicate(){const e={localId:uid(),project:clone(entry.project),updatedAt:Date.now()};e.project.title+='（コピー）';entries.unshift(e);activate(e);toast('編集可能なコピーを作成しました');}
function keyframeAt(t=currentTime){return entry.project.keyframes.find(k=>k.t===Math.round(t));}
function intervalAt(t=currentTime){
  const frames=entry.project.keyframes;
  let prev=frames[0],next=frames[frames.length-1];
  for(let i=0;i<frames.length;i++){
    if(frames[i].t<=t)prev=frames[i];
    if(frames[i].t>=t){next=frames[i];break;}
  }
  return {prev,next};
}
function interpolate(t=currentTime){
  const {prev,next}=intervalAt(t), ratio=next.t===prev.t?0:clamp((t-prev.t)/(next.t-prev.t),0,1), output={};
  for(const d of entry.project.dancers){
    const a=prev.positions[d.id]||{x:0,y:0},b=next.positions[d.id]||a;
    output[d.id]={x:a.x+(b.x-a.x)*ratio,y:a.y+(b.y-a.y)*ratio};
  }
  return output;
}
function ensureFrame(){
  let k=keyframeAt(currentTime);if(k)return k;
  if(!Number.isInteger(currentTime))currentTime=Math.round(currentTime);
  if(entry.project.keyframes.length>=180){toast('立ち位置登録は180個までです');return null;}
  k={t:currentTime,positions:interpolate(currentTime)};entry.project.keyframes.push(k);entry.project.keyframes.sort((a,b)=>a.t-b.t);return k;
}
function setTime(t){stopPlayback();currentTime=clamp(t,0,entry.project.duration);syncAudioPosition();renderAll();}
function addFrame(){if(!editable())return;if(keyframeAt()){toast('この秒数には既に立ち位置が登録されています');return;}if(!Number.isInteger(currentTime))currentTime=Math.round(currentTime);if(ensureFrame()){commit();toast(`${currentTime}秒に立ち位置を登録しました`);}}
function deleteFrame(){if(!editable())return;if(currentTime===0){toast('0秒の立ち位置は削除できません');return;}const n=entry.project.keyframes.length;entry.project.keyframes=entry.project.keyframes.filter(k=>k.t!==currentTime);if(n===entry.project.keyframes.length){toast('この秒数には登録がありません');return;}commit();}
function addDancer(){if(!editable())return;const p=entry.project;if(p.dancers.length>=30){toast('出演者は30人までです');return;}
  const i=p.dancers.length, id=uid(),d={id,name:`ダンサー ${i+1}`,color:COLORS[i%COLORS.length]};p.dancers.push(d);
  const stage=p.stage, step=Math.min(1.4,stage.width/7), row=Math.floor(i/7), col=i%7;
  const pos={x:round(clamp((col-3)*step,-stage.width/2,stage.width/2)),y:round(clamp(1.4+row*1.3,0,stage.depth))};
  for(const k of p.keyframes)k.positions[id]=clone(pos);
  selectedId=id;commit();
}
function removeDancer(id){if(!editable())return;const d=entry.project.dancers.find(v=>v.id===id);if(!d || !confirm(`${d.name} を削除しますか？`))return;
  entry.project.dancers=entry.project.dancers.filter(v=>v.id!==id);entry.project.keyframes.forEach(k=>delete k.positions[id]);if(selectedId===id)selectedId=null;commit();
}
function updateStageSetting(id,key,min,max){
  $(id).addEventListener('change',()=>{
    if(!editable())return;
    const v=Number($(id).value);if(!Number.isFinite(v)){renderAll();return;}
    const s=entry.project.stage;s[key]=round(clamp(v,min,max));
    if(['width','depth'].includes(key))for(const k of entry.project.keyframes)for(const p of Object.values(k.positions)){p.x=round(clamp(p.x,-s.width/2,s.width/2));p.y=round(clamp(p.y,0,s.depth));}
    commit();
  });
}
function geometry(){const s=entry.project.stage,scale=Math.min(785/s.width,510/s.depth),width=s.width*scale,height=s.depth*scale;return {scale,width,height,left:500-width/2,top:355-height/2};}
function toPixel(p){const g=geometry();return {x:500+p.x*g.scale,y:g.top+(entry.project.stage.front==='bottom'?(entry.project.stage.depth-p.y)*g.scale:p.y*g.scale)};}
function fromPixel(point){const g=geometry(),s=entry.project.stage;return {x:round(clamp((point.x-500)/g.scale,-s.width/2,s.width/2),1),y:round(clamp(s.front==='bottom'?(g.top+g.height-point.y)/g.scale:(point.y-g.top)/g.scale,0,s.depth),1)};}
function getSvgPoint(e){const svg=$('stageSvg'),pt=svg.createSVGPoint();pt.x=e.clientX;pt.y=e.clientY;return pt.matrixTransform(svg.getScreenCTM().inverse());}
function currentTransition(){const fs=entry.project.keyframes,t=currentTime;
  for(let i=0;i<fs.length-1;i++)if(t>=fs[i].t && t<fs[i+1].t)return {a:fs[i],b:fs[i+1]};
  if(fs.length>1)return {a:fs[fs.length-2],b:fs[fs.length-1]};
  return {a:fs[0],b:fs[0]};
}
function pairWarnings(){
  const ds=entry.project.dancers,p=entry.project,s=p.stage,transition=currentTransition();
  const {a,b}=transition,start=a.t,end=b.t,threshold=s.safeDistance,warnings=[];
  for(let i=0;i<ds.length;i++)for(let j=i+1;j<ds.length;j++){
    const pa=a.positions[ds[i].id],pb=b.positions[ds[i].id];
    const qa=a.positions[ds[j].id],qb=b.positions[ds[j].id];
    if(!pa||!pb||!qa||!qb)continue;
    // 双方が直線・等速で動く場合の、連続時間における厳密な最短距離。
    const rx=pa.x-qa.x,ry=pa.y-qa.y;
    const vx=(pb.x-pa.x)-(qb.x-qa.x),vy=(pb.y-pa.y)-(qb.y-qa.y);
    const speed2=vx*vx+vy*vy;
    const ratio=speed2<1e-10?0:clamp(-(rx*vx+ry*vy)/speed2,0,1);
    const closest=Math.hypot(rx+vx*ratio,ry+vy*ratio),at=start+(end-start)*ratio;
    if(closest<threshold)warnings.push({one:ds[i],two:ds[j],distance:closest*BAMI_METERS,at,ids:[ds[i].id,ds[j].id]});
  }
  return warnings.sort((a,b)=>a.distance-b.distance);
}
function renderStage(){
  const p=entry.project,s=p.stage,g=geometry(),positions=interpolate(),warnings=pairWarnings(),atRisk=new Set();
  for(const w of warnings){if(Math.abs(w.at-currentTime)<.65){atRisk.add(w.one.id);atRisk.add(w.two.id);}}
  const svg=[];
  svg.push(`<defs><pattern id="floor" width="36" height="36" patternUnits="userSpaceOnUse"><path d="M 36 0 L 0 0 0 36" fill="none" stroke="#ffffff" stroke-opacity=".035" stroke-width="1" /></pattern><marker id="arrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5" fill="none" stroke="#b4a7ff" stroke-width="1"/></marker></defs>`);
  svg.push(`<rect x="${g.left}" y="${g.top}" width="${g.width}" height="${g.height}" rx="4" fill="#202b42" stroke="#72849f" stroke-width="2" />`);
  svg.push(`<rect x="${g.left}" y="${g.top}" width="${g.width}" height="${g.height}" fill="url(#floor)" />`);
  if(s.grid){
    const steps=Math.ceil(s.width/s.spacing),lcount=Math.floor(s.depth/s.spacing);
    for(let i=-steps;i<=steps;i++){
      const x=i*s.spacing;if(Math.abs(x)>s.width/2+.00001)continue;
      const X=500+x*g.scale,isCenter=i===0;
      svg.push(`<line x1="${X}" y1="${g.top}" x2="${X}" y2="${g.top+g.height}" stroke="${isCenter?'#76f4d8':'#8794a9'}" stroke-opacity="${isCenter?.46:.14}" stroke-width="${isCenter?2:1}" stroke-dasharray="${isCenter?'5 7':'4 6'}"/>`);
    }
    for(let i=1;i<lcount+1;i++){
      const y=i*s.spacing;if(y>=s.depth)continue;
      const py=toPixel({x:0,y}).y;svg.push(`<line x1="${g.left}" y1="${py}" x2="${g.left+g.width}" y2="${py}" stroke="#9dacbe" stroke-opacity=".12" stroke-dasharray="5 7" />`);
    }
  }
  const frontY=s.front==='bottom'?g.top+g.height:g.top, outerDirection=s.front==='bottom'?1:-1;
  svg.push(`<line x1="${g.left}" y1="${frontY}" x2="${g.left+g.width}" y2="${frontY}" stroke="#5be9d0" stroke-width="5" stroke-linecap="round" />`);
  const count=Math.floor((s.width/2)/s.spacing+1e-8), labelEvery=Math.ceil((count*2+1)/17);
  for(let i=-count;i<=count;i++){
    const xx=500+i*s.spacing*g.scale,yy=frontY+outerDirection*9;
    svg.push(`<line x1="${xx}" y1="${frontY}" x2="${xx}" y2="${frontY+outerDirection*12}" stroke="${i===0?'#68f3d8':'#d3e1f0'}" stroke-width="${i===0?4:2.5}" />`);
    if(i===0 || i%labelEvery===0)svg.push(`<text x="${xx}" y="${yy+outerDirection*19}" text-anchor="middle" dominant-baseline="middle" fill="${i===0?'#5be9d0':'#c2cee0'}" font-size="${i===0?18:14}" font-weight="${i===0?800:600}">${i===0?'0':i>0?`+${round(i*s.spacing)}`:round(i*s.spacing)}</text>`);
  }
  const audienceY=frontY+outerDirection*64;
  svg.push(`<text x="500" y="${audienceY}" text-anchor="middle" fill="#5de6d0" font-size="18" font-weight="800">客席 / FRONT</text>`);
  svg.push(`<text x="500" y="${s.front==='bottom'?g.top-22:g.top+g.height+31}" text-anchor="middle" fill="#b9c4da" font-size="16" font-weight="700">ステージ奥 / BACK</text>`);
  svg.push(`<text x="${g.left}" y="${g.top-20}" fill="#98a8c5" font-size="15">横 ${s.width} × 奥行 ${s.depth}　｜　1バミリ＝90cm</text>`);
  if(s.paths && p.dancers.length){
    const tr=currentTransition(),{a,b}=tr;
    for(const d of p.dancers){const start=a.positions[d.id],end=b.positions[d.id];if(!start||!end||Math.hypot(start.x-end.x,start.y-end.y)<.02)continue;
      const ps=toPixel(start),pe=toPixel(end),selected=d.id===selectedId,opacity=selected?.94:.38;
      svg.push(`<path d="M ${ps.x} ${ps.y} L ${pe.x} ${pe.y}" stroke="${selected?d.color:'#b6a8ff'}" stroke-width="${selected?4:2.3}" stroke-dasharray="${selected?'8 5':'5 9'}" stroke-opacity="${opacity}" fill="none" ${selected?'marker-end="url(#arrow)"':''}/>`);
    }
  }
  for(const d of p.dancers){
    const pos=positions[d.id];if(!pos)continue;const v=toPixel(pos),active=selectedId===d.id,risk=atRisk.has(d.id),small=window.innerWidth<=790,r=small?(active?42:39):(active?27:24);
    const name=d.name.trim()||'無名', display=[...name].length>7?[...[...name].slice(0,6),'…'].join(''):name;
    svg.push(`<g class="dancer-svg" data-dancer="${esc(d.id)}" style="cursor:${editable()?'grab':'pointer'}"><title>${esc(name)} / x:${pos.x.toFixed(1)}m y:${pos.y.toFixed(1)}m</title><circle cx="${v.x}" cy="${v.y}" r="${r+6}" fill="${risk?'#ffb96e':'#5be9d0'}" opacity="${active?0.24:risk?.26:0}" />`);
    svg.push(`<circle cx="${v.x}" cy="${v.y}" r="${r}" fill="${esc(d.color)}" stroke="${risk?'#ffcf82':active?'#fff':'#142034'}" stroke-width="${active||risk?4:2}" />`);
    svg.push(`<text x="${v.x}" y="${v.y+1}" fill="#131c2a" font-size="${small?(display.length>5?16:21):(display.length>5?10:12)}" font-weight="900" text-anchor="middle" dominant-baseline="middle" pointer-events="none">${esc(display)}</text></g>`);
  }
  if(!p.dancers.length)svg.push(`<text x="500" y="355" text-anchor="middle" font-size="22" fill="#8ea4c0">左の「＋ 追加」からダンサーを配置</text>`);
  $('stageSvg').innerHTML=svg.join('');
}
function renderDancers(){
  const ds=entry.project.dancers;$('dancerCount').textContent=`${ds.length}/30`;$('addDancer').disabled=!editable()||ds.length>=30;
  $('dancerList').innerHTML=ds.map(d=>`<div class="dancer-row ${d.id===selectedId?'selected':''}" data-row="${esc(d.id)}"><input class="color-input" title="色を変更" type="color" data-color="${esc(d.id)}" value="${esc(d.color)}" ${editable()?'':'disabled'} /><input class="dancer-name" aria-label="出演者名" maxlength="32" data-name="${esc(d.id)}" value="${esc(d.name)}" ${editable()?'':'readonly'} /><button class="mini-remove" title="削除" data-remove="${esc(d.id)}" ${editable()?'':'disabled'}>×</button></div>`).join('');
}
function renderInspector(){
  const p=entry.project, tr=currentTransition(), next=p.keyframes.find(k=>k.t>currentTime);
  $('metricTime').innerHTML=`${round(currentTime,1).toFixed(1)} <small>s</small>`;
  $('metricNext').innerHTML=next?`${next.t} <small>s</small>`:'—';
  const warnings=pairWarnings();
  $('collisionPanel').innerHTML=warnings.length?warnings.slice(0,7).map(w=>`<div class="warning-msg">⚠ ${esc(w.one.name)} × ${esc(w.two.name)}<br>約 ${round(w.at,1)}秒で最短 ${round(w.distance,2)}m</div>`).join('') + (warnings.length>7?`<p class="muted hint">ほか ${warnings.length-7} 件</p>`:''):`<div class="safe-msg">✓ この区間では設定距離未満の接近を検出していません。</div>`;
  const d=p.dancers.find(x=>x.id===selectedId),pos=d?interpolate()[d.id]:null;
  let nextDist='—';if(d&&tr.a!==tr.b)nextDist=round(Math.hypot(tr.a.positions[d.id].x-tr.b.positions[d.id].x,tr.a.positions[d.id].y-tr.b.positions[d.id].y),2)+'m';
  $('selectedDetails').innerHTML=d?`<div class="name-line"><i class="dot" style="background:${esc(d.color)}"></i>${esc(d.name)}</div><strong>中心から：</strong> ${pos.x<0?'左':'右'} ${Math.abs(round(pos.x,1))}m<br><strong>客席から：</strong> ${round(pos.y,1)}m<br><strong>区間の移動距離：</strong> ${nextDist}`:'円をタップして選択';
}
function renderTimeline(){const p=entry.project;
  $('timeSlider').max=p.duration;$('timeSlider').value=currentTime;
  $('timeDisplay').textContent=fmtTime(currentTime);$('totalDisplay').textContent='/ '+fmtTime(p.duration);
  $('totalDuration').value=p.duration;$('keyframeMarkers').innerHTML=p.keyframes.map(k=>`<span class="marker" style="left:${k.t/p.duration*100}%"></span>`).join('');
  $('keyframeChips').innerHTML=p.keyframes.map(k=>`<button class="frame-chip ${currentTime===k.t?'active':''}" data-time="${k.t}">◆ ${k.t}s</button>`).join('');
  const exact=!!keyframeAt();$('frameMode').textContent=exact?'登録済みの立ち位置':'自動補間のプレビュー';$('frameMode').classList.toggle('interpolated',!exact);
  $('deleteKeyframe').disabled=!editable()||!exact||currentTime===0;
  $('addKeyframe').disabled=!editable()||exact;
}
function renderSettings(){const s=entry.project.stage;
  $('stageWidth').value=s.width;$('stageDepth').value=s.depth;$('markSpacing').value=90;$('safeDistance').value=round(s.safeDistance*BAMI_METERS,1);
  $('frontBottom').classList.toggle('is-active',s.front==='bottom');$('frontTop').classList.toggle('is-active',s.front==='top');
  $('gridEnabled').checked=s.grid!==false;$('pathsEnabled').checked=s.paths!==false;
  $('stageReadout').textContent=`横 ${s.width} × 奥行 ${s.depth}（1バミリ＝90cm）`;
  document.querySelectorAll('.left-panel input, .left-panel button:not(#importJson), #totalDuration, #projectTitle').forEach(el=>{if(!el.matches('[data-name],[data-color],[data-remove]'))el.disabled=!editable()});
  $('duplicateProject').disabled=false;
}
function renderAll(){if(!entry)return;renderSettings();renderStage();renderDancers();renderTimeline();renderInspector();}
function toast(text){const el=$('toast');el.textContent=text;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),3100);}
function modal(title,html){$('modalTitle').textContent=title;$('modalBody').innerHTML=html;$('modalBackdrop').classList.remove('hidden');}
function closeModal(){$('modalBackdrop').classList.add('hidden');}
async function copyText(value){try{await navigator.clipboard.writeText(value);toast('リンクをコピーしました');}catch{toast('コピーできませんでした。URLを選択してコピーしてください');}}
function projectUrl(id, key){const u=new URL(location.href);u.search='';u.searchParams.set('id',id);if(key)u.searchParams.set('key',key);return u.toString();}
function shareDialog(){
  if(!entry.remoteId){
    modal('ショーケースを共有',`<p>公開すると、ほかの人がブラウザで立ち位置や導線を閲覧できます。閲覧する人にアカウント登録は不要です。</p><div class="notice">「閲覧リンク」を知る人は内容を閲覧できます。編集用リンクは第三者に渡さないでください。</div><button id="publishNow" class="btn primary full" ${editable()?'':'disabled'}>クラウドに保存して共有リンクを作成</button><p class="muted hint">公開保存には Vercel と Supabase の接続設定が必要です。未設定でもJSON保存は使えます。</p>`);
    $('publishNow')?.addEventListener('click',publishProject);return;
  }
  const readUrl=projectUrl(entry.remoteId),editUrl=entry.editKey?projectUrl(entry.remoteId,entry.editKey):null;
  modal('共有リンク',`<p>この作品への閲覧リンクです。共有先では立ち位置の編集ができません。</p><label class="form-label">閲覧リンク（共有用）</label><div class="link-area"><input readonly id="viewUrl" value="${esc(readUrl)}"><button class="btn primary" id="copyView">コピー</button></div>${editUrl?`<label class="form-label">編集用リンク（秘密にしてください）</label><div class="link-area"><input readonly id="editUrl" value="${esc(editUrl)}"><button class="btn quiet" id="copyEdit">コピー</button></div><div class="notice">編集用リンクを知っている人は作品を書き換えられます。失くすと別端末で編集できなくなるため、安全な場所に控えてください。</div>`:''}`);
  $('copyView').onclick=()=>copyText(readUrl);if(editUrl)$('copyEdit').onclick=()=>copyText(editUrl);
}
async function publishProject(){if(!editable())return;const btn=$('publishNow');btn.disabled=true;btn.textContent='公開処理中…';
  try{
    const res=await fetch('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:entry.project.title,data:entry.project})});
    const data=await res.json();if(!res.ok)throw Error(data.error||'公開できませんでした');
    entry.remoteId=data.id;entry.editKey=data.editKey;saveEntries();setStatus('クラウド保存済み');if(pendingAudioFile)await uploadCloudAudio(pendingAudioFile);shareDialog();toast('共有リンクを作成しました');
  }catch(e){btn.disabled=false;btn.textContent='再試行';toast(e.message);}
}
function openProjectsDialog(){
  modal('保存したショーケース',`<p>この端末に保存された作品一覧です。クラウド作品は共有リンクからも開けます。</p><div id="projectsList">${entries.slice(0,50).map(e=>`<div class="project-item"><div><strong>${esc(e.project.title)}</strong><small>${e.project.dancers.length}人・${e.project.duration}秒 ${e.remoteId?'・共有済み':''}</small></div><div><button class="btn quiet" data-open="${esc(e.localId)}">開く</button><button class="btn quiet" data-delete="${esc(e.localId)}">削除</button></div></div>`).join('')}</div>`);
  $('projectsList').onclick=e=>{
    const open=e.target.closest('[data-open]'),del=e.target.closest('[data-delete]');
    if(open){const target=entries.find(v=>v.localId===open.dataset.open);if(target){activate(target);closeModal();}}
    if(del){const target=entries.find(v=>v.localId===del.dataset.delete);if(!target)return;if(!confirm(`この端末の「${target.project.title}」を一覧から削除しますか？\nクラウド公開データは削除されません。`))return;
      entries=entries.filter(v=>v!==target);if(entry===target){if(!entries.length)createNew();else activate(entries[0]);}saveEntries();closeModal();toast('この端末の一覧から削除しました');
    }
  };
}
function exportProject(){const name=(entry.project.title||'stageflow').replace(/[\\/:*?"<>|]/g,'_').slice(0,60);
  const blob=new Blob([JSON.stringify(entry.project,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${name}.stageflow.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('JSONファイルを保存しました');
}
async function importFile(file){try{const data=JSON.parse(await file.text());const p=validateLocal(data);const e={localId:uid(),project:p,updatedAt:Date.now()};entries.unshift(e);activate(e);toast('作品を読み込みました');}catch(e){toast(`読み込み失敗：${e.message}`);}finally{$('importFile').value='';}}
function startPlayback(){
 if(playing){stopPlayback();return;}
 if(currentTime>=entry.project.duration)currentTime=0;
 const a=$('showcaseAudio'),sync=$('audioSync').checked && !!a.src;
 if(sync){a.currentTime=Math.min(currentTime,Number.isFinite(a.duration)?a.duration:currentTime);if(a.ended || (Number.isFinite(a.duration)&&a.currentTime>=a.duration)){currentTime=0;a.currentTime=0;}a.play().catch(()=>{stopPlayback();toast('音声を再生できません。MP3を選び直してください');});}
 playOrigin=currentTime;playStart=performance.now();playing=true;$('playButton').textContent='Ⅱ';
 const tick=now=>{if(!playing)return;currentTime=Math.min(entry.project.duration,sync?a.currentTime:playOrigin+(now-playStart)/1000);renderStage();renderTimeline();renderInspector();if(currentTime>=entry.project.duration||(sync&&a.ended)){stopPlayback();return;}raf=requestAnimationFrame(tick);};raf=requestAnimationFrame(tick);
}
function stagePointerDown(e){const target=e.target.closest('[data-dancer]');if(!target)return;
  const id=target.dataset.dancer;selectedId=id;
  if(editable()){
    stopPlayback();currentTime=Math.round(currentTime);
    const frame=ensureFrame();if(frame){dragId=id;$('stageSvg').setPointerCapture(e.pointerId);}
  }
  renderAll();
}
function stagePointerMove(e){if(!dragId)return;const frame=keyframeAt(currentTime);if(!frame)return;frame.positions[dragId]=fromPixel(getSvgPoint(e));renderStage();renderInspector();}
function stagePointerUp(){if(!dragId)return;dragId=null;commit();}

function bind(){
  $('newProject').addEventListener('click',()=>createNew());
  $('openProjects').addEventListener('click',openProjectsDialog);
  $('duplicateProject').addEventListener('click',duplicate);
  $('shareProject').addEventListener('click',shareDialog);
  $('exportJson').addEventListener('click',exportProject);
  $('importJson').addEventListener('click',()=>$('importFile').click());
  $('importFile').addEventListener('change',e=>{if(e.target.files[0])importFile(e.target.files[0]);});
  $('modalClose').onclick=closeModal;
  $('modalBackdrop').onclick=e=>{if(e.target===$('modalBackdrop'))closeModal();};
  $('projectTitle').addEventListener('change',()=>commit({redraw:false}));
  updateStageSetting('stageWidth','width',2,40);updateStageSetting('stageDepth','depth',2,30);
  $('safeDistance').addEventListener('change',()=>{if(!editable())return;entry.project.stage.safeDistance=round(clamp(Number($('safeDistance').value),.3,3)/BAMI_METERS);commit();});
  for(const [id,value] of [['frontBottom','bottom'],['frontTop','top']])$(id).onclick=()=>{if(!editable())return;if(entry.project.stage.front===value)return;entry.project.stage.front=value;commit();toast('客席の向きを反転し、全員の表示位置と導線を自動で反転しました');};
  for(const [id,key] of [['gridEnabled','grid'],['pathsEnabled','paths']])$(id).onchange=e=>{if(!editable())return;entry.project.stage[key]=e.target.checked;commit();};
  $('addDancer').onclick=addDancer;
  $('dancerList').addEventListener('click',e=>{const rem=e.target.closest('[data-remove]');if(rem){removeDancer(rem.dataset.remove);return;}const row=e.target.closest('[data-row]');if(row && !e.target.matches('input')){selectedId=row.dataset.row;renderAll();}});
  $('dancerList').addEventListener('input',e=>{const el=e.target;if(!editable())return;
    if(el.matches('[data-name]')){const d=entry.project.dancers.find(v=>v.id===el.dataset.name);if(d){d.name=el.value;selectedId=d.id;commit({redraw:false});renderStage();renderInspector();}}
    else if(el.matches('[data-color]')){const d=entry.project.dancers.find(v=>v.id===el.dataset.color);if(d){d.color=el.value;selectedId=d.id;commit({redraw:false});renderStage();renderInspector();}}
  });
  $('dancerList').addEventListener('focusout',e=>{if(e.target.matches('[data-name],[data-color]'))renderDancers();});
  $('stageSvg').addEventListener('pointerdown',stagePointerDown);
  $('stageSvg').addEventListener('pointermove',stagePointerMove);
  $('stageSvg').addEventListener('pointerup',stagePointerUp);
  $('stageSvg').addEventListener('pointercancel',stagePointerUp);
  $('stageSvg').addEventListener('lostpointercapture',stagePointerUp);
  $('addKeyframe').onclick=addFrame;$('deleteKeyframe').onclick=deleteFrame;
  $('firstFrame').onclick=()=>setTime(0);$('lastFrame').onclick=()=>setTime(entry.project.duration);
  $('prevSecond').onclick=()=>setTime(Math.floor(currentTime)-1);
  $('nextSecond').onclick=()=>setTime(Math.floor(currentTime)+1);
  $('audioFile').addEventListener('change',async e=>{const f=e.target.files?.[0];if(!f)return;if(!/\.mp3$/i.test(f.name)||f.size>50*1024*1024){toast('50MB以下のMP3を選択してください');return;}resetAudio();audioUrl=URL.createObjectURL(f);const a=$('showcaseAudio');a.src=audioUrl;a.load();$('audioStatus').textContent=f.name;if(editable()){entry.project.audioName=f.name;entry.project.audioCloud=false;commit({redraw:false});pendingAudioFile=f;if(entry.remoteId)await uploadCloudAudio(f);}toast('音源を読み込みました');});
  $('showcaseAudio').addEventListener('loadedmetadata',()=>{audioLength=$('showcaseAudio').duration;if(Number.isFinite(audioLength))$('audioStatus').textContent=`${entry.project.audioName||'音源'} (${fmtTime(audioLength)})`;});
  $('audioRemove').onclick=()=>{resetAudio();if(editable()){delete entry.project.audioName;entry.project.audioCloud=false;commit({redraw:false});} };
  $('audioFit').onclick=()=>{if(!editable())return;if(!Number.isFinite(audioLength)||audioLength<=0){toast('先にMP3を選択してください');return;}const n=Math.min(600,Math.ceil(audioLength));if(n<entry.project.keyframes.at(-1).t){toast('最後の登録時刻より短いため変更できません');return;}entry.project.duration=n;currentTime=clamp(currentTime,0,n);commit();};
  $('audioSync').onchange=()=>{stopPlayback();syncAudioPosition();};
  $('playButton').onclick=startPlayback;
  $('timeSlider').oninput=e=>setTime(Number(e.target.value));
  $('keyframeChips').onclick=e=>{const chip=e.target.closest('[data-time]');if(chip)setTime(Number(chip.dataset.time));};
  $('totalDuration').onchange=e=>{if(!editable())return;const val=Number(e.target.value);const last=entry.project.keyframes.at(-1).t;
    if(!Number.isInteger(val)||val<Math.max(1,last)||val>600){toast(`全体の長さは ${Math.max(1,last)}〜600秒で指定してください`);renderAll();return;}
    entry.project.duration=val;currentTime=clamp(currentTime,0,val);commit();};
  window.addEventListener('keydown',e=>{if(!entry || e.target.closest('input,button,textarea'))return;
    if(e.key==='ArrowRight'){e.preventDefault();setTime(Math.floor(currentTime)+1);}else if(e.key==='ArrowLeft'){e.preventDefault();setTime(Math.floor(currentTime)-1);}else if(e.code==='Space'){e.preventDefault();startPlayback();}
  });
  window.addEventListener('beforeunload',()=>{if(entry)saveEntries();});
}

async function uploadCloudAudio(file){
 if(!entry?.remoteId||!entry.editKey){pendingAudioFile=file;return;}
 const target=entry;
 try{
  $('audioStatus').textContent='クラウドへアップロード中…';
  const r=await fetch(`/api/audio?id=${encodeURIComponent(target.remoteId)}`,{method:'POST',headers:{'X-Edit-Key':target.editKey,'X-File-Size':String(file.size)}});
  const result=await r.json();if(!r.ok)throw Error(result.error||'アップロードURLの取得に失敗');
  const upload=await fetch(result.uploadUrl,{method:'PUT',headers:{'Content-Type':'audio/mpeg','x-upsert':'true'},body:file});
  if(!upload.ok)throw Error(`MP3保存失敗 (${upload.status})`);
  if(entry!==target)return;
  target.project.audioName=file.name;target.project.audioCloud=true;pendingAudioFile=null;
  commit({redraw:false});await syncCloudNow(target);
  $('audioStatus').textContent=`☁ ${file.name}`;toast('MP3をクラウドに保存しました');
 }catch(e){$('audioStatus').textContent='クラウド保存失敗・端末では再生可能';toast(e.message);}
}
async function syncCloudNow(target){
 const job=cloudJobs.get(target.localId);
 if(job){clearTimeout(job.timer);job.dirty=false;}
 const r=await fetch(`/api/projects?id=${encodeURIComponent(target.remoteId)}`,{method:'PUT',headers:{'Content-Type':'application/json','X-Edit-Key':target.editKey},body:JSON.stringify({title:target.project.title,data:target.project})});
 if(!r.ok)throw Error('音源情報の同期に失敗');
}
async function loadCloudAudio(target){
 const seq=audioLoadSequence;
 $('audioStatus').textContent='クラウド音源を読み込み中…';
 try{
  const r=await fetch(`/api/audio?id=${encodeURIComponent(target.remoteId)}`,{cache:'no-store'});
  const data=await r.json();if(!r.ok)throw Error(data.error||'音源を取得できません');
  if(entry!==target||seq!==audioLoadSequence)return;
  const a=$('showcaseAudio');a.src=data.url;a.load();$('audioStatus').textContent=`☁ ${target.project.audioName||'MP3'}`;
 }catch(e){if(entry===target&&seq===audioLoadSequence){$('audioStatus').textContent='MP3取得失敗';toast(e.message);}}
}

async function loadCloud(id,queryKey){initialLoading=true;setStatus('共有作品を読み込み中…');
  try{
    const res=await fetch(`/api/projects?id=${encodeURIComponent(id)}`,{cache:'no-store'});
    const data=await res.json();if(!res.ok)throw Error(data.error||'共有作品を開けませんでした');
    const project=validateLocal(data.data),local=entries.find(e=>e.remoteId===id);
    const key=queryKey||local?.editKey||null;
    if(local){local.project=project;local.editKey=key;local.updatedAt=Date.now();activate(local,{url:false});}
    else {const e={localId:uid(),project,remoteId:id,editKey:key,updatedAt:Date.now()};entries.unshift(e);activate(e,{url:false});}
    const safe=projectUrl(id);history.replaceState(null,'',safe);
    setStatus(key?'共有作品（編集可能）':'閲覧専用・複製で編集可');
  }catch(e){toast('読み込みエラー：'+e.message);if(entries.length){activate(entries[0]);}else createNew({demo:true});}
  finally{initialLoading=false;}
}
async function init(){bind();loadEntries();const params=new URLSearchParams(location.search),id=params.get('id'),key=params.get('key');
  if(id){await loadCloud(id,key);return;}
  const local=entries.find(e=>e.localId===localStorage.getItem(ACTIVE));
  if(local){try{validateLocal(local.project);activate(local);}catch{entries=entries.filter(e=>e!==local);createNew({demo:true});}}
  else if(entries.length)activate(entries[0]);else createNew({demo:true});
}
init();

(function(){const tabs=[...document.querySelectorAll('[data-tab]')],left=document.querySelector('.left-panel'),right=document.querySelector('.right-panel'),header=document.getElementById('mobileSheetHeader'),title=document.getElementById('mobileSheetTitle'),quick=document.querySelector('.mobile-quick-actions');function show(tab){left.classList.toggle('mobile-open',tab==='settings'||tab==='dancers');right.classList.toggle('mobile-open',tab==='checks');left.dataset.section=tab;header.hidden=tab==='stage';title.textContent=({settings:'ステージ設定',dancers:'出演者の編集',checks:'導線チェック'})[tab]||'';quick.classList.toggle('is-hidden',tab!=='stage');tabs.forEach(b=>{b.classList.toggle('active',b.dataset.tab===tab);b.setAttribute('aria-pressed',String(b.dataset.tab===tab))})}tabs.forEach(b=>b.addEventListener('click',()=>show(b.dataset.tab)));document.getElementById('closeMobileSheet').onclick=()=>show('stage');document.getElementById('mobileAddDancer').onclick=()=>{document.getElementById('addDancer').click();show('dancers')};document.getElementById('mobileAddFrame').onclick=()=>document.getElementById('addKeyframe').click();show('stage')})();

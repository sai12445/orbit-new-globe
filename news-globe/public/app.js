/* ORBIT frontend — 3D globe + auto-scrolling live news, powered by the backend.
   Data comes from the server (same origin): /api/events, /api/geo/countries, /api/brief.
   No API keys in the browser. */

const CATS = {
  markets:{label:'Markets',color:'#f5a623'},
  disaster:{label:'Disaster',color:'#ff453a'},
  weather:{label:'Weather',color:'#22d3ee'},
  conflict:{label:'Geopolitics',color:'#ff2d78'},
  tech:{label:'Tech',color:'#8b5cf6'},
  sports:{label:'Sports',color:'#34d399'},
  culture:{label:'Culture',color:'#c084fc'},
  health:{label:'Health',color:'#fb7185'},
  news:{label:'News',color:'#9aa6bd'},
  celebration:{label:'Culture',color:'#c084fc'}, // legacy alias
};
const CAT_ORDER = ['markets','disaster','weather','conflict','tech','sports','culture','health','news'];
const catOf = c => CATS[c] || CATS.news;
const catColor = c => catOf(c).color;
const REFRESH_MS = 30000; // poll the backend every 30s

/* theme + category-filter state (persisted) */
const THEMES = [['midnight','Midnight'],['obsidian','Obsidian'],['aurora','Aurora'],['royal','Royal'],['slate','Slate'],['daylight','Daylight']];
let curTheme = localStorage.getItem('orbit_theme') || 'midnight';
document.documentElement.setAttribute('data-theme', curTheme);
let activeCats = new Set(JSON.parse(localStorage.getItem('orbit_cats') || 'null') || CAT_ORDER);
let activeCountry = localStorage.getItem('orbit_country') || ''; // '' = all countries

/* India Standard Time helpers */
const IST = { timeZone:'Asia/Kolkata', hour12:false };
const istClock = () => new Date().toLocaleTimeString('en-GB', IST) + ' IST';
const istFull  = ms => new Date(ms).toLocaleString('en-GB',
  { ...IST, day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) + ' IST';

/* ================= THREE.JS GLOBE ================= */
const canvas = document.getElementById('globe');
const renderer = new THREE.WebGLRenderer({canvas, antialias:true, alpha:true});
renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth/innerHeight, 0.1, 100);
camera.position.set(0,0,2.7);
const R = 1; const globe = new THREE.Group(); scene.add(globe);

// Realistic Earth: day texture on the lit side, glowing city lights on the night side.
const _tl = new THREE.TextureLoader();
const dayTex   = _tl.load('vendor/earth_day.jpg', undefined, undefined, ()=>{ if(typeof coastlines==='function') coastlines(); });
const nightTex = _tl.load('vendor/earth_night.png');
const earthUni = {
  dayTex:{value:dayTex}, nightTex:{value:nightTex},
  sunDir:{value:new THREE.Vector3(0.7,0.28,-0.7).normalize()},
  dayDim:{value:0.95}, nightBoost:{value:2.4},
};
const earthMat = new THREE.ShaderMaterial({
  uniforms: earthUni,
  vertexShader: 'varying vec2 vUv; varying vec3 vWN;'
    + 'void main(){ vUv=uv; vWN=normalize(mat3(modelMatrix)*normal);'
    + 'gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: 'uniform sampler2D dayTex; uniform sampler2D nightTex; uniform vec3 sunDir;'
    + 'uniform float dayDim; uniform float nightBoost; varying vec2 vUv; varying vec3 vWN;'
    + 'void main(){ float d=dot(normalize(vWN), normalize(sunDir));'
    + 'float t=smoothstep(-0.35,0.5,d);'
    + 'vec3 dayFull=texture2D(dayTex,vUv).rgb;'
    + 'vec3 nraw=texture2D(nightTex,vUv).rgb;'
    + 'vec3 lights=pow(nraw, vec3(1.7))*nightBoost;'
    + 'vec3 night=dayFull*0.22 + lights + vec3(0.008,0.012,0.03);'
    + 'vec3 day=dayFull*mix(0.6,dayDim,t);'
    + 'vec3 col=mix(night, day, t);'
    + 'gl_FragColor=vec4(col,1.0); }',
});
globe.add(new THREE.Mesh(new THREE.SphereGeometry(R,96,96), earthMat));
scene.add(new THREE.AmbientLight(0x3b4a6b,0.9));
const sun = new THREE.DirectionalLight(0xbcd4ff,1.1); sun.position.set(-3,1.5,2.5); scene.add(sun);

const atmoUni = { c:{ value:new THREE.Color(0x3aa0ff) } };
scene.add(new THREE.Mesh(new THREE.SphereGeometry(R*1.12,64,64),
  new THREE.ShaderMaterial({transparent:true,blending:THREE.AdditiveBlending,side:THREE.BackSide,depthWrite:false,
    uniforms:atmoUni,
    vertexShader:'varying vec3 vN;void main(){vN=normalize(normalMatrix*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader:'uniform vec3 c;varying vec3 vN;void main(){float i=pow(0.55-dot(vN,vec3(0,0,1.0)),4.5);gl_FragColor=vec4(c,1.0)*clamp(i,0.0,1.0);}'})));

let starMat = null, coastMat = null, gridMat = null;
(function stars(){const g=new THREE.BufferGeometry(),N=1600,p=new Float32Array(N*3);
  for(let i=0;i<N;i++){const r=18+Math.random()*30,t=Math.random()*Math.PI*2,ph=Math.acos(2*Math.random()-1);
    p[i*3]=r*Math.sin(ph)*Math.cos(t);p[i*3+1]=r*Math.sin(ph)*Math.sin(t);p[i*3+2]=r*Math.cos(ph);}
  g.setAttribute('position',new THREE.BufferAttribute(p,3));
  starMat=new THREE.PointsMaterial({color:0xffffff,size:0.06,sizeAttenuation:true,transparent:true,opacity:0.7});
  scene.add(new THREE.Points(g,starMat));})();

/* read CSS theme vars and recolor the globe */
function applyTheme(name){
  curTheme=name; document.documentElement.setAttribute('data-theme',name);
  try{ localStorage.setItem('orbit_theme',name); }catch(e){}
  const cs=getComputedStyle(document.documentElement); const v=n=>cs.getPropertyValue(n).trim();
  try{
    if(atmoUni) atmoUni.c.value.set(v('--globe-atmo'));
    if(coastMat) coastMat.color.set(v('--globe-coast'));
    if(gridMat) gridMat.color.set(v('--grid'));
    if(starMat){ starMat.color.set(v('--star')); starMat.opacity=parseFloat(v('--star-opacity'))||0; }
  }catch(e){}
}

function ll2v(lat,lon,r){const phi=(90-lat)*Math.PI/180,th=(lon+180)*Math.PI/180;
  return new THREE.Vector3(-r*Math.sin(phi)*Math.cos(th),r*Math.cos(phi),r*Math.sin(phi)*Math.sin(th));}

function graticule(){const v=[];
  for(let lat=-60;lat<=60;lat+=30)for(let lon=-180;lon<180;lon+=4)v.push(ll2v(lat,lon,R*1.001),ll2v(lat,lon+4,R*1.001));
  for(let lon=-180;lon<180;lon+=30)for(let lat=-88;lat<88;lat+=4)v.push(ll2v(lat,lon,R*1.001),ll2v(lat+4,lon,R*1.001));
  gridMat=new THREE.LineBasicMaterial({color:0x2b4d7a,transparent:true,opacity:0.4});
  globe.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(v),gridMat));}

async function coastlines(){
  try{
    const r = await fetch('/api/geo/countries'); if(!r.ok) throw 0;
    const geo = await r.json(); const v=[];
    const ring = rg => { for(let i=0;i<rg.length-1;i++) v.push(ll2v(rg[i][1],rg[i][0],R*1.002), ll2v(rg[i+1][1],rg[i+1][0],R*1.002)); };
    for(const f of geo.features){const c=f.geometry&&f.geometry.coordinates; if(!c)continue;
      if(f.geometry.type==='Polygon') c.forEach(ring);
      else if(f.geometry.type==='MultiPolygon') c.forEach(p=>p.forEach(ring));}
    coastMat=new THREE.LineBasicMaterial({color:0x4f7fb8,transparent:true,opacity:0.85});
    globe.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(v),coastMat));
    graticule();
  }catch(e){ graticule(); }
  applyTheme(curTheme);
}
applyTheme(curTheme); // texture provides continents + city lights; coastlines() is the fallback on texture error


/* markers */
const markerGroup = new THREE.Group(); globe.add(markerGroup); let rings=[];
function clearMarkers(){[...markerGroup.children].forEach(m=>{markerGroup.remove(m);if(m.geometry)m.geometry.dispose();if(m.material)m.material.dispose();});rings=[];}
function renderMarkers(){ clearMarkers(); ALL.filter(e=>activeCats.has(e.cat) && (!activeCountry||e.country===activeCountry)).slice(0,150).forEach(addMarker); }
function addMarker(ev){const col=new THREE.Color(catColor(ev.cat)); const pos=ll2v(ev.lat,ev.lon,R*1.012);
  const dir=pos.clone().normalize();
  const dot=new THREE.Mesh(new THREE.SphereGeometry(0.011+ev.sev*0.003,12,12),new THREE.MeshBasicMaterial({color:col}));
  dot.position.copy(pos); dot.userData.ev=ev; dot.userData.dir=dir; markerGroup.add(dot);
  const halo=new THREE.Mesh(new THREE.SphereGeometry(0.028+ev.sev*0.006,12,12),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:0.16,blending:THREE.AdditiveBlending,depthWrite:false}));
  halo.position.copy(pos); halo.userData.dir=dir; markerGroup.add(halo);
  if(ev.live||ev.sev>=4){const ring=new THREE.Mesh(new THREE.RingGeometry(0.02,0.028,32),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:0.7,side:THREE.DoubleSide,depthWrite:false}));
    ring.position.copy(pos); ring.lookAt(0,0,0); ring.userData={phase:Math.random(),dir:dir}; markerGroup.add(ring); rings.push(ring);}}

/* controls */
let drag=false,px=0,py=0,vx=0,vy=0,rx=0.25,ry=-0.4,idle=0,target=null,downX=0,downY=0;
const clampX=v=>Math.max(-1.2,Math.min(1.2,v));
canvas.addEventListener('pointerdown',e=>{drag=true;px=e.clientX;py=e.clientY;downX=e.clientX;downY=e.clientY;idle=0;target=null;canvas.setPointerCapture(e.pointerId);});
canvas.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-px,dy=e.clientY-py;px=e.clientX;py=e.clientY;ry+=dx*0.005;rx=clampX(rx+dy*0.005);vx=dx*0.005;vy=dy*0.005;});
canvas.addEventListener('pointerup',e=>{drag=false;idle=0;if(Math.abs(e.clientX-downX)<5&&Math.abs(e.clientY-downY)<5)pick(e);});
canvas.addEventListener('wheel',e=>{e.preventDefault();camera.position.z=Math.max(1.55,Math.min(4.5,camera.position.z+e.deltaY*0.0016));},{passive:false});
const ray=new THREE.Raycaster(),mouse=new THREE.Vector2();
function pick(e){const r=canvas.getBoundingClientRect();mouse.x=((e.clientX-r.left)/r.width)*2-1;mouse.y=-((e.clientY-r.top)/r.height)*2+1;
  ray.setFromCamera(mouse,camera);const hit=ray.intersectObjects(markerGroup.children.filter(o=>o.userData.ev));if(hit.length)openDetail(hit[0].object.userData.ev);}
function flyTo(ev){const v=ll2v(ev.lat,ev.lon,1);target={ry:-Math.atan2(v.x,v.z),rx:clampX(Math.atan2(v.y,Math.hypot(v.x,v.z)))};idle=0;}

/* render + auto-scroll */
let t=0;
const feedEl=document.getElementById('feed');
let autoScroll=true, feedHover=false, manualPauseUntil=0;
feedEl.addEventListener('pointerenter',()=>feedHover=true);
feedEl.addEventListener('pointerleave',()=>feedHover=false);
feedEl.addEventListener('wheel',()=>{manualPauseUntil=Date.now()+4000;});
const _camDir=new THREE.Vector3(), _md=new THREE.Vector3();
function loop(){requestAnimationFrame(loop);t+=0.016;idle+=0.016;
  if(target){ry+=(target.ry-ry)*0.08;rx+=(target.rx-rx)*0.08;if(Math.abs(target.ry-ry)<0.002&&Math.abs(target.rx-rx)<0.002)target=null;}
  else if(!drag){vx*=0.94;vy*=0.94;ry+=vx;rx=clampX(rx+vy);if(idle>1.5&&Math.abs(vx)<0.0008)ry+=0.0009;}
  globe.rotation.y=ry;globe.rotation.x=rx;
  // occlusion: only show pins on the hemisphere facing the camera
  _camDir.copy(camera.position).normalize();
  markerGroup.children.forEach(o=>{ if(!o.userData.dir) return;
    _md.copy(o.userData.dir).applyEuler(globe.rotation);
    o.visible = _md.dot(_camDir) > 0.02; });
  rings.forEach(rg=>{const k=((t*0.5+rg.userData.phase)%1);const s=1+k*5;rg.scale.set(s,s,s);
    rg.material.opacity = rg.visible ? 0.7*(1-k) : 0;});
  if(autoScroll && !feedHover && !detailOpen() && Date.now()>manualPauseUntil && feedEl.scrollHeight>feedEl.clientHeight){
    feedEl.scrollTop += 0.3;
    if(feedEl.scrollTop + feedEl.clientHeight >= feedEl.scrollHeight-1) feedEl.scrollTop=0;
  }
  renderer.render(scene,camera);}
function resize(){renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();}
addEventListener('resize',resize);resize();loop();

/* ================= DATA ================= */
let ALL=[]; const firstSeen=new Map(); let firstLoad=true;

async function loadEvents(manual){
  const btn=document.getElementById('refresh'); btn.classList.add('spin');
  try{
    const r=await fetch('/api/events'); const j=await r.json();
    if(!r.ok) throw new Error(j.detail||j.error||'unavailable');
    const now=Date.now();
    j.events.forEach(e=>{ if(!firstSeen.has(e.id)) firstSeen.set(e.id, firstLoad?0:now); });
    ALL=j.events;
    renderMarkers();
    renderTicker(); buildFilters(); renderCountries(); renderFeed();
    setStatus('Live · '+ALL.length+' events · updated '+new Date(j.generated).toLocaleTimeString('en-GB',IST)+' IST');
    firstLoad=false;
  }catch(e){
    setStatus('Live data unavailable: '+e.message+' — retrying…', true);
  }finally{
    document.getElementById('loader').classList.add('hide');
    setTimeout(()=>btn.classList.remove('spin'),600);
  }
}
function isFresh(id){const s=firstSeen.get(id); return s && (Date.now()-s)<45000;}

/* ticker (auto-scrolling headlines) */
function renderTicker(){
  const list = ALL.slice(0,20);
  const items = list.map(e=>
    `<span class="item"><span class="sw" style="background:${catColor(e.cat)}"></span><b>${esc(e.title)}</b> · ${esc(e.place||e.countryName||'')}</span>`).join('');
  const track = document.getElementById('ticker');
  track.innerHTML = items+items; // duplicate for seamless loop
  // pixels per second ~ constant, slow & readable regardless of how many items
  const dur = Math.max(80, list.length * 9);
  track.style.animationDuration = dur + 's';
}

/* feed */
function esc(s){return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function renderFeed(){
  const q=(document.getElementById('search').value||'').toLowerCase();
  let evs=ALL.filter(e=>activeCats.has(e.cat) && (!activeCountry||e.country===activeCountry)); if(q) evs=evs.filter(e=>(e.title+' '+(e.place||'')+' '+(e.country||'')).toLowerCase().includes(q));
  const keepTop = feedHover ? feedEl.scrollTop : 0;
  if(!evs.length){ feedEl.innerHTML=`<div class="empty">No events${q?' for “'+esc(q)+'”':''} in this filter.</div>`; return; }
  const live=evs.filter(e=>e.live), rest=evs.filter(e=>!e.live);
  let n=0;
  const card=e=>{ n++; return `<button class="card ${isFresh(e.id)?'fresh':''}" data-id="${e.id}">
    <span class="num">${n}</span>
    <div class="r1"><span class="cat" style="color:${catColor(e.cat)}"><span class="sw" style="background:${catColor(e.cat)}"></span>${catOf(e.cat).label}</span>
    ${e.outlet?`<span class="outlet">${esc(e.outlet)}</span>`:''}
    ${isFresh(e.id)?'<span class="newpill">NEW</span>':''}${e.live?'<span class="livepill">LIVE</span>':''}</div>
    <div class="t">${esc(e.title)}</div>
    ${e.summary?`<div class="sm">${esc(e.summary.slice(0,140))}${e.summary.length>140?'…':''}</div>`:''}
    <div class="m">${esc((e.place||e.countryName||'').slice(0,40))}${(e.place||e.countryName)?' · ':''}${esc(e.updated)}</div></button>`; };
  let html='';
  if(live.length) html+=`<div class="glabel">● Live now · ${live.length}</div>`+live.map(card).join('');
  if(rest.length) html+=`<div class="glabel">Recent · ${rest.length}</div>`+rest.map(card).join('');
  feedEl.innerHTML=html;
  if(feedHover) feedEl.scrollTop=keepTop;
}
feedEl.addEventListener('click',e=>{const b=e.target.closest('.card'); if(b) openDetail(ALL.find(x=>x.id==b.dataset.id));});
document.getElementById('search').addEventListener('input',renderFeed);

/* auto-scroll toggle */
const autoBtn=document.getElementById('autoBtn');
autoBtn.onclick=()=>{autoScroll=!autoScroll; autoBtn.classList.toggle('on',autoScroll);};

/* ================= DETAIL + GROQ BRIEF ================= */
const detail=document.getElementById('detail'), detailBody=document.getElementById('detailBody');
function detailOpen(){var d=document.getElementById('detail');return !!(d&&d.classList.contains('show'));}
function closeDetail(){detail.classList.remove('show');}
document.getElementById('back').onclick=closeDetail;
const cell=(k,v)=>(v||v===0)?`<div><div class="k">${k}</div><div class="v">${esc(String(v))}</div></div>`:'';

function openDetail(ev){
  if(!ev) return; flyTo(ev);
  const c=catOf(ev.cat); let facts='';
  if(ev.source==='usgs'){
    facts=`<div class="section"><h4>Measured data · USGS</h4><div class="metagrid">
      ${cell('Magnitude',ev.mag!=null?ev.mag.toFixed(1):'')}${cell('Depth',ev.depth!=null?ev.depth.toFixed(0)+' km':'')}
      ${cell('Place',ev.place)}${cell('When',istFull(ev.time))}
      ${cell('Region',(ev.state?ev.state+', ':'')+(ev.countryName||''))}${cell('Tsunami',ev.tsunami?'Yes':'No')}</div></div>`;
  }else if(ev.source==='rss'){
    facts=`<div class="section"><h4>From ${esc(ev.outlet||'source')}</h4><p>${esc(ev.summary||'No summary provided by the outlet.')}</p></div>
      <div class="section"><h4>Details</h4><div class="metagrid">
      ${cell('Outlet',ev.outlet)}${cell('When',istFull(ev.time))}
      ${cell('Place',ev.place||'—')}${cell('Region',(ev.state?ev.state+', ':'')+(ev.countryName||'—'))}</div></div>`;
  }else if(ev.source==='gdelt'){
    facts=`<div class="section"><h4>Coverage · GDELT</h4>${(ev.articles||[]).map(a=>`<a class="alink" href="${a.url}" target="_blank" rel="noopener">${esc(a.title||a.domain)}<span>${esc(a.domain)}</span></a>`).join('')||'<p>Links unavailable.</p>'}</div>`;
  }
  detailBody.innerHTML=`
    <div class="eyebrow" style="color:${c.color}">${c.label}${ev.live?' · LIVE':''} · ${esc(ev.outlet||ev.source.toUpperCase())}</div>
    <div class="dtitle">${esc(ev.title)}</div>
    <div class="aibox"><div class="badge">AI brief · Groq</div><div id="aibody"><span class="spinner"></span>Generating…</div></div>
    ${facts}
    ${ev.url?`<a class="btn" href="${ev.url}" target="_blank" rel="noopener">Read full article →</a>`:''}`;
  detail.classList.add('show');
  loadBrief(ev);
}

async function loadBrief(ev){
  const body=document.getElementById('aibody'); if(!body)return;
  try{
    const r=await fetch('/api/brief',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event:ev})});
    const j=await r.json(); if(!r.ok) throw new Error(j.detail||j.error||'failed');
    body.innerHTML=
      `<p style="margin:0;font-size:13px;line-height:1.55">${esc(j.summary||'')}</p>`+
      (j.why_it_matters?`<div style="font-family:var(--mono);font-size:9px;letter-spacing:.14em;color:var(--faint);text-transform:uppercase;margin:9px 0 3px">Why it matters</div><p style="margin:0;font-size:12.5px;line-height:1.5;color:#cfd5e4">${esc(j.why_it_matters)}</p>`:'')+
      ((j.affected&&j.affected.length)?`<div class="chips" style="margin-top:9px">${j.affected.map(a=>`<span class="chip">${esc(a)}</span>`).join('')}</div>`:'')+
      (typeof j.confidence==='number'?`<div class="confbar"><i style="width:${j.confidence}%"></i></div><div style="font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:4px">confidence ${j.confidence}%</div>`:'');
  }catch(e){
    body.innerHTML=`<p style="margin:0;color:var(--muted);font-size:12.5px">Couldn’t generate the brief: ${esc(e.message)}.</p><button class="btn" id="retry">Retry</button>`;
    const rb=document.getElementById('retry'); if(rb) rb.onclick=()=>{body.innerHTML='<span class="spinner"></span>Generating…';loadBrief(ev);};
  }
}

/* misc */
function setStatus(text,warn){document.getElementById('status').classList.toggle('warn',!!warn);
  document.getElementById('statusText').textContent=text;}
function renderLegend(){document.getElementById('legend').innerHTML=CAT_ORDER.map(c=>
  `<span class="li"><span class="sw" style="background:${CATS[c].color}"></span>${CATS[c].label}</span>`).join('');}
document.getElementById('refresh').onclick=()=>loadEvents(true);
setInterval(()=>{document.getElementById('clock').textContent=istClock();},1000);

/* theme selector */
function initThemeSelector(){
  const sel=document.getElementById('themeSel'); if(!sel) return;
  sel.innerHTML=THEMES.map(([v,l])=>`<option value="${v}">${l}</option>`).join('');
  sel.value=curTheme;
  sel.onchange=()=>applyTheme(sel.value);
}
/* category filter chips with live counts */
function catCounts(){ const m={}; ALL.forEach(e=>{ m[e.cat]=(m[e.cat]||0)+1; }); return m; }
function buildFilters(){
  const el=document.getElementById('filters'); if(!el) return;
  const cnt=catCounts(); const all=activeCats.size===CAT_ORDER.length;
  let html=`<span class="chipf allchip ${all?'':'off'}" data-cat="__all">All <b>${ALL.length}</b></span>`;
  html+=CAT_ORDER.map(c=>`<span class="chipf ${activeCats.has(c)?'':'off'}" data-cat="${c}"><span class="sw" style="background:${CATS[c].color}"></span>${CATS[c].label} <b>${cnt[c]||0}</b></span>`).join('');
  el.innerHTML=html;
}
function saveCats(){ try{ localStorage.setItem('orbit_cats', JSON.stringify([...activeCats])); }catch(e){} }
document.getElementById('filters').addEventListener('click',e=>{
  const chip=e.target.closest('.chipf'); if(!chip) return;
  const c=chip.dataset.cat;
  if(c==='__all'){ activeCats=new Set(CAT_ORDER); }                       // show all
  else if(activeCats.size===1 && activeCats.has(c)){ activeCats=new Set(CAT_ORDER); } // tap again -> all
  else { activeCats=new Set([c]); }                                       // isolate just this category
  saveCats(); buildFilters(); renderMarkers(); renderFeed();
});

renderLegend();
initThemeSelector();
buildFilters();

/* country-wise left panel */
let _countryNames = [];
function renderCountries(){
  const el=document.getElementById('clist'); if(!el) return;
  const m={}; ALL.forEach(e=>{ if(e.country) m[e.country]=(m[e.country]||0)+1; });
  _countryNames = Object.keys(m).sort((a,b)=>m[b]-m[a]);
  let html=`<button class="crow ${activeCountry?'':'sel'}" data-i="-1">All countries <span class="cc">${ALL.length}</span></button>`;
  html+=_countryNames.map((n,i)=>`<button class="crow ${activeCountry===n?'sel':''}" data-i="${i}">${esc(n)} <span class="cc">${m[n]}</span></button>`).join('');
  el.innerHTML=html;
}
document.getElementById('clist').addEventListener('click',e=>{
  const b=e.target.closest('.crow'); if(!b) return;
  const i=parseInt(b.dataset.i,10);
  activeCountry = (i<0) ? '' : (_countryNames[i]||'');
  try{ localStorage.setItem('orbit_country', activeCountry); }catch(_){}
  renderCountries(); renderMarkers(); renderFeed();
});

loadEvents();
setInterval(loadEvents, REFRESH_MS);

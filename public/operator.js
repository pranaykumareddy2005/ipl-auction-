'use strict';
// Operator console logic (MULTI-ROOM). All writes go through cmd() -> Bus.command
// scoped to this room with the auctioneer host key. State comes only from the SSE
// snapshot; this UI never trusts itself.
const $ = (id) => document.getElementById(id);
const fmtL = Bus.fmtL, esc = Bus.esc;

const LS={get(k){try{return localStorage.getItem(k)}catch(e){return null}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};

// Room gating: this console only works inside a room.
if (!Bus.ROOM) { location.replace('index.html'); }
const HOST_LS_KEY = 'ipl_host_' + Bus.ROOM;
function getKey(){ return LS.get(HOST_LS_KEY) || ''; }
function setKey(k){ LS.set(HOST_LS_KEY, k || ''); }

let snap = null;
let catalog = [];          // all players {sr,name,role,country,cu,base}
let bySr = {};
let cats = {};
let poolOrder = [];        // full auction-queue order (source of truth while editing)
let catFilter = 'ALL';

const DEFAULT_TEAMS = [
  ['Chennai Super Kings','CSK','#f9cd05'],['Mumbai Indians','MI','#1f6bd6'],
  ['Royal Challengers Bengaluru','RCB','#e2231a'],['Kolkata Knight Riders','KKR','#7b3fbf'],
  ['Rajasthan Royals','RR','#e8388b'],['Delhi Capitals','DC','#2561c2'],
  ['Sunrisers Hyderabad','SRH','#f26522'],['Gujarat Titans','GT','#1eb2c4'],
  ['Punjab Kings','PBKS','#d71920'],['Lucknow Super Giants','LSG','#00a19a'],
];
let teamDraft = DEFAULT_TEAMS.map((t,i)=>({id:i,name:t[0],short:t[1],color:t[2],owner:'',purseL:12000}));

let pinMap = {};        // teamId -> passcode (loaded from the host-only endpoint)
let _presSig = '';      // last-seen presence signature (presence changes don't bump rev)

// Load every team's passcode (host key required). Safe to call repeatedly.
async function loadPins(){
  if(!getKey()) return;
  const r = await Bus.teamsAuth(getKey());
  if(r && r.ok){ pinMap={}; (r.teams||[]).forEach(t=>{ pinMap[Number(t.teamId)] = t.pin; }); if(snap) renderLobby(snap); }
}

// Room lobby: who is online + each team's passcode (shown on the setup screen).
function renderLobby(s){
  const box = $('lobbyList'); if(!box) return;
  const teams = (s && s.teams) || [];
  const online = new Set(((s && s.presence && s.presence.teams) || []).map(Number));
  const ops = (s && s.presence && s.presence.operators) || 0;
  if(!teams.length){ box.innerHTML='<div class="dim" style="padding:10px">Save your teams above, then each team\'s passcode appears here.</div>';
    $('lobbySummary').textContent='No teams yet — save teams to generate passcodes.'; return; }
  const onCount = teams.filter(t=>online.has(Number(t.teamId))).length;
  $('lobbySummary').innerHTML = `<b style="color:var(--gold)">${onCount}</b> of ${teams.length} teams online`
    + ` · operator console ${ops>0?'<b style="color:#7ee0a1">connected</b>':'offline'}`;
  box.innerHTML = teams.map(t=>{
    const id=Number(t.teamId); const isOn=online.has(id);
    const pin = pinMap[id] || '——';
    return `<div class="qitem">
      <span class="sw" style="width:12px;height:12px;border-radius:3px;background:${esc(t.color||'#888')}"></span>
      <span class="nm">${esc(t.name)}
        <span class="tag" style="background:${isOn?'#123a24':'#2a2030'};color:${isOn?'#7ee0a1':'var(--mut)'};font-weight:700">${isOn?'● Online':(t.claimed?'○ Claimed · away':'○ Not joined')}</span>
      </span>
      <span class="mono" style="letter-spacing:2px;font-size:15px">${esc(pin)}</span>
      <button class="btn sm ghost" onclick="doRegen(${id})">Regenerate</button>
    </div>`;
  }).join('');
}
window.doRegen = async(teamId)=>{
  if(!confirm('New passcode for this team? Their current device (if any) will be signed out.')) return;
  const r = await Bus.regenPin(teamId, getKey());
  if(r && r.ok){ pinMap[Number(teamId)] = r.pin; if(snap) renderLobby(snap); Bus.toast('New passcode: '+r.pin,'ok'); }
  else { Bus.toast((r&&r.error)||'Could not regenerate','err'); if(r&&/auctioneer key/i.test(r.error||'')) showKey(); }
};

// ---------- command wrapper ----------
async function cmd(name, payload) {
  const r = await Bus.command(name, payload, getKey());
  if (!r.ok) { Bus.toast(r.error || 'Rejected', 'err'); if (/auctioneer key/i.test(r.error||'')) showKey(); }
  else if (r.warning) { Bus.toast('⚠ ' + r.warning, 'err'); }
  return r;
}

// ---------- boot ----------
async function boot() {
  if (!Bus.ROOM) return;
  initShare();
  if (!getKey()) showKey();
  const d = await Bus.getJSON('/api/players');   // global player catalog (not room-scoped)
  catalog = d.players; cats = d.cats; window.__stars = d.stars || {};
  bySr = {}; catalog.forEach(p => bySr[p.sr] = p);
  buildCatSeg();
  renderTeamEditor();
  const pool = await Bus.getJSON(Bus.base() + '/pool');
  poolOrder = pool.order.slice();
  renderCatalog(); renderQueueEditor();
  conn = Bus.connect(onState, on => Bus.connBadge(on), { role:'operator', key:getKey() });
  loadPins();
}
let conn = null;

// ---------- SHARE panel ----------
function initShare() {
  const origin = location.origin;
  const join = `${origin}/join.html?room=${Bus.ROOM}`;
  const pres = `${origin}/presentation.html?room=${Bus.ROOM}`;
  const rep  = `${origin}/report.html?room=${Bus.ROOM}`;
  const set = (id,v)=>{ const el=$(id); if(el){ if(el.tagName==='INPUT') el.value=v; else el.textContent=v; } };
  const href = (id,v)=>{ const el=$(id); if(el) el.href=v; };
  set('shareRoomCode', Bus.ROOM);
  set('barRoomCode', Bus.ROOM);
  set('joinLink', join);
  set('presLink', pres);
  href('viewAuctionBtn', pres);
  href('presOpenBtn', pres);
  href('reportBtn', rep);
}
window.copyField=async(inputId, btn)=>{
  const el=$(inputId); if(!el) return;
  const label=btn.textContent;
  try{ await navigator.clipboard.writeText(el.value); }
  catch(e){ el.select(); prompt('Copy this link:', el.value); return; }
  btn.textContent='✓ Copied';
  setTimeout(()=>{ btn.textContent=label; },1400);
};

let _lastRev = -1, _lastPhase = '';
function onState(s) {
  snap = s;
  timerSync(s); // keep the countdown in sync cheaply, every snapshot
  // Presence (who's online) changes WITHOUT bumping rev, so refresh the lobby +
  // live team list whenever it moves, independent of the heavy-rebuild guard below.
  const pres = s.presence || { teams: [], operators: 0 };
  const psig = (pres.teams || []).slice().sort((a,b)=>a-b).join(',') + '|' + pres.operators;
  if (psig !== _presSig) { _presSig = psig; renderLobby(s); if (s.phase !== 'setup') renderTeamsList(s); }
  // Skip the heavy DOM rebuild when nothing actually changed (e.g. per-second
  // timer ticks): rev only advances on real events. The 200ms timer loop still
  // updates the countdown locally.
  if (s.rev === _lastRev && s.phase === _lastPhase) return;
  _lastRev = s.rev; _lastPhase = s.phase;
  $('phase').className = 'pill ' + s.phase;
  $('phaseText').textContent = {setup:'Setup',live:'Live',paused:'Paused',complete:'Complete'}[s.phase] || s.phase;
  $('progress').textContent = `Sold ${s.counts.sold} · Unsold ${s.counts.unsold} · Left ${s.counts.pool}`;
  $('roundlbl').textContent = s.round === 'unsold' ? 'Unsold Round' : 'Auction 2026';
  $('pauseBtn').textContent = s.phase === 'paused' ? 'Resume' : 'Pause';
  $('pauseBtn').className = 'btn sm ' + (s.phase === 'paused' ? 'green' : '');

  const inSetup = s.phase === 'setup';
  $('setup').classList.toggle('hide', !inSetup);
  $('live').classList.toggle('hide', inSetup);
  if (inSetup) { $('poolCount').textContent = `(${poolOrder.length} players)`; syncSettingsForm(s); }
  else renderLive(s);
  renderLobby(s);
  // Teams may have just been (re)saved -> make sure their passcodes are loaded.
  if ((s.teams||[]).length && Object.keys(pinMap).length < (s.teams||[]).length) loadPins();
}

// ================= SETUP: teams =================
function renderTeamEditor() {
  $('teamEditor').innerHTML = `<div class="teamrow teamhead">
      <span>Team name</span><span>Abbr</span><span>Colour</span><span>Owner</span><span></span></div>` +
    teamDraft.map((t,i)=>`
    <div class="teamrow">
      <input value="${esc(t.name)}" oninput="editTeam(${i},'name',this.value)" placeholder="Team name">
      <input value="${esc(t.short)}" oninput="editTeam(${i},'short',this.value)" placeholder="ABR">
      <input type="color" value="${t.color}" oninput="editTeam(${i},'color',this.value)" style="width:38px;padding:2px;height:38px">
      <input value="${esc(t.owner)}" oninput="editTeam(${i},'owner',this.value)" placeholder="Owner (optional)">
      <button class="btn sm red ghost" onclick="delTeam(${i})">✕</button>
    </div>`).join('');
}
window.editTeam=(i,k,v)=>{ teamDraft[i][k]=v; };
window.delTeam=(i)=>{ teamDraft.splice(i,1); teamDraft.forEach((t,j)=>t.id=j); renderTeamEditor(); };
window.addTeam=()=>{ teamDraft.push({id:teamDraft.length,name:'Team '+(teamDraft.length+1),short:'T'+(teamDraft.length+1),color:'#888',owner:'',purseL:12000}); renderTeamEditor(); };
window.resetTeams=()=>{ teamDraft=DEFAULT_TEAMS.map((t,i)=>({id:i,name:t[0],short:t[1],color:t[2],owner:'',purseL:12000})); renderTeamEditor(); };

async function saveSettings() {
  const purseCr = Number($('setPurse').value)||120;
  const settings = { purseL: Math.round(purseCr*100), squadMax:Number($('setSquad').value)||25,
    overseasMax:Number($('setOverseas').value)||8, timerSec:Number($('setTimer').value)||20 };
  let r = await cmd('configure', { settings });
  if (!r.ok) return;
  const teams = teamDraft.map((t,i)=>({ id:i, name:t.name, short:t.short, color:t.color, owner:t.owner, purseL:settings.purseL }));
  r = await cmd('setTeams', { teams });
  if (!r.ok) return;
  Bus.toast('Settings & teams saved', 'ok');
}
window.saveSettings=saveSettings;

// Reflect existing settings back into the setup form (purse shown in Cr).
function syncSettingsForm(s){
  if (!s || !s.settings) return;
  if (document.activeElement && document.activeElement.tagName==='INPUT') return;
  $('setPurse').value = Math.round((s.settings.purseL||0)/100);
  $('setSquad').value = s.settings.squadMax;
  $('setOverseas').value = s.settings.overseasMax;
  $('setTimer').value = s.settings.timerSec;
}

// ================= SETUP: pool =================
function buildCatSeg() {
  const order=['ALL','M','BA','WK','AL','FA','SP','UBA','UAL','UWK','UFA','USP'];
  $('catSeg').innerHTML = order.filter(c=>c==='ALL'||cats[c]).map(c=>{
    const lbl = c==='ALL'?'ALL':(cats[c]?cats[c].label:c);
    return `<button class="${c===catFilter?'on':''}" onclick="setCat('${c}',event)">${esc(lbl)}</button>`;
  }).join('');
}
window.setCat=(c,e)=>{ catFilter=c; [...$('catSeg').children].forEach(b=>b.classList.remove('on')); e.target.classList.add('on'); renderCatalog(); };

function catOf(p){ if(!p) return '-'; if(window.__stars&&window.__stars[p.name]) return 'M';
  const map={BATTER:['BA','UBA'],WICKETKEEPER:['WK','UWK'],'ALL-ROUNDER':['AL','UAL'],BOWLER:['FA','UFA']};
  const pair=map[p.role]; if(!pair) return '-'; return (p.cu&&p.cu!=='Capped')?pair[1]:pair[0]; }

function filteredCatalog() {
  const q=($('poolSearch').value||'').toLowerCase().trim();
  const inPool=new Set(poolOrder);
  return catalog.filter(p=>{
    if(inPool.has(p.sr)) return false;
    if(catFilter!=='ALL' && catOf(p)!==catFilter) return false;
    if(q && !(p.name.toLowerCase().includes(q)||(p.country||'').toLowerCase().includes(q))) return false;
    return true;
  });
}
function renderCatalog() {
  const list=filteredCatalog().slice(0,300);
  $('catalog').innerHTML = list.map(p=>rowCatalog(p)).join('') || '<div class="dim" style="padding:10px">No players — all added or none match.</div>';
  $('poolCount').textContent=`(${poolOrder.length} players)`;
}
function rowCatalog(p){
  const c='#'+((cats[catOf(p)]&&cats[catOf(p)].c)||'888');
  return `<div class="qitem"><span class="tag" style="background:${c}22;color:${c}">${esc((p.role||'?').slice(0,2))}</span>
    <span class="nm">${esc(p.name)} <span class="dim">· ${esc(p.country||'')} · base ${fmtL(p.base)}</span></span>
    <button class="btn sm gold" onclick="addToPool(${p.sr})">+ Add</button></div>`;
}
window.addToPool=async(sr)=>{ if(!poolOrder.includes(sr)) poolOrder.push(sr); await pushPool(); renderCatalog(); renderQueueEditor(); };
window.addAllFiltered=async()=>{ filteredCatalog().forEach(p=>{ if(!poolOrder.includes(p.sr)) poolOrder.push(p.sr); }); await pushPool(); renderCatalog(); renderQueueEditor(); Bus.toast('Added to pool','ok'); };
window.addMarquee=async()=>{ const m=catalog.filter(p=>catOf(p)==='M'); m.forEach(p=>{ if(!poolOrder.includes(p.sr)) poolOrder.unshift(p.sr); }); await pushPool(); renderCatalog(); renderQueueEditor(); };
window.clearPool=async()=>{ if(!confirm('Clear the entire auction queue?'))return; poolOrder=[]; await pushPool(); renderCatalog(); renderQueueEditor(); };
window.shufflePool=async()=>{ for(let i=poolOrder.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[poolOrder[i],poolOrder[j]]=[poolOrder[j],poolOrder[i]];} await pushPool(); renderQueueEditor(); };
window.reversePool=async()=>{ poolOrder.reverse(); await pushPool(); renderQueueEditor(); };

function renderQueueEditor() {
  const el=$('queueEditor');
  el.innerHTML = poolOrder.slice(0,400).map((sr,i)=>{ const p=bySr[sr]; if(!p)return'';
    return `<div class="qitem"><span class="dim" style="width:28px">${i+1}</span>
      <span class="nm">${esc(p.name)} <span class="dim">· ${fmtL(p.base)}</span></span>
      <button class="btn sm ghost" onclick="moveQ(${i},-1)">▲</button>
      <button class="btn sm ghost" onclick="moveQ(${i},1)">▼</button>
      <button class="btn sm red ghost" onclick="removeQ(${i})">✕</button></div>`;
  }).join('') || '<div class="dim" style="padding:10px">Add players from the catalog to build the queue.</div>';
  if(poolOrder.length>400) el.innerHTML+=`<div class="dim" style="padding:8px">…and ${poolOrder.length-400} more</div>`;
}
window.moveQ=async(i,d)=>{ const j=i+d; if(j<0||j>=poolOrder.length)return; [poolOrder[i],poolOrder[j]]=[poolOrder[j],poolOrder[i]]; await pushPool(); renderQueueEditor(); };
window.removeQ=async(i)=>{ poolOrder.splice(i,1); await pushPool(); renderCatalog(); renderQueueEditor(); };

let pushT;
function pushPool(){ return new Promise(res=>{ clearTimeout(pushT); pushT=setTimeout(async()=>{ await cmd('setQueue',{order:poolOrder}); res(); },120); }); }

async function startAuction() {
  if (poolOrder.length===0) { Bus.toast('Add players to the pool first','err'); return; }
  await cmd('setQueue',{order:poolOrder});
  const r = await cmd('start');
  if (r.ok) Bus.toast('Auction started! 🔨','ok');
}
window.startAuction=startAuction;
window.setupTab=(t,e)=>{ $('tab-teams').classList.toggle('hide',t!=='teams'); $('tab-pool').classList.toggle('hide',t!=='pool');
  [...document.querySelectorAll('#setup .tabs button')].forEach(b=>b.classList.remove('on')); e.target.classList.add('on'); };

// ================= LIVE =================
function renderLive(s) {
  const p=s.current, b=s.bidding;
  $('curCode').textContent = p?((p.code||'')+(p.cu?(' · '+p.cu):'')):'';
  $('curName').textContent = p?p.name:(s.phase==='complete'?'🏆 Auction complete':'No player on the block');
  $('curMeta').innerHTML = p?[
    `<span class="tag" style="background:#20305f;color:#bcd">${esc(p.role||'')}</span>`,
    `<span class="tag" style="background:#20305f;color:#bcd">${esc(p.country||'')}</span>`,
    `<span class="tag" style="background:#20305f;color:#bcd">Base ${fmtL(p.base)}</span>`
  ].join(' '):'';

  if (b && b.currentBidL!=null) {
    $('bidNow').textContent = fmtL(b.currentBidL);
    const lt=s.teams.find(t=>t.teamId===b.leadingTeamId);
    $('leadNow').innerHTML = lt?`Leading: <b style="color:var(--gold)">${esc(lt.name)}</b>`:'';
    $('nextHint').textContent = `next min ${fmtL(b.nextMinL)} (+${fmtL(b.step)})`;
  } else if (b) {
    $('bidNow').textContent = fmtL(b.baseL);
    $('leadNow').textContent = 'Opening — no bids yet';
    $('nextHint').textContent = `first bid ${fmtL(b.nextMinL)}`;
  } else { $('bidNow').textContent='—'; $('leadNow').textContent=''; $('nextHint').textContent=''; }

  renderBidGrid(s);
  renderQueueLive(s);
  renderHeld(s); renderTeamsList(s); renderLog(); renderAdjTeams(s);
  timerSync(s);
}

function renderBidGrid(s) {
  const b=s.bidding;
  const canBid = s.phase==='live' && b;
  const osPlayer = s.current && s.current.country && s.current.country!=='India';
  $('bidGrid').innerHTML = s.teams.map(t=>{
    const lead = b && b.leadingTeamId===t.teamId;
    const nextAmt = b ? b.nextMinL : 0;
    const overCap = osPlayer && t.overseas>=s.settings.overseasMax;
    const afford = b ? (t.maxBidL>=nextAmt && t.slotsLeft>0 && !overCap) : true;
    const dis = !canBid || lead || !afford;
    const col = esc(t.color||'#888');
    const why = lead?'🔨 leading':(t.slotsLeft<=0?'squad full':(overCap?'overseas full':(afford?('bid '+fmtL(nextAmt)):'cannot afford')));
    return `<button class="tbid ${lead?'lead':''}" style="--tc:${col}" ${dis?'disabled':''} onclick="bid(${t.teamId})">
      <div class="tn"><span class="sw" style="background:${col}"></span>${esc(t.short||t.name)}</div>
      <div class="rm num">${fmtL(t.remaining)}</div>
      <div class="mx">${why} · ${t.count}p</div>
    </button>`;
  }).join('');
}
// Continuous bidding is expected. We only stop a team's taps from OVERLAPPING (one
// request per team in flight); as soon as it returns, the next raise can fire. A late
// tap after that team already leads is rejected by the server and swallowed silently,
// so rapid card-raising never spams errors or double-counts.
const _bidBusy = {};
window.bid=async(teamId)=>{
  if(_bidBusy[teamId]) return;
  _bidBusy[teamId]=true;
  try{
    const custom=$('customBid').value.trim();
    const payload={teamId}; if(custom) payload.amountL=Number(custom);
    if(snap&&snap.current) payload.expectedSr=snap.current.sr;   // don't bid on a player who just changed
    const r=await Bus.command('placeBid',payload,getKey());
    if(r.ok){ $('customBid').value=''; }
    else if(/already.*lead|leading bid/i.test(r.error||'')){ /* late tap after they already lead — no-op */ }
    else { Bus.toast(r.error||'Rejected','err'); if(/auctioneer key/i.test(r.error||'')) showKey(); }
  } finally { _bidBusy[teamId]=false; }
};
window.doSold=async()=>{ const custom=$('customBid').value.trim(); const payload={}; if(custom)payload.priceL=Number(custom);
  const r=await cmd('sold',payload); if(r.ok){ $('customBid').value=''; Bus.toast('Sold!','ok'); } };
window.correctBid=async()=>{
  if(!snap||!snap.bidding||snap.bidding.leadingTeamId==null){Bus.toast('No bid to correct','err');return;}
  const name=prompt('Correct the last bid to which team? Enter team short code or number:'); if(!name)return;
  const t=snap.teams.find(x=>(x.short||'').toLowerCase()===name.toLowerCase()||String(x.teamId)===name||x.name.toLowerCase()===name.toLowerCase());
  if(!t){Bus.toast('Team not found','err');return;}
  const amt=prompt('Corrected amount in ₹L (blank = same as current):', snap.bidding.currentBidL);
  const payload={teamId:t.teamId}; if(amt&&amt.trim()) payload.amountL=Number(amt);
  const r=await cmd('correctBid',payload); if(r.ok)Bus.toast('Bid corrected','ok');
};
window.callNext=async()=>{ if(!snap||snap.poolCount===0){Bus.toast('Queue is empty','err');return;}
  if(snap.queuePreview[0]) await cmd('present',{sr:snap.queuePreview[0].sr}); };

// live queue + search-to-next
function renderQueueLive(s){
  $('poolLeft').textContent=s.counts.pool;
  $('queueLive').innerHTML = s.queuePreview.map((p,i)=>`<div class="qitem">
    <span class="dim" style="width:22px">${i+1}</span>
    <span class="nm">${esc(p.name)} <span class="dim">· ${fmtL(p.base)}</span></span>
    <button class="btn sm blue" onclick="cmd('setNext',{sr:${p.sr}})">Next</button>
    <button class="btn sm gold" onclick="cmd('present',{sr:${p.sr}})">Call</button></div>`).join('')
    || '<div class="dim" style="padding:10px">Queue empty.</div>';
}
window.renderLiveSearch=()=>{
  const q=($('liveSearch').value||'').toLowerCase().trim(); if(!q){$('liveSearchRes').innerHTML='';return;}
  const res=catalog.filter(p=>p.name.toLowerCase().includes(q)).slice(0,8);
  $('liveSearchRes').innerHTML=res.map(p=>`<div class="qitem"><span class="nm">${esc(p.name)}</span>
    <button class="btn sm blue" onclick="cmd('setNext',{sr:${p.sr}})">Bring next</button></div>`).join('');
};

function renderHeld(s){
  $('heldList').innerHTML=(s.held||[]).map(p=>`<div class="qitem"><span class="nm">${esc(p.name)}</span>
    <button class="btn sm blue" onclick="cmd('bringHeldNext',{sr:${p.sr}})">Bring next</button></div>`).join('')||'<div class="dim" style="padding:8px">None</div>';
  $('skipList').innerHTML=(s.skipped||[]).map(p=>`<div class="qitem"><span class="nm">${esc(p.name)}</span>
    <button class="btn sm blue" onclick="cmd('setNext',{sr:${p.sr}})">Requeue next</button></div>`).join('')||'<div class="dim" style="padding:8px">None</div>';
}
function renderTeamsList(s){
  const online=new Set(((s.presence&&s.presence.teams)||[]).map(Number));
  $('teamsList').innerHTML=s.teams.map(t=>{
    const isOn=online.has(Number(t.teamId));
    const status = isOn
      ? `<span class="tag" style="background:#123a24;color:#7ee0a1;font-weight:700">● Online</span>
         <button class="btn sm red ghost" onclick="doRelease(${t.teamId})">Release</button>`
      : t.claimed
      ? `<span class="tag" style="background:#3a2a12;color:#e0c07e;font-weight:700">Away</span>
         <button class="btn sm red ghost" onclick="doRelease(${t.teamId})">Release</button>`
      : `<span class="tag" style="background:#20263a;color:var(--mut)">Not joined</span>`;
    return `<div class="qitem">
    <span class="sw" style="width:12px;height:12px;border-radius:3px;background:${esc(t.color||'#888')}"></span>
    <span class="nm">${esc(t.name)} <span class="dim">· ${t.count}p · ${t.overseas}os</span></span>
    ${status}
    <span class="mono">${fmtL(t.remaining)}</span></div>`;
  }).join('');
}
window.doRelease=async(teamId)=>{
  const t=(snap&&snap.teams||[]).find(x=>x.teamId===teamId);
  const nm=t?t.name:('Team '+teamId);
  if(!confirm(`Release ${nm}? Their device will be signed out.`)) return;
  const r=await Bus.releaseTeam(teamId, getKey());
  if(r&&r.ok){ Bus.toast(`${nm} released`,'ok'); }
  else { Bus.toast((r&&r.error)||'Could not release','err'); if(r&&/auctioneer key/i.test(r.error||'')) showKey(); }
};
function renderAdjTeams(s){
  const cur=$('adjTeam').value;
  $('adjTeam').innerHTML=s.teams.map(t=>`<option value="${t.teamId}">${esc(t.name)}</option>`).join('');
  if(cur)$('adjTeam').value=cur;
}
window.doAdjust=async()=>{ const teamId=Number($('adjTeam').value); const deltaL=Number($('adjAmt').value);
  if(!deltaL){Bus.toast('Enter an amount','err');return;}
  const r=await cmd('adjustPurse',{teamId,deltaL,reason:$('adjReason').value}); if(r.ok){Bus.toast('Purse adjusted','ok');$('adjAmt').value='';$('adjReason').value='';} };

window.renderReopen=()=>{
  const q=($('reopenSearch').value||'').toLowerCase().trim();
  // sold players come from team squads in snapshot
  const sold=[]; (snap.teams||[]).forEach(t=>t.squad.forEach(p=>sold.push({...p,team:t.name,teamId:t.teamId})));
  const res=sold.filter(p=>!q||p.name.toLowerCase().includes(q)).slice(0,30);
  $('reopenList').innerHTML=res.map(p=>`<div class="qitem"><span class="nm">${esc(p.name)} <span class="dim">· ${esc(p.team)} · ${fmtL(p.priceL)}</span></span>
    <button class="btn sm red" onclick="doReopen(${p.sr})">Reopen</button></div>`).join('')||'<div class="dim" style="padding:8px">No sold players.</div>';
};
window.doReopen=async(sr)=>{ if(!confirm('Reopen this player? The team will be refunded and the player re-auctioned.'))return;
  const r=await cmd('reopen',{sr}); if(r.ok)Bus.toast('Player reopened & refunded','ok'); };

async function renderLog(){
  const d=await Bus.getJSON(Bus.base()+'/history?limit=60');
  const evs=d.events.slice().reverse();
  $('logList').innerHTML=evs.map(e=>{
    const t=new Date(e.ts).toLocaleTimeString();
    const desc=describe(e);
    return `<div class="qitem" style="${e.voided?'opacity:.4;text-decoration:line-through':''}">
      <span class="dim mono" style="width:70px">${t}</span><span class="nm">${esc(desc)}</span></div>`;
  }).join('');
}
function describe(e){
  const d=e.data||{}; const nm=(sr)=>{const p=bySr[sr];return p?p.name:('#'+sr);};
  const tn=(id)=>{const t=(snap.teams||[]).find(x=>x.teamId===id);return t?t.name:('T'+id);};
  switch(e.type){
    case 'BID_PLACED':return `${tn(d.teamId)} bid ${fmtL(d.amountL)} — ${nm(d.sr)}`;
    case 'PLAYER_SOLD':return `SOLD ${nm(d.sr)} → ${tn(d.teamId)} for ${fmtL(d.priceL)}`;
    case 'PLAYER_UNSOLD':return `UNSOLD ${nm(d.sr)}`;
    case 'PLAYER_PRESENTED':return `Presented ${nm(d.sr)}`;
    case 'PLAYER_HELD':return `Held ${nm(d.sr)}`;
    case 'PLAYER_SKIPPED':return `Skipped ${nm(d.sr)}`;
    case 'PLAYER_REOPENED':return `Reopened ${nm(d.sr)}`;
    case 'PURSE_ADJUSTED':return `Purse ${d.deltaL>0?'+':''}${fmtL(d.deltaL)} → ${tn(d.teamId)} (${d.reason||''})`;
    case 'UNDO':return `↩ Undo (${d.targetType||''})`;
    case 'AUCTION_STARTED':return 'Auction started';
    case 'AUCTION_PAUSED':return 'Paused'; case 'AUCTION_RESUMED':return 'Resumed';
    case 'AUCTION_COMPLETED':return 'Auction completed';
    case 'UNSOLD_ROUND_STARTED':return 'Unsold round started';
    case 'QUEUE_SET':return `Queue set (${(d.order||[]).length})`;
    case 'PLAYER_SET_NEXT':return `Set next: ${nm(d.sr)}`;
    case 'HELD_BROUGHT_NEXT':return `Brought held next: ${nm(d.sr)}`;
    case 'TEAMS_SET':return `Teams set (${(d.teams||[]).length})`;
    case 'AUCTION_CONFIGURED':return 'Settings configured';
    default:return e.type;
  }
}

window.togglePause=()=>{ if(!snap)return; cmd(snap.phase==='paused'?'resume':'pause'); };
window.liveTab=(t,e)=>{ ['queue','held','teams','fix','log'].forEach(k=>$('lt-'+k).classList.toggle('hide',k!==t));
  [...document.querySelectorAll('#live .tabs button')].forEach(b=>b.classList.remove('on')); e.target.classList.add('on');
  if(t==='log')renderLog(); if(t==='fix')renderReopen(); if(t==='teams'&&snap)renderTeamsList(snap); };

// present modal
window.openPresent=()=>{ $('presentModal').classList.remove('hide'); renderPresent(); $('presentSearch').focus(); };
window.closeModal=(id)=>$(id).classList.add('hide');
window.renderPresent=()=>{
  const q=($('presentSearch').value||'').toLowerCase().trim();
  const src = q ? catalog.filter(p=>p.name.toLowerCase().includes(q)).slice(0,40) : (snap.queuePreview||[]);
  $('presentList').innerHTML=src.map(p=>`<div class="qitem"><span class="nm">${esc(p.name)} <span class="dim">· ${fmtL(p.base)}</span></span>
    <button class="btn sm gold" onclick="presentPick(${p.sr})">Put on block</button></div>`).join('')||'<div class="dim" style="padding:8px">No match.</div>';
};
window.presentPick=async(sr)=>{ await cmd('setNext',{sr}); const r=await cmd('present',{sr}); if(r.ok){closeModal('presentModal');} };

// timer
let endsAt=null,dur=0;
function timerSync(s){ const t=s.timer; if(t&&t.running&&t.remainingMs>0){endsAt=Date.now()+t.remainingMs;dur=t.durationMs;} else if(!(t&&t.running)){endsAt=null;} }
let wasTimeUp=false, _actx;
function beep(){ try{ _actx=_actx||new (window.AudioContext||window.webkitAudioContext)(); const o=_actx.createOscillator(),g=_actx.createGain(); o.frequency.value=880; o.connect(g); g.connect(_actx.destination); g.gain.setValueAtTime(0.0001,_actx.currentTime); g.gain.exponentialRampToValueAtTime(0.25,_actx.currentTime+0.01); g.gain.exponentialRampToValueAtTime(0.0001,_actx.currentTime+0.35); o.start(); o.stop(_actx.currentTime+0.36);}catch(e){} }
function clearTimeUp(){ const s=$('soldBtn'),u=$('unsoldBtn'),m=$('timerMsg'),el=$('timerNum'); if(el)el.classList.remove('timeup'); if(m)m.style.display='none'; if(s)s.classList.remove('pulse'); if(u)u.classList.remove('pulse'); wasTimeUp=false; }
setInterval(()=>{ const el=$('timerNum'); if(!el)return;
  const onBlock=!!(snap&&snap.current);
  if(endsAt){
    const ms=Math.max(0,endsAt-Date.now()), sec=Math.ceil(ms/1000);
    el.textContent=sec; el.style.color=sec<=5?'#e63946':'';
    if(ms<=0 && onBlock){
      const hasBid=!!(snap&&snap.bidding&&snap.bidding.leadingTeamId!=null);
      el.textContent='0'; el.classList.add('timeup');
      const m=$('timerMsg'); if(m){ m.textContent=hasBid?'⏰ Time up — hit SOLD':'⏰ Time up — no bids'; m.style.display=''; }
      const s=$('soldBtn'),u=$('unsoldBtn'); if(s)s.classList.toggle('pulse',hasBid); if(u)u.classList.toggle('pulse',!hasBid);
      if(!wasTimeUp){ beep(); wasTimeUp=true; }
    } else { clearTimeUp(); }
  }
  else { el.textContent='—'; el.style.color=''; clearTimeUp(); } },200);

// keyboard shortcuts for fast operation
document.addEventListener('keydown',(e)=>{
  if(!snap||snap.phase==='setup'||e.target.tagName==='INPUT'||e.target.tagName==='SELECT')return;
  if(e.key==='Enter'){e.preventDefault();doSold();}
  else if(e.key===' '){e.preventDefault();callNext();}
  else if(e.key==='u'||e.key==='U'){cmd('undo');}
  else if(e.key>='1'&&e.key<='9'){ const t=snap.teams[Number(e.key)-1]; if(t)bid(t.teamId); }
  else if(e.key==='0'){ const t=snap.teams[9]; if(t)bid(t.teamId); }
});

// restart (requires re-entering the auctioneer key)
window.showRestart=()=>{ $('restartErr').textContent=''; $('restartKey').value=''; $('restartModal').classList.remove('hide'); setTimeout(()=>$('restartKey').focus(),50); };
window.doRestart=async()=>{
  const key=$('restartKey').value.trim();
  if(!key){ $('restartErr').textContent='Enter the auctioneer key.'; return; }
  $('restartErr').textContent='Restarting…';
  const r=await Bus.command('reset',{},key);   // verified server-side with the entered key
  if(!r.ok){ $('restartErr').textContent=r.error||'Restart failed.'; return; }
  setKey(key);
  closeModal('restartModal'); Bus.toast('Auction restarted — back to setup','ok');
};

// key modal
function showKey(){ $('keyInput').value=''; $('keyModal').classList.remove('hide'); setTimeout(()=>$('keyInput').focus(),50); }
window.saveKey=()=>{ const k=$('keyInput').value.trim(); if(!k){ Bus.toast('Enter the auctioneer key','err'); return; } setKey(k); $('keyModal').classList.add('hide'); Bus.toast('Key saved','ok');
  // Reconnect as an authenticated operator so presence + passcodes light up now.
  if(conn) conn.close(); conn = Bus.connect(onState, on => Bus.connBadge(on), { role:'operator', key:getKey() }); loadPins(); };

boot();

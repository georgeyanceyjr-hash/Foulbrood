// hivegame.com bot panel: log in, start and stop the bot, manage challenges, watch its games.
(()=>{
 const el=id=>document.getElementById(id);
 if(!el('hivebotPanel'))return;
 let cleared=null; // id of a finished game the user cleared off the Live board (remembered across reloads)
 try{cleared=localStorage.getItem('foulbrood_live_cleared')||null}catch(e){}
 const setCleared=v=>{cleared=v;try{v?localStorage.setItem('foulbrood_live_cleared',v):localStorage.removeItem('foulbrood_live_cleared')}catch(e){}};
 let bot=null,shown={id:null,turn:-1},starting=false,timer=null,clockCard=null,clockFetched=0;
 const post=async payload=>{
  const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-Board-Token':window.BOARD_TOKEN},body:JSON.stringify(payload)});
  const data=await r.json();if(!r.ok)throw Error(data.error||'The bot did not answer.');return data;
 };
 // Remembered choices (never the password).
 const saved=(()=>{try{return JSON.parse(localStorage.getItem('foulbrood_hivebot')||'{}')}catch(e){return {}}})();
 // Every box in the sidebar folds: click its title (the arrow shows which way). Remembered per box.
 {let folded={};try{folded=JSON.parse(localStorage.getItem('foulbrood_folded')||'{}')}catch(e){}
  for(const section of document.querySelectorAll('aside > section.panel')){
   const title=section.querySelector('h2');if(!title||!section.id)continue;
   let head=title;while(head.parentElement!==section)head=head.parentElement;
   head.classList.add('hb-fold-head');title.classList.add('hb-fold-title');title.setAttribute('role','button');title.tabIndex=0;
   const set=v=>{section.classList.toggle('hb-folded',v);title.setAttribute('aria-expanded',String(!v))};
   set(!!folded[section.id]);
   const flip=()=>{const v=!section.classList.contains('hb-folded');set(v);folded[section.id]=v;try{localStorage.setItem('foulbrood_folded',JSON.stringify(folded))}catch(e){}};
   title.addEventListener('click',flip);title.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();flip()}});
  }}
 // "Live" is its own workspace tab: the analysis board with only the hivegame.com bot's panels.
 let live=false;try{live=localStorage.getItem('foulbrood_live_tab')==='1'}catch(e){}
 const liveOn=()=>live&&typeof state!=='undefined'&&state&&state.mode==='analysis'&&!(typeof enginePageOpen!=='undefined'&&enginePageOpen);
 const fixTabs=()=>{
  const on=liveOn();document.body.classList.toggle('hb-live',on);
  el('liveTab').classList.toggle('active',on);
  if(on)el('analysisTab').classList.remove('active');
  el('hivebotPanel').hidden=!on;el('hbChallengesPanel').hidden=!on||el('hbChallenges').hidden;
 };
 const setLive=v=>{live=v;try{localStorage.setItem('foulbrood_live_tab',v?'1':'0')}catch(e){}};
 el('liveTab').onclick=()=>{setLive(true);if(typeof enginePageOpen!=='undefined')enginePageOpen=false;shown={id:null,turn:-1};action({action:'mode',mode:'analysis'});setTimeout(()=>{fixTabs();takeBoard().catch(()=>{}).then(()=>render())},300)};
 for(const id of ['playTab','analysisTab','engineTab'])el(id).addEventListener('click',()=>{setLive(false);setTimeout(fixTabs,50);if(id==='analysisTab')setTimeout(()=>releaseBoard().catch(()=>{}),300)});
 const remember=()=>{try{localStorage.setItem('foulbrood_hivebot',JSON.stringify({login:el('hbLogin').value,engine:el('hbEngine').value,follow:el('hbFollow').checked,auto:el('hbAuto').checked,humans:el('hbHumans').checked,color:el('hbColor').value,acceptTime:el('hbAcceptTime').value,max:el('hbMax').value,only:el('hbOnly').value}))}catch(e){}};
 if(saved.login)el('hbLogin').value=saved.login;
 el('hbMax').closest('label').style.display='none';
 el('hbFollow').checked=true;el('hbFollow').closest('label').style.display='none'; // following the bot's game is simply how Live works
 if(saved.humans)el('hbHumans').checked=true;if(saved.color)el('hbColor').value=saved.color;
 if('auto' in saved)el('hbAuto').checked=!!saved.auto;
 if(saved.acceptTime)el('hbAcceptTime').value=saved.acceptTime;
 if(saved.max)el('hbMax').value=saved.max;
 el('hbOnly').value='';el('hbOnly').closest('label').style.display='none'; // no name filter: automatic accepting takes anyone who matches
 const fillEngines=()=>{
  const list=((typeof state!=='undefined'&&state&&state.engines)||[]).filter(e=>e.connected&&e.id!=='Computer');
  const key=JSON.stringify(list.map(e=>[e.id,e.name]));const select=el('hbEngine');
  if(select.dataset.engines===key)return;
  const wanted=select.value||saved.engine||'';select.replaceChildren();
  for(const e of list){const o=document.createElement('option');o.value=e.id;o.textContent=e.name;select.append(o)}
  const preferred=list.find(e=>e.id===wanted)||list.find(e=>/^(foulbrood|thoraxrex) book$/i.test(e.name))||list.find(e=>/^(foulbrood|thoraxrex)$/i.test(e.name))||list[0];
  if(preferred)select.value=preferred.id;select.dataset.engines=key;
 };
 // Challenge rules as the server wants them.
 const onlyList=()=>[...new Set(el('hbOnly').value.split(',').map(x=>x.trim()).filter(x=>/^[A-Za-z0-9_-]{1,40}$/.test(x)))];
 const rules=()=>{
  const only=onlyList(),auto=el('hbAuto').checked,v=el('hbAcceptTime').value;
  return {humans:el('hbHumans').checked,accept:auto?only:[],anyone:auto&&!only.length,max_games:auto?1000000:0,clock:v==='any'?null:v.split('+').map(Number)};
 };
 const names=g=>`${g.white||'White'} vs ${g.black||'Black'}`;
 // Live borrows the Analysis board. Whatever game was in Analysis is set aside first and put back when
 // the user goes to the Analysis tab, unless they chose to open the Live game there.
 const ls=(k,v)=>{try{if(v===undefined)return localStorage.getItem(k);v===null?localStorage.removeItem(k):localStorage.setItem(k,v)}catch(e){}return null};
 const stash=v=>ls('foulbrood_analysis_stash',v),botBoard=v=>v===undefined?ls('foulbrood_live_board')==='1':ls('foulbrood_live_board',v?'1':null);
 const hasGame=text=>!!text&&text.split(';').length>3;
 const whenFree=async fn=>{for(let i=0;i<40&&typeof busy!=='undefined'&&busy;i++)await new Promise(r=>setTimeout(r,100));return fn()};
 const releaseBoard=async()=>{
  if(!botBoard()||typeof state==='undefined'||!state)return;
  const saved=stash();botBoard(false);stash(null);shown={id:null,turn:-1};
  await whenFree(()=>action({action:'load',text:hasGame(saved)?saved:state.game.split(';')[0].split('~')[0],confirm_review_clear:true}));
 };
 // Entering Live: set the Analysis game aside and start from an empty board (the bot's game is loaded next, if any).
 const takeBoard=async()=>{
  if(botBoard()||typeof state==='undefined'||!state||state.mode!=='analysis')return;
  if(hasGame(state.game))stash(state.game);
  botBoard(true);shown={id:null,turn:-1};
  if(hasGame(state.game))await whenFree(()=>action({action:'load',text:state.game.split(';')[0].split('~')[0],confirm_review_clear:true}));
 };
 const showOnBoard=async g=>{
  if(!g||typeof action!=='function')return;
  if(typeof busy!=='undefined'&&busy)return;
  if(!botBoard()&&typeof state!=='undefined'&&state&&hasGame(state.game))stash(state.game);
  botBoard(true);
  shown={id:g.id,turn:g.turn};
  try{await action({action:'load_link',url:g.url,confirm_review_clear:true})}catch(e){}
 };
 // Clocks tick locally between status updates.
 const fmt=t=>{if(t==null||!Number.isFinite(t))return '—';t=Math.max(0,t);const m=Math.floor(t/60),sec=Math.floor(t%60);return (m<10?'0':'')+m+':'+(sec<10?'0':'')+sec};
 const index=raw=>Math.abs(raw)>99000?Math.sign(raw)*100:Math.max(-99,Math.min(99,Math.round(100*Math.tanh(raw/300))));
 // Clocks use the viewer's own clock at the right end of each player bar while the bot's game is on the board.
 const drawClocks=()=>{
  document.querySelectorAll('.hb-bar-clock').forEach(n=>n.remove());
  const c=clockCard,onBoard=c&&c.timed&&c.white_left!=null&&c.black_left!=null&&shown.id===c.id&&typeof state!=='undefined'&&state&&state.mode==='analysis'&&liveOn()&&!state.game_review;
  const elapsed=onBoard&&!c.finished?(c.clock_age||0)+(Date.now()-clockFetched)/1000:0,whiteToMove=onBoard&&(c.turn||0)%2===0,started=onBoard&&(c.turn||0)>=2;
  for(const color of ['white','black']){
   const clock=el(color+'Clock'),bar=clock.closest('.player');bar.classList.toggle('hb-live-clock',!!onBoard);
   if(!onBoard)continue;
   const mine=(color==='white')===whiteToMove,left=(color==='white'?c.white_left:c.black_left)-(started&&mine?elapsed:0);
   clock.textContent=fmt(left);clock.classList.toggle('hb-ticking',!c.finished&&mine);
  }
 };
 setInterval(()=>{drawClocks();try{if(typeof state!=='undefined'&&state){drawOpponentStrip(state);if(bot&&bot.current&&bot.current.thinking)drawNativeStrip(state)}}catch(e){}},500);
 const drawThought=card=>{
  if(!el('hbThought'))return; // the main player bar shows this now
  const info=card&&card.info;
  if(!card||card.finished||!info){el('hbThought').hidden=true;return}
  el('hbThought').hidden=false;
  const botIsWhite=bot&&bot.user?card.white===bot.user:(info.turn%2===0);
  const value=index(botIsWhite?info.score:-info.score);
  el('hbScore').textContent=(value>0?'+':'')+value;el('hbDepth').textContent=info.depth;el('hbTop').textContent=info.move;
  el('hbThought').classList.toggle('stale',!card.thinking);
 };
 const clockText=c=>c.mode==='RealTime'&&c.base!=null?`${Math.round(c.base/60)}+${c.increment||0}`:c.mode==='Correspondence'?'correspondence':c.mode==='Untimed'?'untimed':(c.mode||'');
 const drawLobby=playing=>{
  const speed=c=>c.mode==='RealTime'&&c.base!=null?c.base+40*(c.increment||0):c.mode==='Correspondence'?1e9:2e9; // fastest first
  // Who is online on hivegame.com, for "Send a challenge": people first, then bots.
  {const sel=el('hbOpponent'),list=(bot.online||[]).slice().sort((a,b)=>a.bot-b.bot||a.name.localeCompare(b.name,undefined,{sensitivity:'base'}));
   const [tb,ti]=el('hbTime').value.split('+').map(Number),tot=tb+40*ti,spd=tot<180?'Bullet':tot<480?'Blitz':tot<1500?'Rapid':'Classic';
   const k=JSON.stringify([list,spd]);
   if(sel.dataset.key!==k){
    sel.dataset.key=k;const keep=sel.value;sel.replaceChildren();
    const first=document.createElement('option');first.value='';first.textContent=list.length?`Choose a player (${list.length} online)`:'Nobody else is online';sel.append(first);
    for(const [title,want] of [['People',false],['Bots',true]]){
     const group=document.createElement('optgroup');group.label=title;
     for(const u of list)if(u.bot===want){const o=document.createElement('option');o.value=u.name;const r=u.ratings&&u.ratings[spd];o.textContent=u.name+(r?' ('+r+')':'');group.append(o)}
     if(group.children.length)sel.append(group);
    }
    if(list.some(u=>u.name===keep))sel.value=keep;
   }}
  const box=el('hbLobby'),tcv=el('hbAcceptTime').value,tcOk=c=>tcv==='any'?c.mode==='RealTime'&&(c.base||0)>=600:c.mode==='RealTime'&&`${c.base}+${c.increment||0}`===tcv,rows=(bot.lobby||[]).filter(c=>!c.mine&&!c.to&&tcOk(c)&&!(el('hbHumans').checked&&c.bot)).sort((a,b)=>speed(a)-speed(b)||(b.rating||0)-(a.rating||0));
  const mine=(bot.lobby||[]).filter(c=>c.mine);
  const key=JSON.stringify([rows,mine,playing]);if(box.dataset.key===key)return;box.dataset.key=key;box.replaceChildren();
  for(const c of mine){const p=document.createElement('p');p.className='caption';p.textContent=`Your challenge${c.to?' to '+c.to:' (open)'} · ${clockText(c)} — waiting to be accepted.`;box.append(p)}
  // The waiting challenges as one menu (people first, then bots, fastest time control first) and one Accept button.
  const sel=el('hbPick'),keep=sel.value;sel.replaceChildren();
  const first=document.createElement('option');first.value='';first.textContent=rows.length?`Choose a challenge (${rows.length} waiting)`:'No open challenges right now';sel.append(first);
  for(const [title,want] of [['People',false],['Bots',true]]){
   const group=document.createElement('optgroup');group.label=title;
   for(const c of rows)if(!!c.bot===want){const o=document.createElement('option');o.value=c.id;o.textContent=`${c.who||'Someone'}${c.rating?' ('+c.rating+')':''} · ${clockText(c)} · ${c.rated?'rated':'casual'}${c.color?' · they take '+c.color:''}`;group.append(o)}
   if(group.children.length)sel.append(group);
  }
  if(rows.some(c=>c.id===keep))sel.value=keep;
  el('hbTake').disabled=playing||!sel.value;
 };
 const render=()=>{
  fillEngines();
  if(!bot)return;
  const running=!!bot.running,connected=bot.state==='connected';
  el('hivebotPanel').dataset.state=bot.state;
  fixTabs();
  el('hbStart').disabled=running||starting;el('hbStop').disabled=!running;
  if(enginePending&&bot&&!bot.current)setTimeout(switchEngine,0);
  el('hbEngineRow').title=enginePending?'The new engine takes over after this game.':'';
  el('hbForm').hidden=running;el('hbChallenges').hidden=!connected||!!bot.current;fixTabs();el('hbBusyNote').hidden=true;
  if(bot.saved_login&&!el('hbLogin').value)el('hbLogin').value=bot.saved_login;
  el('hbPassword').placeholder=(bot.saved_login&&bot.saved_login===el('hbLogin').value.trim())?'Saved in Keychain — leave blank to use it':'';
  el('hbForget').hidden=!bot.saved_login;
  const g=bot.current,last=[...(bot.games||[])].reverse().find(x=>x.finished);
  let summary={stopped:'Not running',building:'Building…',starting:'Connecting…',connected:'Connected',error:'Needs attention'}[bot.state]||bot.state;
  let status=bot.message||'';
  if(connected){
   if(g){summary='Playing';status='';}
   else if(last){status=`Connected as ${bot.user}.\nLast game: ${names(last)} — ${last.result||'finished'}.\nWaiting for the next game.`;}
  }
  el('hbSummary').textContent=summary;el('hbStatus').textContent=status;el('hbStatus').hidden=!status;
  const card=g||last;el('hbGame').hidden=!card;
  if(card){
   el('hbPlayers').textContent=names(card);el('hbPlayers').parentElement.hidden=true; // the pairing and result are in the status lines and the player bars
   const move=(card.turn||0)+1; // the viewer numbers every move on its own: White plays 1, Black plays 2
   el('hbTurn').textContent=card.finished?(card.result||'Finished'):card.thinking?`move ${move} · thinking`:card.our_turn?`move ${move} · our turn`:`move ${move} · waiting for opponent`;
   el('hbLink').href=card.url;el('hbLink').onclick=e=>{e.preventDefault();post({action:'hivebot_open',url:card.url}).catch(()=>window.open(card.url,'_blank'))};el('hbShow').onclick=()=>showOnBoard(card);el('hbShow').hidden=el('hbFollow').checked;
  }
  // Same button as on the Play page: take what is on the Live board over to Analysis.
  el('hbToAnalysis').hidden=false;{const some=typeof state!=='undefined'&&state&&hasGame(state.game);el('hbClear').disabled=!!g||!some;el('hbToAnalysis').disabled=!some} // nothing to clear mid-game, nothing to open or clear on an empty board
  el('hbToAnalysis').textContent=g?'Open current position in Analysis':'Open current game in Analysis';
  clockCard=card||null;clockFetched=Date.now();drawClocks();drawThought(card);
  if(connected){
   const who=bot.anyone?'anyone':(bot.accept||[]).join(', ');
   const tc=bot.clock?`${bot.clock[0]/60}+${bot.clock[1]} only`:'10 minutes or longer';
   el('hbAccepting').textContent=who&&bot.max_games?`Accepting open challenges from ${who}, ${tc}, one game at a time until you untick the box.`:'';
   el('hbAccepting').hidden=!el('hbAccepting').textContent;
   drawLobby(!!g);
  }
  const pending=(bot.lobby||[]).some(c=>c.mine); // a sent challenge is only news while it is still waiting
  el('hbLog').textContent=(bot.log||[]).filter(line=>!/^Accepted a challenge/.test(line)&&(pending||!/^Challenge sent/.test(line))).slice(-3).join('\n');el('hbLog').hidden=!el('hbLog').textContent;
  if(card&&!card.finished&&cleared)setCleared(null);
  if(liveOn()&&el('hbFollow').checked&&card&&cleared!==card.id&&(card.id!==shown.id||card.turn!==shown.turn))showOnBoard(card);
  try{if(typeof state!=='undefined'&&state){drawNativeStrip(state);drawNativePreview(state);drawIdentity(state)}}catch(e){}
  try{feedSounds()}catch(e){}
 };
 // ---- Native display: the viewer's own player strip and move preview, fed by the bot's thinking ----
 let thinkKey='',thinkSince=0;
 const DIRS={e:[1,0],w:[-1,0],ne:[1,-1],nw:[0,-1],se:[0,1],sw:[-1,1]};
 const legalFor=(s,text)=>{
  // Engine notation "bA1 -wQ" -> the viewer's own legal move with the same piece and destination.
  if(!s.legal||!text)return null;
  const exact=s.legal.find(m=>m.move===text&&m.to);if(exact)return exact;
  const [piece,ref]=text.trim().split(/\s+/);if(!piece||!ref)return null;
  let name=ref,dir=null;
  if('-/\\'.includes(ref[0])){dir={'-':'w','/':'sw','\\':'nw'}[ref[0]];name=ref.slice(1)}
  else if('-/\\'.includes(ref[ref.length-1])){dir={'-':'e','/':'ne','\\':'se'}[ref[ref.length-1]];name=ref.slice(0,-1)}
  const anchor=(s.pieces||[]).find(p=>p.id===name);if(!anchor)return null;
  const d=dir?DIRS[dir]:[0,0],q=anchor.q+d[0],r=anchor.r+d[1];
  return s.legal.find(m=>m.piece===piece&&m.to&&m.to[0]===q&&m.to[1]===r)||null;
 };
 // The bot's game that is on the board right now: the one in progress, or the one that just ended.
 const boardCard=s=>{
  if(!bot||bot.state!=='connected'||s.mode!=='analysis'||!liveOn()||s.game_review)return null;
  const card=bot.current||[...(bot.games||[])].reverse().find(x=>x.finished);
  if(!card||shown.id!==card.id||cleared===card.id)return null;
  if(typeof editorDraft!=='undefined'&&editorDraft)return null;
  return card;
 };
 const nativeCard=s=>{const card=boardCard(s);return card&&card.info?card:null};
 const drawNativePreview=s=>{
  const board=el('board');board.querySelectorAll('.hb-native-preview').forEach(n=>n.remove());
  const card=nativeCard(s);if(!card||!card.thinking||s.ply!==card.info.turn)return;
  const move=legalFor(s,card.info.move);if(!move)return;
  const side=card.white===bot.user?0:1;
  const [x,baseY]=xy(...move.to),height=s.pieces.filter(p=>p.q===move.to[0]&&p.r===move.to[1]&&p.id!==move.piece).length,y=baseY-height*10;
  const layer=node('g',{class:'opponent-insight-preview hb-native-preview','pointer-events':'none','aria-label':'HotFrass thinking preview',style:`--preview-blue:${hintColor(side)}`});
  const source=s.pieces.find(p=>p.id===move.piece);
  if(source){
   const [sx,baseSY]=xy(source.q,source.r),sy=baseSY-source.level*10,dx=x-sx,dy=y-sy,length=Math.hypot(dx,dy);
   layer.append(node('polygon',{points:hex(sx,sy,39),class:'opponent-insight-outline','stroke-dasharray':'6 4'}));
   if(length>42){const ux=dx/length,uy=dy/length,ex=x-ux*43,ey=y-uy*43;
    layer.append(node('line',{x1:sx,y1:sy,x2:ex,y2:ey,class:'opponent-insight-arrow'}));
    layer.append(node('polygon',{points:`${ex},${ey} ${ex-ux*11-uy*5},${ey-uy*11+ux*5} ${ex-ux*11+uy*5},${ey-uy*11-ux*5}`,class:'opponent-insight-arrowhead'}));
   }
  }
  const ghost=node('g',{opacity:.55});ghost.append(artwork(move.piece,x,y));layer.append(ghost);
  layer.append(node('polygon',{points:hex(x,y,40),class:'opponent-insight-outline'}));board.append(layer);
 };
 const drawNativeStrip=s=>{
  const card=nativeCard(s);if(!card||typeof botThoughtFields!=='function')return;
  const info=card.info,side=card.white===bot.user?0:1,color=side===0?'white':'black';
  const strip=el(color+'Thought'),bar=el(color+'Clock').closest('.player'),source=el(color+'InsightSource');
  const key=card.id+'|'+info.turn;if(card.thinking&&key!==thinkKey){thinkKey=key;thinkSince=Date.now()}
  strip.hidden=false;el(color+'ReviewThought').hidden=true;bar.classList.add('bot-duel');bar.classList.toggle('bot-thinking',!!card.thinking);
  source.hidden=false;source.style.visibility='';source.textContent=identity(card,color,(bot.engine||'engine').replace(/ /g,'\u00a0'));source.title=source.textContent;
  const fields=botThoughtFields(strip),moveNumber=(info.turn||0)+1;
  let text=info.move;try{if(typeof insightMoveText==='function'&&s.ply===info.turn)text=insightMoveText(s.game,(legalFor(s,info.move)||{}).move||info.move,notationFollowsBoard())||info.move}catch(e){}
  fields.move.caption.textContent=(card.thinking?'Thinking':'Played')+' · Move '+moveNumber;fields.move.value.textContent=text;fields.move.value.title='Top move: '+text;fields.move.value.disabled=true;
  fields.depth.value.textContent=String(info.depth);
  fields.time.value.textContent=card.thinking&&key===thinkKey?((Date.now()-thinkSince)/1000).toFixed(1)+'s':'—';
  updatePositionScore(fields.score,{score:info.score,side,source:'bot'},null,{side,label:'Position'});
 };
 // Who the player is on hivegame.com: rating (and its change once the game is over) beside the name,
 // and the record at this speed on the line below.
 const identity=(card,color,lead)=>{
  const info=card[color+'_card'];if(!info)return lead;
  const name=el(color+'Name'),base=card[color]||name.textContent;
  let text=base;
  if(info.rating!=null){text+='  '+Math.round(info.rating);if(card.finished&&info.change!=null){const d=Math.round(info.change);text+=' ('+(d>0?'+':d<0?'−':'±')+Math.abs(d)+')'}}
  name.textContent=text;name.title='Rating on hivegame.com at this time control'+(card.finished?', and the change from this game':'');
  const bits=[];
  if(info.patreon)bits.push('Supporter');
  let record='';if(info.played!=null)record=`${Number(info.played).toLocaleString()} games ${info.win}W ${info.loss}L${info.draw?' '+info.draw+'D':''}`.replace(/ /g,'\u00a0');
  if(card.rated===false)bits.push('casual game');
  return [[info.bot?'Bot':'Human',lead].filter(Boolean).join(' · '),bits.filter(Boolean).join(' · '),record].filter(Boolean).join('\n'); // the record gets a line of its own
 };
 const drawIdentity=s=>{
  const card=boardCard(s);
  for(const color of ['white','black'])el(color+'InsightSource').classList.toggle('hb-id',!!card); // Live never shows the analysis 'Insight:' line
  if(!card)return;
  const botColor=card.white===bot.user?'white':'black';
  for(const color of ['white','black']){
   const source=el(color+'InsightSource');source.hidden=false;source.style.visibility='';
   source.textContent=identity(card,color,color===botColor?(bot.engine||'engine').replace(/ /g,'\u00a0'):'')||'Opponent on hivegame.com';source.title=source.textContent;
  }
 };
 // The opponent's bar: how long it has been thinking, and how long its last move took (from its clock).
 const oppClock={id:null,left:null,used:null};
 const drawOpponentStrip=s=>{
  const card=boardCard(s);
  if(!card||!card.timed||typeof botThoughtFields!=='function')return;
  const botSide=card.white===bot.user?0:1,side=1-botSide,color=side===0?'white':'black';
  const left=side===0?card.white_left:card.black_left;if(left==null)return;
  if(oppClock.id!==card.id){oppClock.id=card.id;oppClock.left=left;oppClock.used=null}
  else if(left!==oppClock.left){oppClock.used=Math.max(0,oppClock.left-left+(card.increment||0));oppClock.left=left}
  const strip=el(color+'Thought'),bar=el(color+'Clock').closest('.player'),fields=botThoughtFields(strip);
  const toMove=!card.finished&&(card.turn||0)%2===side,moveNumber=(card.turn||0)+1;
  strip.hidden=false;bar.classList.add('bot-duel');bar.classList.toggle('bot-thinking',toMove);
  const source=el(color+'InsightSource');source.hidden=false;source.style.visibility='';source.textContent=identity(card,color,'')||'Opponent on hivegame.com';source.title=source.textContent;
  fields.move.caption.textContent=toMove?'Thinking · Move '+moveNumber:'Waiting';fields.move.value.textContent='—';fields.move.value.disabled=true;
  const elapsed=(card.clock_age||0)+(Date.now()-clockFetched)/1000;
  fields.time.value.textContent=toMove&&(card.turn||0)>=2?elapsed.toFixed(1)+'s':oppClock.used!=null?oppClock.used.toFixed(1)+'s':'—';
  fields.time.value.title=toMove?'Time on this move so far':'Time the last move took';
  fields.depth.value.textContent='—';
 };
 // ---- Sounds: feed the viewer's own sound logic a play-style picture of the bot's game ----
 // (turn chirp on every move, the ending fanfare). The Sound button and volume settings apply as usual.
 const soundTurn={key:null,clocks:[null,null]};
 const soundCard=()=>{
  if(!bot||!bot.running)return null;
  const card=bot.current||[...(bot.games||[])].reverse().find(x=>x.finished);
  return card&&shown.id===card.id?card:null;
 };
 const nativeObserve=window.observeHumanTurn;
 if(typeof nativeObserve==='function'){
  window.observeHumanTurn=s=>{if(!soundCard())nativeObserve(s)};
 }
 const feedSounds=()=>{
  const card=soundCard();if(!card||typeof nativeObserve!=='function')return;
  const side=(card.turn||0)%2,done=!!card.finished;
  const gone=done||(card.turn||0)<2?0:(card.clock_age||0)+(Date.now()-clockFetched)/1000;
  const live=[card.white_left-(side===0?gone:0),card.black_left-(side===1?gone:0)];
  // One clock reading per turn: enough to schedule the ticking, without triggering the spoken countdown.
  const turnKey=card.id+'|'+(card.turn||0);if(soundTurn.key!==turnKey){soundTurn.key=turnKey;soundTurn.clocks=live}
  const ending=done?({'White won':'WhiteWins','Black won':'BlackWins','Draw':'Draw'}[card.result]||null):null;
  nativeObserve({mode:'play',running:!done,timeout_side:null,resigned_side:null,completed_state:ending,state:'InProgress',
   players:['Human','Human'],side,live_side:side,game:card.id,live_game:card.id+';InProgress',
   clocks:soundTurn.clocks,time_control:'10+10',review_total:99});
 };
 if(typeof window.renderBotThoughts==='function'){
  const nativeThoughts=window.renderBotThoughts;
  window.renderBotThoughts=s=>{nativeThoughts(s);fixTabs();try{drawNativeStrip(s);drawOpponentStrip(s);drawIdentity(s);drawNativePreview(s);drawClocks()}catch(e){}};
 }
 const refresh=async()=>{try{bot=await post({action:'hivebot_status',lobby:el('hivebotDetails').open});render()}catch(e){}};
 const schedule=()=>{clearTimeout(timer);timer=setTimeout(async()=>{await refresh();schedule()},bot&&bot.running?2000:el('hivebotDetails').open?4000:15000)};
 el('hbStart').onclick=async()=>{
  starting=true;el('hbStart').disabled=true;el('hbStatus').textContent='Starting…';remember();
  try{bot=await post({action:'hivebot_start',login:el('hbLogin').value,password:el('hbPassword').value,engine:el('hbEngine').value,...rules(),min_base:600,remember:el('hbRemember').checked&&!!el('hbPassword').value});el('hbPassword').value='';}
  catch(e){el('hbStatus').textContent=e.message}
  finally{starting=false;render();schedule()}
 };
 // Changing the engine while the bot is connected: restart the bot with the new engine (the saved
 // login is reused). During a game the change waits until the game is over.
 let enginePending=false,switching=false;
 const switchEngine=async()=>{
  if(switching||!bot||!['connected','starting'].includes(bot.state))return;
  const name=(el('hbEngine').selectedOptions[0]||{}).textContent||'';
  if(name===bot.engine){enginePending=false;return}
  if(bot.current){enginePending=true;return}
  enginePending=false;switching=true;starting=true;el('hbStatus').textContent='Switching engine…';
  try{await post({action:'hivebot_stop'});bot=await post({action:'hivebot_start',login:el('hbLogin').value||bot.saved_login||bot.user||'',password:'',engine:el('hbEngine').value,...rules(),min_base:600,remember:false})}
  catch(e){el('hbStatus').textContent=e.message}
  finally{switching=false;starting=false;render();schedule()}
 };
 el('hbEngine').addEventListener('change',switchEngine);
 el('hbStop').onclick=async()=>{el('hbStop').disabled=true;try{bot=await post({action:'hivebot_stop'})}catch(e){el('hbStatus').textContent=e.message}render();schedule()};
 el('hbForget').onclick=async()=>{try{bot=await post({action:'hivebot_forget'})}catch(e){el('hbStatus').textContent=e.message}render()};
 // Two ways to challenge: open (the lobby, with a rating range) or sent to one named player.
 const challenge=async(button,payload)=>{
  button.disabled=true;
  try{bot=await post({action:'hivebot_challenge',...payload})}catch(e){el('hbStatus').textContent=e.message}
  button.disabled=false;render();
 };
 el('hbTime').addEventListener('change',()=>render()); // ratings in the opponent menu follow the chosen time control
 const clearBoard=async()=>{
  const last=bot&&[...(bot.games||[])].reverse().find(g=>g.finished);setCleared(last?last.id:'none');shown={id:null,turn:-1};
  try{await whenFree(()=>action({action:'load',text:state.game.split(';')[0].split('~')[0],confirm_review_clear:true}))}catch(e){}
  render();
 };
 el('hbClear').onclick=()=>{
  if(bot&&bot.current)return;if(typeof state==='undefined'||!state||state.mode!=='analysis')return;
  if(hasGame(state.game))ask('Clear game and history?','This will clear the board and the game history. Continue?','Clear game',clearBoard);
 };

 const toAnalysis=async()=>{
  const card=bot&&(bot.current||[...(bot.games||[])].reverse().find(g=>g.finished));
  if(card&&cleared!==card.id&&(card.id!==shown.id||card.turn!==shown.turn))await showOnBoard(card);
  stash(null);botBoard(false); // the Live game now is the Analysis game
  setLive(false);fixTabs();render();
  if(typeof window.render==='function'&&typeof serverState!=='undefined'&&serverState)window.render(serverState);
 };
 // The viewer's own "are you sure" dialog, with our action on Continue.
 const ask=(title,message,label,fn)=>{
  if(typeof state==='undefined'||!state||(typeof busy!=='undefined'&&busy))return;
  const dialog=el('resignDialog'),ok=el('confirmResign');
  el('resignTitle').textContent=title;el('resignMessage').textContent=message;ok.textContent=label;
  const yes=e=>{e.preventDefault();e.stopImmediatePropagation();done();dialog.close();fn()};
  const done=()=>{ok.removeEventListener('click',yes,true);dialog.removeEventListener('close',done)};
  ok.addEventListener('click',yes,true);dialog.addEventListener('close',done);
  dialog.showModal();
 };
 el('hbToAnalysis').onclick=()=>{
  // Analysis already holds a game: ask first, as the Play page does.
  if(hasGame(stash()))ask('Replace game and history?','This will replace the current Analysis position and game history. Continue?','Open in Analysis',toAnalysis);
  else toAnalysis();
 };


 el('hbPick').addEventListener('change',()=>{el('hbTake').disabled=!el('hbPick').value||!!(bot&&bot.current)});
 el('hbTake').onclick=async()=>{const id=el('hbPick').value;if(!id)return;el('hbTake').disabled=true;try{bot=await post({action:'hivebot_take',id})}catch(e){el('hbStatus').textContent=e.message}render()};
 el('hbSend').onclick=()=>{
  const opponent=el('hbOpponent').value.trim();if(!opponent){el('hbOpponent').focus();return}
  const [base,increment]=el('hbTime').value.split('+').map(Number);
  challenge(el('hbSend'),{opponent,base,increment,rated:el('hbRated').checked,color:el('hbColor').value});
 };
 el('hbOpen').onclick=()=>{
  const [base,increment]=el('hbOTime').value.split('+').map(Number);
  challenge(el('hbOpen'),{opponent:'',base,increment,rated:el('hbORated').checked,color:el('hbOColor').value,min_rating:Number(el('hbMinRating').value)||null,max_rating:Number(el('hbMaxRating').value)||null});
 };
 for(const id of ['hbFollow','hbEngine','hbLogin'])el(id).addEventListener('change',remember);
 for(const id of ['hbAuto','hbAcceptTime','hbMax','hbOnly','hbHumans'])el(id).addEventListener('change',async()=>{
  remember();if(!bot||!bot.running)return;
  try{bot=await post({action:'hivebot_accept',...rules()})}catch(e){el('hbStatus').textContent=e.message}render();
 });
 el('hbLogin').addEventListener('input',render);
 setTimeout(()=>{if(typeof state==='undefined'||!state||state.mode!=='analysis')return;(live?takeBoard():releaseBoard()).catch(()=>{})},1500);
 el('hbFollow').addEventListener('change',()=>{if(el('hbFollow').checked)shown={id:null,turn:-1};render()});
 el('hivebotDetails').addEventListener('toggle',()=>{refresh();schedule()});
 el('hbPassword').addEventListener('keydown',e=>{if(e.key==='Enter')el('hbStart').click()});
 setTimeout(()=>{refresh().then(()=>{if(bot&&bot.running)el('hivebotDetails').open=true;schedule()})},600);
})();

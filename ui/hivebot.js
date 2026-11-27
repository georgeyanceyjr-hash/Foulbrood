// hivegame.com bot panel: log in, start and stop the bot, manage challenges, watch its games.
(()=>{
 const el=id=>document.getElementById(id);
 if(!el('hivebotPanel'))return;
 let cleared=null; // id of a finished game the user cleared off the Live board (remembered across reloads)
 try{cleared=localStorage.getItem('foulbrood_live_cleared')||null}catch(e){}
 let clearedAt=0; // when this window last changed it; the app's copy is ignored for a moment after
 const keepCleared=v=>{cleared=v;try{v?localStorage.setItem('foulbrood_live_cleared',v):localStorage.removeItem('foulbrood_live_cleared')}catch(e){}};
 const setCleared=v=>{keepCleared(v);clearedAt=Date.now();try{post({action:'hivebot_cleared',id:v||''}).catch(()=>{})}catch(e){}};
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
 // The move list always follows the board, on Play, Live and Analysis: flip or rotate the board and the
 // notation turns with it. (Play already did; this makes Analysis and Live the same and drops the checkbox.)
 const followOnLive=()=>{
  try{
   if(analysisFollowsBoard!==true){analysisFollowsBoard=true;el('followBoard').checked=true;if(typeof serverState!=='undefined'&&serverState&&typeof window.render==='function')setTimeout(()=>window.render(serverState),0)}
  }catch(e){}
 };
 followOnLive();
 // "Live" is its own workspace tab: the analysis board with only the hivegame.com bot's panels.
 let live=false;try{live=localStorage.getItem('foulbrood_live_tab')==='1'}catch(e){}
 const liveOn=()=>live&&typeof state!=='undefined'&&state&&state.mode==='analysis'&&!(typeof enginePageOpen!=='undefined'&&enginePageOpen);
 const fixTabs=()=>{
  const on=liveOn();document.body.classList.toggle('hb-live',on);followOnLive(on);
  el('liveTab').classList.toggle('active',on&&!document.body.classList.contains('history-open'));
  if(on||document.body.classList.contains('history-open'))el('analysisTab').classList.remove('active');
  el('hivebotPanel').hidden=!on;el('hbChallengesPanel').hidden=!on||el('hbChallenges').hidden;
 };
 const setLive=v=>{live=v;try{localStorage.setItem('foulbrood_live_tab',v?'1':'0')}catch(e){}};
 // Leaving Analysis while a game is in review: remember it, so coming back goes straight to that review again.
 const noteReview=()=>{try{if(typeof state!=='undefined'&&state&&state.mode==='analysis'&&state.game_review){localStorage.setItem('foulbrood_review_resume',state.review_game||state.game);if(botBoard()){botBoard(false);stash(null)}}}catch(e){}};
 const resumeReview=async()=>{let want=null;try{want=localStorage.getItem('foulbrood_review_resume')}catch(e){}if(!want)return;
  for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,200));if(typeof state!=='undefined'&&state&&state.mode==='analysis'&&!botBoard()&&(state.review_game||state.game)===want&&!(typeof busy!=='undefined'&&busy))break;if(i===29)return}
  try{localStorage.removeItem('foulbrood_review_resume')}catch(e){}
  if(typeof analysisWorkspace==='function')analysisWorkspace('review');if(!state.game_review)await action({action:'review_enter'});
 };
 // A position still being arranged is put aside while Online is open, and comes back with the Analysis tab.
 let parkedDraft=null;
 const parkDraft=()=>{try{if(typeof editorDraft!=='undefined'&&editorDraft){parkedDraft=editorDraft;editorDraft=null;editorTool=null;lastBoardKey='';if(typeof render==='function'&&serverState)render(serverState)}}catch(e){}};
 const unparkDraft=()=>{try{if(parkedDraft&&typeof editorDraft!=='undefined'&&!editorDraft){editorDraft=parkedDraft;parkedDraft=null;lastBoardKey='';if(typeof redrawSetup==='function')redrawSetup()}}catch(e){}};
 el('liveTab').onclick=()=>{noteReview();parkDraft();setLive(true);if(typeof enginePageOpen!=='undefined')enginePageOpen=false;shown={id:null,turn:-1};action({action:'mode',mode:'analysis'});setTimeout(()=>{fixTabs();takeBoard().catch(()=>{}).then(()=>render())},300)};
 el('playTab').addEventListener('click',noteReview,true); // before the viewer's own handler changes the mode
 el('playTab').addEventListener('click',()=>{parkedDraft=null}); // Local discards a position being arranged, as it always has
 for(const id of ['playTab','analysisTab','engineTab'])el(id).addEventListener('click',()=>{setLive(false);setTimeout(fixTabs,50);if(id==='analysisTab')setTimeout(()=>releaseBoard().catch(()=>{}).then(resumeReview).then(unparkDraft,unparkDraft),300)});
 const remember=()=>{try{localStorage.setItem('foulbrood_hivebot',JSON.stringify({login:el('hbLogin').value,engine:el('hbEngine').value,follow:el('hbFollow').checked,direct:el('hbAuto').checked,color:el('hbColor').value,acceptTime:el('hbAcceptTime').value,max:el('hbMax').value,only:el('hbOnly').value}))}catch(e){}};
 if(saved.login)el('hbLogin').value=saved.login;
 el('hbMax').closest('label').style.display='none';
 el('hbFollow').checked=true;el('hbFollow').closest('label').style.display='none'; // following the bot's game is simply how Live works
 el('hbHumans').checked=false;el('hbOnly').value='';if(saved.color)el('hbColor').value=saved.color;
 el('hbAuto').checked='direct' in saved?!!saved.direct:true; // "Accept all direct challenges"
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
 const rules=()=>{
  // Open challenges are never taken automatically any more: only challenges sent to this account by name,
  // and only with the box ticked. (The time control now just filters the Open Challenges list.)
  const v=el('hbAcceptTime').value;
  const clk=id=>el(id).value.split('+').map(Number);
  return {direct:el('hbAuto').checked,direct_min:clk('hbDirectMin'),direct_max:clk('hbDirectMax'),humans:false,accept:[],anyone:false,max_games:0,clock:v==='any'?null:v.split('+').map(Number)};
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
  const empty=state.game.split(';')[0].split('~')[0];
  try{await whenFree(()=>action({action:'load',text:saved||empty,confirm_review_clear:true}))}
  catch(e){if(saved)await whenFree(()=>action({action:'load',text:empty,confirm_review_clear:true}))}
 };
 // Entering Live: set the Analysis game aside and start from an empty board (the bot's game is loaded next, if any).
 const takeBoard=async()=>{
  if(typeof state==='undefined'||!state||state.mode!=='analysis')return;
  if(botBoard()&&!state.game_review)return; // a game under review is never the bot's game, whatever the flag says
  const some=hasGame(state.review_game||state.game)||(state.pieces||[]).length>0; // a game, or an arranged position with no moves yet
  if(some)stash(state.review_game||state.game); // the whole game, so its review is found again on coming back
  botBoard(true);shown={id:null,turn:-1};
  if(some)await whenFree(()=>action({action:'load',text:state.game.split(';')[0].split('~')[0],confirm_review_clear:true}));
 };
 const showOnBoard=async g=>{
  if(!g||typeof action!=='function')return;
  if(typeof busy!=='undefined'&&busy)return;
  if(!botBoard()&&typeof state!=='undefined'&&state&&hasGame(state.game))stash(state.game);
  // Stepped back through this same game while it is being played: stay on that move when the next one arrives
  // (as on Local); the Live button is the way back to the current position.
  const back=botBoard()&&shown.id===g.id&&!g.finished&&typeof state!=='undefined'&&state&&typeof state.ply==='number'&&state.ply<(state.review_total??state.ply)?state.ply:null;
  // Another open window already put this move on the shared board: leave it be, so a stepped-back view is not pulled forward.
  const have=botBoard()&&shown.id===g.id&&!g.finished&&typeof state!=='undefined'&&state&&(state.review_total||0)===g.turn&&g.turn>0;
  botBoard(true);
  shown={id:g.id,turn:g.turn};
  if(have)return;
  if(g.finished&&/^Aborted/.test(g.result||''))return; // an aborted game has no record on hivegame.com to load
  try{await action({action:'load_link',url:g.url,confirm_review_clear:true});try{if(typeof state!=='undefined'&&state)window.foulbroodLinkSeen?.(state.review_game||state.game,g.url)}catch(e){}if(back!=null)await whenFree(()=>action({action:'navigate',ply:back}))}catch(e){}
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
  const box=el('hbLobby'),tcv=el('hbAcceptTime').value,tcOk=c=>tcv==='any'?true:c.mode==='RealTime'&&`${c.base}+${c.increment||0}`===tcv,rows=(bot.lobby||[]).filter(c=>!c.mine&&!c.to&&tcOk(c)&&!(el('hbHumans').checked&&c.bot)).sort((a,b)=>speed(a)-speed(b)||(b.rating||0)-(a.rating||0));
  const mine=(bot.lobby||[]).filter(c=>c.mine);
  const direct=(bot.lobby||[]).filter(c=>!c.mine&&c.to&&String(c.to).toLowerCase()===String(bot.user||'').toLowerCase());
  // A challenge sent to the bot by name: a knock (once per challenge).
  {const ids=direct.map(c=>c.id||[c.who,c.base,c.increment,c.color].join('|'));render.knocked=render.knocked||null;
   if(render.knocked&&ids.some(id=>!render.knocked.has(id)))window.foulbroodSfx?.knock();render.knocked=new Set(ids)}
  const key=JSON.stringify([rows,mine,direct,playing,el('hbAuto').checked]);if(box.dataset.key===key)return;box.dataset.key=key;box.replaceChildren();
  // Our own waiting challenges are listed where they were made: open ones under "Open a challenge", sent ones under "Send a challenge".
  for(const [id,list] of [['hbMineOpen',mine.filter(c=>!c.to)],['hbMineSent',mine.filter(c=>c.to)]]){
   const host=el(id);host.replaceChildren();host.hidden=!list.length;
   for(const c of list){
    const row=document.createElement('div'),text=document.createElement('span'),cancel=document.createElement('button');row.className='hb-mine-row';
    text.textContent=[c.to?'To '+c.to:'Open',clockText(c),c.rated===false?'casual':'rated',c.color?'we play '+c.color:''].filter(Boolean).join(' · ');
    cancel.className='small';cancel.textContent='Cancel';cancel.title='Take this challenge back';
    cancel.onclick=async()=>{cancel.disabled=true;try{bot=await post({action:'hivebot_withdraw',id:c.id})}catch(e){el('hbStatus').textContent=(window.plainMessage?window.plainMessage(e.message):e.message)}render()};
    row.append(text,cancel);host.append(row)}
  }
  // Challenges sent to us by name: listed with Accept and Reject while the automatic box is off (or a game is on).
  {const host=el('hbDirect');host.replaceChildren();el('hbDirectBox').hidden=!direct.length;
   for(const c of direct){
    const row=document.createElement('div'),text=document.createElement('span'),yes=document.createElement('button'),no=document.createElement('button');row.className='hb-mine-row';
    text.textContent=[(c.who||'Someone')+(c.rating?' ('+c.rating+')':''),clockText(c),c.rated===false?'casual':'rated',c.color?'they take '+c.color:''].filter(Boolean).join(' · ');
    yes.className='small';yes.textContent='Accept';yes.disabled=playing;yes.title=playing?'Not while a game is being played':'Play this challenge';
    no.className='small';no.textContent='Reject';
    const run=(button,what)=>async()=>{button.disabled=true;try{bot=await post({action:what,id:c.id})}catch(e){el('hbStatus').textContent=(window.plainMessage?window.plainMessage(e.message):e.message);el('hbStatus').hidden=false}render()};
    yes.onclick=run(yes,'hivebot_take');no.onclick=run(no,'hivebot_reject');
    const buttons=document.createElement('span');buttons.className='hb-row-buttons';buttons.append(yes,no);row.append(text,buttons);host.append(row)}
  }
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
 // An aborted game: say so on the board, once, in plain words; and never show a link-reading error on the Live board.
 // A game aborted before both sides had moved never counts as 'the last game'.
 const realGame=g=>g.finished&&!(/^Aborted/.test(g.result||'')&&(g.turn||0)<2);
 const abortSeen=new Set();let abortReady=false;
 const noteAborts=()=>{
  if(!bot||!bot.games)return;
  for(const g of bot.games)if(g.finished&&/^Aborted/.test(g.result||'')&&!abortSeen.has(g.id)){abortSeen.add(g.id);if(abortReady&&typeof toast==='function')toast(g.result+'.')}
  abortReady=true;
 };
 {const plain=window.toast;if(typeof plain==='function')window.toast=text=>{
   if(liveOn()&&/game link|reach that hivegame\.com game/.test(String(text))){
    const last=bot&&bot.games&&bot.games[bot.games.length-1];
    if(last&&last.finished&&/^Aborted/.test(last.result||''))return plain(last.result+'.');
    return;
   }
   return plain(text);
 }}
 // ---- Playing by hand on the bot account: the person makes the moves on the board, the engine stays idle ----
 let handSent='',refusedAt=0;
 const handCard=()=>bot&&bot.manual&&bot.current&&!bot.current.finished?bot.current:null;
 const handWatch=s=>{
  const card=handCard();
  if(!card||!s||s.mode!=='analysis'||!liveOn()||shown.id!==card.id||!card.our_turn)return;
  const moves=(s.game||'').split(';').slice(3);
  if(moves.length!==(card.turn||0)+1||(s.ply||0)!==moves.length)return; // exactly one new move on top of the live position
  const key=card.id+'|'+card.turn;if(handSent===key)return;handSent=key;
  post({action:'hivebot_move',id:card.id,move:moves[moves.length-1]}).then(b=>{bot=b;render()})
   .catch(e=>{handSent='';if(typeof toast==='function')toast(e.message);shown={id:null,turn:-1};render()});
 };
 const handPanel=connected=>{
  const on=!!(bot&&bot.manual),card=handCard();
  document.body.classList.toggle('hb-manual',on);
  document.body.classList.toggle('hb-insight',connected&&el('hbInsight').checked);
  el('hbManualRow').hidden=!connected;if(document.activeElement!==el('hbManual'))el('hbManual').checked=on;
  if('reopen' in bot&&document.activeElement!==el('hbReopen')&&Date.now()-(render.reopenAt||0)>3000)el('hbReopen').checked=!!bot.reopen;
  if('open_all' in bot&&document.activeElement!==el('hbOpenAll')&&Date.now()-(render.openAllAt||0)>3000)el('hbOpenAll').checked=!!bot.open_all;
  el('hbOTime').disabled=el('hbOpenAll').checked; // every standard time control is already up
  el('hbResignRow').hidden=!connected||!('resign_lost' in bot);if(document.activeElement!==el('hbResignLost'))el('hbResignLost').checked=!!bot.resign_lost;
  el('hbInsightRow').hidden=!connected;el('hbHandRow').hidden=!card;
  const s=typeof state!=='undefined'?state:null;
  el('hbPass').disabled=!(card&&card.our_turn&&s&&(s.legal||[]).some(m=>m.move==='pass'));
  if(card&&card.our_turn)el('hbSummary').textContent='Your move';
  // The site turned a move down: say so and put the real position back.
  if(bot&&bot.refused&&bot.refused.at>refusedAt){
   const first=refusedAt===0&&Date.now()/1000-bot.refused.at>20;refusedAt=bot.refused.at;
   if(!first){handSent='';shown={id:null,turn:-1};if(typeof toast==='function')toast('hivegame.com did not accept that move.')}
  }
 };
 el('hbOpenAll').onchange=async()=>{render.openAllAt=Date.now();const on=el('hbOpenAll').checked;
  try{bot=await post({action:'hivebot_open_all',on,rated:el('hbORated').checked,color:el('hbOColor').value})}
  catch(e){el('hbOpenAll').checked=!on;el('hbStatus').textContent=(window.plainMessage?window.plainMessage(e.message):e.message);el('hbStatus').hidden=false}render()};
 el('hbReopen').onchange=async()=>{render.reopenAt=Date.now();try{bot=await post({action:'hivebot_reopen',on:el('hbReopen').checked})}catch(e){el('hbStatus').textContent=e.message;el('hbStatus').hidden=false}render()};
 el('hbResignLost').onchange=async()=>{try{bot=await post({action:'hivebot_resign_lost',on:el('hbResignLost').checked})}catch(e){el('hbStatus').textContent=e.message;el('hbStatus').hidden=false}render()};
 // Handing back to the engine on our turn: if the engine (the bot's own) already finished thinking about this
 // position, its move is played at once instead of being worked out again.
 const thoughtMove=()=>{const card=bot&&bot.current;
  if(!card||card.finished||!card.our_turn||typeof state==='undefined'||!state||state.mode!=='analysis'||state.insight_job==='hint')return null;
  if(state.ply!==card.turn||!state.hint||!state.hint.move)return null;
  const insight=(state.engines||[]).find(e=>e.id===state.analysis_engine);if(!insight||!bot.engine||insight.name!==bot.engine)return null;
  return {id:card.id,move:state.hint.move}};
 el('hbManual').onchange=async()=>{try{const on=el('hbManual').checked,ready=on?null:thoughtMove();bot=await post({action:'hivebot_manual',on,...(ready||{})})}catch(e){el('hbStatus').textContent=e.message;el('hbStatus').hidden=false}render()};
 try{el('hbInsight').checked=localStorage.getItem('foulbrood_live_insight')==='1'}catch(e){}
 el('hbInsight').onchange=()=>{try{localStorage.setItem('foulbrood_live_insight',el('hbInsight').checked?'1':'0')}catch(e){}render()};
 // Online keeps its own engine-insight switch. While Online is open it decides whether the engine looks at the
 // position (only on the opponent's turn when the bot is playing, so the bot's own thinking is never slowed);
 // on leaving, the suggestions setting the other pages had is put back.
 let outsideHints=null,insightAt=0;
 const syncInsight=(card,manual)=>{
  if(typeof state==='undefined'||!state||typeof action!=='function')return;
  if(!liveOn()){if(outsideHints!==null&&Date.now()-insightAt>800){const v=outsideHints;outsideHints=null;insightAt=Date.now();if(!!state.hints!==v)action({action:'hints',enabled:v}).catch(()=>{})}return}
  if(state.mode!=='analysis')return;
  if(outsideHints===null)outsideHints=!!state.hints;
  // Playing by hand: the engine's suggestion is always shown on our turn; on the opponent's turn only with "Engine insight on the opponent".
  const want=!!card&&!card.finished&&((!!manual&&!!card.our_turn)||(el('hbInsight').checked&&!card.our_turn));
  if(!!state.hints!==want&&Date.now()-insightAt>1500&&!(typeof busy!=='undefined'&&busy)){insightAt=Date.now();action({action:'hints',enabled:want}).catch(()=>{})}
 };
 // With "Engine insight on the opponent", the engine's rating of each position the opponent moved from is kept for the move list.
 const oppRatings={};
 const recordOpp=card=>{
  if(!card||card.our_turn||card.finished||!liveOn()||typeof state==='undefined'||!state||!state.hints||!state.hint||state.ply!==card.turn)return;
  const engine=(state.engines||[]).find(e=>e.id===state.analysis_engine),rating=typeof positionScoreValue==='function'?positionScoreValue(state.hint,engine):null;
  if(rating==null)return;(oppRatings[card.id]=oppRatings[card.id]||{})[card.turn+1]={rating,depth:state.hint.depth||null};
 };
 setInterval(()=>{try{const card=bot&&bot.running?bot.current:null;syncInsight(card,bot&&bot.manual);recordOpp(card)}catch(e){}},700);
 el('hbPass').onclick=()=>{if(typeof action==='function')action({action:'move',move:'pass'})};
 el('hbResign').onclick=()=>{const card=handCard();if(!card)return;ask('Resign this game?','You will lose the game on hivegame.com. Continue?','Resign',async()=>{try{bot=await post({action:'hivebot_control',id:card.id,what:'Resign'})}catch(e){if(typeof toast==='function')toast(e.message)}render()})};
 const render=()=>{
  try{noteAborts()}catch(e){}
  fillEngines();
  if(!bot)return;
  const running=!!bot.running,connected=bot.state==='connected';
  el('hivebotPanel').dataset.state=bot.state;
  fixTabs();
  el('hbStart').disabled=running||starting;el('hbStop').disabled=!running;
  if(enginePending&&bot&&!bot.current)setTimeout(switchEngine,0);
  el('hbEngineRow').title=enginePending?'The new engine takes over after this game.':'';
  el('hbForm').hidden=running;el('hbChallenges').hidden=!connected;el('hbChallenges').classList.toggle('hb-ingame',!!bot.current);el('hbChallenges').classList.toggle('hb-mine',(bot.lobby||[]).some(c=>c.mine)); /* during a game only the automatic switch (and our own open challenge) stays, so it can be turned off */fixTabs();el('hbBusyNote').hidden=true;
  if(bot.saved_login&&!el('hbLogin').value)el('hbLogin').value=bot.saved_login;
  el('hbPassword').placeholder=(bot.saved_login&&bot.saved_login===el('hbLogin').value.trim())?'Saved — leave blank to use it':'';
  el('hbForget').hidden=!bot.saved_login;
  const g=bot.current,last=[...(bot.games||[])].reverse().find(realGame);
  let summary={stopped:'Not running',building:'Building…',starting:'Connecting…',connected:'Connected',error:'Needs attention'}[bot.state]||bot.state;
  let status=bot.message||'';
  if(connected){
   if(g){summary='Playing';status='';}
   else if(last){status=`Last game: ${names(last)} — ${last.result||'finished'}.\nWaiting for the next game.`;}
  }
  {const t=el('hivebotDetails').querySelector('summary strong'),name=connected&&bot.user?bot.user+' bot':'hivegame.com bot';if(t.textContent!==name)t.textContent=name} // the account that is logged in
  el('hbSummary').textContent=summary;el('hbLight').className='hb-light '+(connected?'on':bot.state==='starting'||bot.state==='building'?'wait':'off');site(bot.site);el('hbStatus').textContent=status;el('hbStatus').hidden=!status;
  const card=g||last;el('hbGame').hidden=!card||(!g&&cleared===card.id); // a cleared game takes its hivegame.com link with it
  {const r=document.getElementById('hbLinkRow');if(r)r.hidden=el('hbGame').hidden}
  if(card){
   el('hbPlayers').textContent=names(card);el('hbPlayers').parentElement.hidden=true; // the pairing and result are in the status lines and the player bars
   const move=(card.turn||0)+1; // the viewer numbers every move on its own: White plays 1, Black plays 2
   el('hbTurn').textContent=card.finished?(card.result||'Finished'):card.thinking?`move ${move} · thinking`:card.our_turn?`move ${move} · our turn`:`move ${move} · waiting for opponent`;
   el('hbLink').href=card.url;el('hbLink').onclick=e=>{e.preventDefault();post({action:'hivebot_open',url:card.url}).catch(()=>window.open(card.url,'_blank'))};el('hbShow').onclick=()=>showOnBoard(card);el('hbShow').hidden=el('hbFollow').checked;
  }
  // Same button as on the Play page: take what is on the Live board over to Analysis.
  el('hbToAnalysis').hidden=false;{const some=typeof state!=='undefined'&&state&&hasGame(state.game);el('hbClear').disabled=!!g||!some;el('hbToAnalysis').disabled=!some} // nothing to clear mid-game, nothing to open or clear on an empty board
  el('hbToAnalysis').textContent='Open in Analysis';
  clockCard=card||null;clockFetched=Date.now();drawClocks();drawThought(card);
  if(connected){
   {const real=!!bot.direct,box=el('hbAuto');if(box.checked!==real&&Date.now()-(render.autoAt||0)>4000)box.checked=real}
   if(Date.now()-(render.autoAt||0)>4000)for(const [id,k] of [['hbDirectMin','direct_min'],['hbDirectMax','direct_max']]){const v=Array.isArray(bot[k])?bot[k].join('+'):null;if(v&&[...el(id).options].some(o=>o.value===v)&&el(id).value!==v)el(id).value=v}
   el('hbDirectRange').classList.toggle('off',!el('hbAuto').checked); // the switch shows what the bot is really doing, in every window
   el('hbAccepting').hidden=true;
   drawLobby(!!g);
  }
  const pending=(bot.lobby||[]).some(c=>c.mine); // a sent challenge is only news while it is still waiting
  // One notice at a time: the newest line only, and it clears itself after half a minute or when a game starts.
  {const line=(bot.log||[]).filter(line=>!/^Accepted a challenge/.test(line)&&(pending||!/^Challenge sent/.test(line))).slice(-1)[0]||'';
   if(line!==render.logLine){render.logAt=render.logLine===undefined?0:Date.now();render.logLine=line} // a line already there when the page opens is old news
   const show=!!line&&!bot.current&&(Date.now()-(render.logAt||0)<30000||/^Challenge sent/.test(line));
   el('hbLog').textContent=show?line:'';el('hbLog').hidden=!show;}
  if('cleared' in bot&&(bot.cleared||null)!==cleared&&Date.now()-clearedAt>4000)keepCleared(bot.cleared||null); // every window follows the app's copy
  if(card&&!card.finished&&cleared)setCleared(null);
  // Playing by hand: after our own move the board is already right, so it is not reloaded from the site.
  if(bot.manual&&card&&card.id===shown.id&&card.turn!==shown.turn&&typeof state!=='undefined'&&state&&(state.review_total||0)===card.turn&&(state.ply||0)===card.turn)shown={id:card.id,turn:card.turn};
  if(liveOn()&&el('hbFollow').checked&&card&&cleared!==card.id&&(card.id!==shown.id||card.turn!==shown.turn))showOnBoard(card);
  try{handPanel(connected)}catch(e){}
  try{if(typeof state!=='undefined'&&state){drawNativeStrip(state);drawNativePreview(state);drawIdentity(state)}}catch(e){}
  try{feedSounds()}catch(e){}
 };
 // ---- Native display: the viewer's own player strip and move preview, fed by the bot's thinking ----
 let thinkKey='',thinkSince=0;
 const thinkTook={}; // how long each of our moves took, kept so the time stays up after the move and when stepping back
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
  const card=bot.current||[...(bot.games||[])].reverse().find(realGame);
  if(!card||shown.id!==card.id||cleared===card.id)return null;
  if(typeof editorDraft!=='undefined'&&editorDraft)return null;
  return card;
 };
 const nativeCard=s=>{const card=boardCard(s);return card&&card.info?card:null};
 // The bot's rating of each of its moves in the game on the Online board, for the move list.
 // The game's hivegame.com link sits in the History box, right under its title (Online only).
 {const wrap=document.createElement('div');wrap.id='hbLinkRow';wrap.className='hb-link-row';wrap.append(el('hbLink'));
  const panel=document.getElementById('historyPanel'),row=panel&&panel.querySelector(':scope > .row');if(row)row.after(wrap);el('hbGame').classList.add('hb-game-moved')}
 // The bot's messages are shown as banners on the board (while Online is open), not as text in its box.
 {const last={};const banner=id=>{const text=(el(id).textContent||'').trim();if(!text||text===last[id])return;
   if(!document.body.classList.contains('hb-live'))return; // shown when Online is open
   last[id]=text;if(typeof toast==='function')toast(text.replace(/\s*\n\s*/g,' · '))};
  for(const id of ['hbStatus','hbLog'])new MutationObserver(()=>banner(id)).observe(el(id),{childList:true,characterData:true,subtree:true});
  new MutationObserver(()=>{if(document.body.classList.contains('hb-live')){banner('hbLog');banner('hbStatus')}}).observe(document.body,{attributes:true,attributeFilter:['class']})}
 window.foulbroodLiveEvals=s=>{try{const card=boardCard(s);if(!card)return null;return {side:card.white===bot.user?0:1,evals:card.evals||{},hand:card.hand||[],opp:oppRatings[card.id]||{}}}catch(e){return null}};
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
  const side=card.white===bot.user?0:1,color=side===0?'white':'black';
  // Stepping back through the game: show what the engine thought at its latest move up to the one on the board.
  let info=card.info,stepped=false;
  if(card.evals&&typeof s.ply==='number'&&s.ply<(s.review_total??s.ply)){
   stepped=true;let at=null;for(const k in card.evals){const t=+k;if(t%2===side&&t+1<=s.ply&&(at===null||t>at))at=t}
   info=at===null?{turn:null,depth:null,score:null,move:'—'}:{turn:at,depth:card.evals[at][0],score:card.evals[at][1],move:card.evals[at][2]};
  }
  const strip=el(color+'Thought'),bar=el(color+'Clock').closest('.player'),source=el(color+'InsightSource');
  const key=card.id+'|'+info.turn,thinking=!!card.thinking&&!stepped;if(thinking&&key!==thinkKey){thinkKey=key;thinkSince=Date.now()}
  strip.hidden=false;el(color+'ReviewThought').hidden=true;bar.classList.add('bot-duel');bar.classList.toggle('bot-thinking',thinking);
  source.hidden=false;source.style.visibility='';source.textContent=identity(card,color,(bot.engine||'engine').replace(/ /g,'\u00a0'));source.title=source.textContent;
  const fields=botThoughtFields(strip),moveNumber=(info.turn||0)+1;
  let text=info.move;try{if(typeof insightMoveText==='function'&&s.ply===info.turn)text=insightMoveText(s.game,(legalFor(s,info.move)||{}).move||info.move,notationFollowsBoard())||info.move}catch(e){}
  fields.move.caption.textContent=info.turn===null?'Waiting':(thinking?'Thinking':'Played')+' · Move '+moveNumber;fields.move.value.textContent=text;fields.move.value.title='Top move: '+text;fields.move.value.disabled=true;
  fields.depth.value.textContent=info.depth===null?'—':String(info.depth);
  if(thinking&&key===thinkKey)thinkTook[key]=(Date.now()-thinkSince)/1000;
  fields.time.value.textContent=thinkTook[key]!=null?thinkTook[key].toFixed(1)+'s':'—';fields.time.value.title=thinking?'Time on this move so far':'Time this move took';
  updatePositionScore(fields.score,{score:info.score,side,source:'bot'},null,{side,label:'Position'});
 };
 // Who the player is on hivegame.com: rating (and its change once the game is over) beside the name,
 // and the record at this speed on the line below.
 const identity=(card,color,lead)=>{
  const info=card[color+'_card'];if(!info)return lead;
  const name=el(color+'Name'),base=card[color]||name.textContent;
  const who=document.createElement('span');who.className='fb-nm';who.textContent=base.replace(/\s+\d+(\s*\([^)]*\))?$/,'');
  const parts=[who];
  if(info.rating!=null){
   const rate=document.createElement('span');rate.className='fb-rt';rate.textContent=Math.round(info.rating);
   if(card.finished&&info.change!=null){const d=Math.round(info.change),delta=document.createElement('b');delta.className=d>0?'up':d<0?'down':'';delta.textContent=(d>0?'+':d<0?'−':'±')+Math.abs(d);rate.append(' ',delta)}
   parts.push(rate);
  }
  const sig=parts.map(p=>p.textContent).join('|');
  if(name.dataset.sig!==sig||!name.querySelector('.fb-nm')){name.replaceChildren(...parts);name.dataset.sig=sig}name.title='Rating on hivegame.com at this time control'+(card.finished?', and the change from this game':'');
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
  if(oppClock.id!==card.id){oppClock.id=card.id;oppClock.left=left;oppClock.used=null;oppClock.turn=card.turn||0}
  else if((card.turn||0)!==oppClock.turn){ // worked out once per move, when the move is made: clock at the start of its turn, less the clock now, plus the increment
   if(oppClock.turn%2===side)oppClock.used=Math.max(0,oppClock.left-left+(card.increment||0));
   oppClock.left=left;oppClock.turn=card.turn||0}
  const strip=el(color+'Thought'),bar=el(color+'Clock').closest('.player'),fields=botThoughtFields(strip);
  const toMove=!card.finished&&(card.turn||0)%2===side,moveNumber=(card.turn||0)+1;
  strip.hidden=false;bar.classList.add('bot-duel');bar.classList.toggle('bot-thinking',toMove);
  const source=el(color+'InsightSource');source.hidden=false;source.style.visibility='';source.textContent=identity(card,color,'')||'Opponent on hivegame.com';source.title=source.textContent;
  fields.move.caption.textContent=toMove?'Thinking · Move '+moveNumber:'Waiting';fields.move.value.textContent='—';fields.move.value.disabled=true;
  const elapsed=(card.turn_age!=null?card.turn_age:(card.clock_age||0))+(Date.now()-clockFetched)/1000; // counted from when the move began, not from the site's latest update
  fields.time.value.textContent=toMove&&(card.turn||0)>=2?elapsed.toFixed(1)+'s':oppClock.used!=null?oppClock.used.toFixed(1)+'s':'—';
  fields.time.value.title=toMove?'Time on this move so far':'Time the last move took';
  fields.depth.value.textContent='—';
  // Engine insight on the opponent: what our engine makes of the position while the opponent thinks.
  const h=el('hbInsight').checked&&toMove&&typeof state!=='undefined'&&state&&state.hint&&state.hint.side===side&&(s.ply||0)===(card.turn||0)?state.hint:null;
  if(h){fields.move.caption.textContent='Insight · Move '+moveNumber;fields.move.value.textContent=h.move||'—';fields.move.value.title='What the engine would play here';fields.depth.value.textContent=h.depth!=null?String(h.depth):'—'}
  if(typeof updatePositionScore==='function')updatePositionScore(fields.score,h,null,{side,label:'Position'});
 };
 // ---- Sounds: feed the viewer's own sound logic a play-style picture of the bot's game ----
 // (turn chirp on every move, the ending fanfare). The Sound button and volume settings apply as usual.
 const soundTurn={key:null,clocks:[null,null]};
 const soundCard=()=>{
  if(!bot||!bot.running)return null;
  const card=bot.current||[...(bot.games||[])].reverse().find(realGame);
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
  const turnKey=card.id+'|'+(card.turn||0);
  if(soundTurn.key!==turnKey){soundTurn.key=turnKey;soundTurn.clocks=live;soundTurn.at=Date.now();soundTurn.epoch=0}
  else if(!done&&(card.turn||0)>=2&&Math.abs(live[side]-(soundTurn.clocks[side]-(Date.now()-soundTurn.at)/1000))>2.5){soundTurn.clocks=live;soundTurn.at=Date.now();soundTurn.epoch=(soundTurn.epoch||0)+1} // the site corrected the clock mid-move: schedule the ticking and countdown again from the right figure
  const gameKey=card.id+(soundTurn.epoch?'#'+soundTurn.epoch:''),control=card.base!=null?`${Math.round(card.base/60)}+${card.increment||0}`:'10+10';
  const ending=done?({'White won':'WhiteWins','Black won':'BlackWins','Draw':'Draw'}[card.result]||null):null;
  nativeObserve({mode:'play',running:!done,timeout_side:null,resigned_side:null,completed_state:ending,state:'InProgress',
   live_bot:true,bot_won:done?(card.result==='White won')===(card.white===bot.user):null,
   players:['Human','Human'],side,live_side:side,game:gameKey,live_game:gameKey+';InProgress',
   clocks:soundTurn.clocks,time_control:control,review_total:(card.turn||0)});
 };
 if(typeof window.renderBotThoughts==='function'){
  const nativeThoughts=window.renderBotThoughts;
  window.renderBotThoughts=s=>{nativeThoughts(s);fixTabs();try{handWatch(s)}catch(e){}try{drawNativeStrip(s);drawOpponentStrip(s);drawIdentity(s);drawNativePreview(s);drawClocks()}catch(e){}};
 }
 const site=ok=>{let s=el('hbSite');if(!s){const t=document.querySelector('.header-tools');if(!t)return;s=document.createElement('span');s.id='hbSite';s.className='hb-site';s.innerHTML='<i class="hb-light" aria-hidden="true"></i>hivegame.com';t.prepend(s)}s.firstChild.className='hb-light '+(ok===true?'on':ok===false?'off':'wait');s.title=ok===true?'Connected to hivegame.com':ok===false?'Can\u2019t reach hivegame.com':'Checking hivegame.com';};
 const refresh=async()=>{try{bot=await post({action:'hivebot_status',lobby:el('hivebotDetails').open});render()}catch(e){}};
 const schedule=()=>{clearTimeout(timer);timer=setTimeout(async()=>{await refresh();schedule()},bot&&bot.running?2000:el('hivebotDetails').open?4000:15000)};
 el('hbStart').onclick=async()=>{
  starting=true;el('hbStart').disabled=true;el('hbStatus').textContent='Starting…';remember();
  try{bot=await post({action:'hivebot_start',login:el('hbLogin').value,password:el('hbPassword').value,engine:el('hbEngine').value,...rules(),min_base:600,remember:el('hbRemember').checked&&!!el('hbPassword').value});el('hbPassword').value='';}
  catch(e){el('hbStatus').textContent=(window.plainMessage?window.plainMessage(e.message):e.message)}
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
  catch(e){el('hbStatus').textContent=(window.plainMessage?window.plainMessage(e.message):e.message)}
  finally{switching=false;starting=false;render();schedule()}
 };
 el('hbEngine').addEventListener('change',switchEngine);
 el('hbStop').onclick=async()=>{el('hbStop').disabled=true;try{bot=await post({action:'hivebot_stop'})}catch(e){el('hbStatus').textContent=(window.plainMessage?window.plainMessage(e.message):e.message)}render();schedule()};
 el('hbForget').onclick=async()=>{try{bot=await post({action:'hivebot_forget'})}catch(e){el('hbStatus').textContent=(window.plainMessage?window.plainMessage(e.message):e.message)}render()};
 // Two ways to challenge: open (the lobby, with a rating range) or sent to one named player.
 const challenge=async(button,payload)=>{
  button.disabled=true;
  try{bot=await post({action:'hivebot_challenge',...payload})}catch(e){el('hbStatus').textContent=(window.plainMessage?window.plainMessage(e.message):e.message)}
  button.disabled=false;render();
 };
 el('hbTime').addEventListener('change',()=>render()); // ratings in the opponent menu follow the chosen time control
 const clearBoard=async()=>{
  const last=bot&&[...(bot.games||[])].reverse().find(realGame);setCleared(last?last.id:'none');shown={id:null,turn:-1};
  try{await whenFree(()=>action({action:'load',text:state.game.split(';')[0].split('~')[0],confirm_review_clear:true}))}catch(e){}
  render();
 };
 el('hbClear').onclick=()=>{
  if(bot&&bot.current)return;if(typeof state==='undefined'||!state||state.mode!=='analysis')return;
  if(hasGame(state.game))ask('Clear the game?','This will clear the board and the game history. Continue?','Clear game',clearBoard);
 };

 const toAnalysis=async()=>{
  const card=bot&&(bot.current||[...(bot.games||[])].reverse().find(realGame));
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
 el('hbTake').onclick=async()=>{const id=el('hbPick').value;if(!id)return;el('hbTake').disabled=true;try{bot=await post({action:'hivebot_take',id})}catch(e){el('hbStatus').textContent=(window.plainMessage?window.plainMessage(e.message):e.message)}render()};
 el('hbSend').onclick=()=>{
  const opponent=el('hbOpponent').value.trim();if(!opponent){el('hbOpponent').focus();return}
  const [base,increment]=el('hbTime').value.split('+').map(Number);
  challenge(el('hbSend'),{opponent,base,increment,rated:el('hbRated').checked,color:el('hbColor').value});
 };
 el('hbOpen').onclick=()=>{
  const [base,increment]=el('hbOTime').value.split('+').map(Number);
  challenge(el('hbOpen'),{opponent:'',base,increment,rated:el('hbORated').checked,color:el('hbOColor').value});
 };
 for(const id of ['hbFollow','hbEngine','hbLogin'])el(id).addEventListener('change',remember);
 // The range keeps its order: moving one end past the other moves the other end with it.
 const len=v=>{const [b,i]=v.split('+').map(Number);return b+40*i};
 el('hbDirectMin').addEventListener('change',()=>{if(len(el('hbDirectMin').value)>len(el('hbDirectMax').value))el('hbDirectMax').value=el('hbDirectMin').value},true);
 el('hbDirectMax').addEventListener('change',()=>{if(len(el('hbDirectMax').value)<len(el('hbDirectMin').value))el('hbDirectMin').value=el('hbDirectMax').value},true);
 for(const id of ['hbAuto','hbAcceptTime','hbMax','hbOnly','hbHumans','hbDirectMin','hbDirectMax'])el(id).addEventListener('change',async()=>{
  remember();render.autoAt=Date.now();if(!bot||!bot.running)return;
  try{bot=await post({action:'hivebot_accept',...rules()})}catch(e){el('hbStatus').textContent=(window.plainMessage?window.plainMessage(e.message):e.message)}render();
 });
 el('hbLogin').addEventListener('input',render);
 // What the History tab needs from Live.
 // A game opened into Analysis from anywhere but Online (Local, a file, a link, the Archive) is the user's own:
 // the board is no longer the bot's, and nothing set aside earlier should come back over it.
 if(typeof action==='function'&&!action.liveWrapped){const real=action;action=async function(payload){
  if(payload&&['open_analysis','load','review_load','setup_position'].includes(payload.action)&&!live&&botBoard()){stash(null);botBoard(false);shown={id:null,turn:-1}}
  return real.apply(this,arguments)};action.liveWrapped=true}
 window.foulbroodLive={botName:()=>{try{return (bot&&(bot.user||bot.saved_login))||''}catch(e){return ''}},stepped:s=>{try{const c=boardCard(s);return !!c&&!c.finished&&document.body.classList.contains('hb-live')&&typeof s.ply==='number'&&s.ply<(s.review_total??s.ply)}catch(e){return false}},ask,card:()=>soundCard(),setLive:v=>{setLive(v);fixTabs()},boardIsLive:()=>botBoard(),hasStash:()=>hasGame(stash()),dropStash:()=>{stash(null);botBoard(false);shown={id:null,turn:-1}}};
 setTimeout(()=>{if(typeof state==='undefined'||!state||state.mode!=='analysis')return;(live?takeBoard():releaseBoard()).catch(()=>{})},1500);
 el('hbFollow').addEventListener('change',()=>{if(el('hbFollow').checked)shown={id:null,turn:-1};render()});
 el('hivebotDetails').addEventListener('toggle',()=>{refresh();schedule()});
 el('hbPassword').addEventListener('keydown',e=>{if(e.key==='Enter')el('hbStart').click()});
 setTimeout(()=>{refresh().then(()=>{if(bot&&bot.running)el('hivebotDetails').open=true;schedule()})},600);
})();

// ---- History tab: every game played, played by the bot, or imported, saved automatically ----
(()=>{
 const el=id=>document.getElementById(id),L=()=>window.foulbroodLive;
 const call=async(name,payload={})=>{
  const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-Board-Token':window.BOARD_TOKEN},body:JSON.stringify({...payload,action:'hivebot_library_'+name})});
  const d=await r.json();if(!r.ok)throw Error(d.error||'The archive is not available.');return d;
 };
 let open=false,timer=null;
 const tabs=['playTab','liveTab','analysisTab','engineTab'];
 const show=v=>{
  open=v;document.body.classList.toggle('history-open',v);el('historyTab').classList.toggle('active',v);
  if(v){try{enginePageOpen=false;if(typeof renderEngines==='function'&&typeof state!=='undefined'&&state)renderEngines(state)}catch(e){}for(const id of tabs)el(id).classList.remove('active');refresh()}
 };
 // Other scripts re-mark their own tab on every redraw; keep History the only marked one while it is open.
 el('historyTab').onclick=()=>show(true);
 for(const id of tabs)el(id).addEventListener('click',()=>show(false));

 const when=text=>{const d=new Date(text);return isNaN(d)?'':d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'})+' · '+d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})};
 const player=(g,side)=>{
  let text=g[side]||(side==='white'?'White':'Black');const r=g[side+'_rating'],c=g[side+'_change'];
  if(r!=null){text+=' '+Math.round(r);if(c!=null){const d=Math.round(c);text+=' ('+(d>0?'+':d<0?'−':'±')+Math.abs(d)+')'}}
  return text;
 };
 // Filters across games: seen from one player's side (the bot's by default), by opponent, colour, result and opening.
 let allGames=[],meChosen=false;
 const fill=(select,options,keep)=>{const was=keep!=null?keep:select.value;select.replaceChildren();for(const [value,label]of options){const o=document.createElement('option');o.value=value;o.textContent=label;select.append(o)}select.value=options.some(o=>o[0]===was)?was:options[0][0]};
 const tally=list=>{const counts=new Map();for(const x of list)if(x)counts.set(x,(counts.get(x)||0)+1);return [...counts].sort((a,b)=>b[1]-a[1])};
 const outcomeFor=(g,me)=>{const r=String(g.result||'');const w=/^White won/.test(r)?'white':/^Black won/.test(r)?'black':/^Draw/.test(r)?'draw':'';if(!w)return '';if(w==='draw')return 'draw';if(!me)return w;return g[w]===me?'won':'lost'};
 const applyFilters=()=>{
  const names=tally(allGames.flatMap(g=>[g.white,g.black]));
  let me=el('histMe').value;if(!meChosen){let bot='';try{bot=(window.foulbroodLive&&window.foulbroodLive.botName&&window.foulbroodLive.botName())||''}catch(e){}me=names.some(n=>n[0]===bot)?bot:(names[0]&&names[0][1]>1?names[0][0]:'')}
  fill(el('histMe'),[['','Anyone'],...names.map(([n,c])=>[n,`${n} (${c})`])],me);me=el('histMe').value;
  const mine=me?allGames.filter(g=>g.white===me||g.black===me):allGames;
  fill(el('histOpp'),[['','Anyone'],...tally(mine.flatMap(g=>me?[g.white===me?g.black:g.white]:[g.white,g.black])).map(([n,c])=>[n,`${n} (${c})`])]);
  fill(el('histOpening'),[['','Any'],...tally(mine.map(g=>g.opening)).map(([n,c])=>[n,`${n} (${c})`])]);
  for(const id of ['histColour','histResult'])el(id).disabled=!me;if(!me){el('histColour').value='';el('histResult').value=''}
  const opp=el('histOpp').value,colour=el('histColour').value,result=el('histResult').value,opening=el('histOpening').value;
  const shown=mine.filter(g=>(!opp||g.white===opp||g.black===opp)&&(!colour||g[colour]===me)&&(!opening||g.opening===opening)&&(!result||outcomeFor(g,me)===result));
  const n=k=>shown.filter(g=>outcomeFor(g,me)===k).length;
  const totals=me?`${n('won')} won · ${n('lost')} lost`+(n('draw')?` · ${n('draw')} drawn`:''):`White won ${n('white')} · Black won ${n('black')}`+(n('draw')?` · ${n('draw')} drawn`:'');
  return {shown,totals};
 };
 for(const id of ['histMe','histOpp','histColour','histResult','histOpening'])el(id).addEventListener('change',()=>{if(id==='histMe')meChosen=true;draw(null)});
 // Report: patterns across the games shown, from the chosen player's side. Every line carries its counts and links to its games.
 let shownGames=[];
 const day=text=>{const d=new Date(text);return isNaN(d)?'':d.toLocaleDateString(undefined,{month:'short',day:'numeric'})};
 const signed=n=>(n>0?'+':n<0?'−':'')+Math.abs(n);
 const showReport=r=>{
  const box=el('histReport');box.replaceChildren();box.hidden=false;
  const make=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e};
  const head=make('div','hist-report-head');head.append(make('h3','',`${r.me}${r.opponents.length===1?' vs '+r.opponents[0]:''} · ${r.total.games} game${r.total.games===1?'':'s'}`));
  const close=make('button','small','Close');close.type='button';close.onclick=()=>{box.hidden=true;box.replaceChildren()};head.append(close);box.append(head);
  const list=make('ul','hist-report-findings');for(const f of r.findings)list.append(make('li','',f));box.append(list);
  const section=(title,rows,line)=>{if(!rows.length)return;box.append(make('h4','',title));const wrap=make('div','hist-report-rows');
   for(const row of rows.slice(0,40)){const b=make('button','hist-report-row');b.type='button';line(row,b);wrap.append(b)}box.append(wrap)};
  // Review the games that have none yet, in the background (the Analysis board is not used).
  const missing=r.total.games-(r.reviewed||0),bar=make('div','hist-report-batch');box.append(bar);
  const drawBatch=st=>{bar.replaceChildren();
   if(st&&st.running){const moves=st.moves?` · move ${Math.min(st.ply+1,st.moves)} of ${st.moves}`:'';bar.append(make('span','',st.paused?`Paused while ${r.me} plays · game ${st.done+1} of ${st.total}`:`Reviewing game ${Math.min(st.done+1,st.total)} of ${st.total}${st.current?' · '+st.current:''}${moves}`));
    const stop=make('button','small','Stop');stop.type='button';stop.onclick=async()=>{try{drawBatch(await call('batch_stop'))}catch(e){toast(e.message)}};bar.append(stop);return}
   if(st&&st.error)bar.append(make('span','',st.error));
   if(missing>0){const time=document.createElement('select');for(const [v,t]of [[2,'2 seconds'],[5,'5 seconds'],[15,'15 seconds'],[30,'30 seconds'],[60,'1 minute'],[300,'5 minutes'],[900,'15 minutes'],[3600,'1 hour']]){const o=make('option','',t);o.value=v;time.append(o)}time.value='5';time.setAttribute('aria-label','Thinking time for each move');
    const go=make('button','small primary',`Review these games (${missing})`);go.type='button';go.title='Runs Game review on each game that has none, one at a time, in the background';
    go.onclick=async()=>{try{const ids=shownGames.filter(g=>!(g.review&&g.review.total&&g.review.reviewed>=g.review.total)).map(g=>g.id);drawBatch(await call('batch_start',{ids,seconds:+time.value}));poll()}catch(e){toast(window.plainMessage?window.plainMessage(e.message):e.message)}};
    bar.append(go,time)}
  };
  let pollTimer=null;const poll=()=>{clearTimeout(pollTimer);pollTimer=setTimeout(async()=>{if(box.hidden||!bar.isConnected)return;try{const st=await call('batch_status');drawBatch(st);if(st.running)poll();else{refresh().then(()=>el('histReportGo').click()).catch(()=>{})}}catch(e){}},3000)};
  drawBatch(null);call('batch_status').then(st=>{if(st.running){drawBatch(st);poll()}}).catch(()=>{});
  section('Openings',r.openings.filter(o=>o.games>=2),(o,b)=>{b.append(make('span','',`${o.colour==='white'?'White':'Black'} · ${o.opening}`),make('strong','',`${o.won} won · ${o.lost} lost`));b.title='Show these games';
   b.onclick=()=>{el('histColour').value=o.colour;draw(null);el('histOpening').value=o.opening;draw(null)}});
  const where=t=>[`vs ${t.opponent}`,t.colour==='white'?'White':'Black',t.clock,day(t.played)].filter(Boolean).join(' · ');
  section('Where the losses turned',r.turning,(t,b)=>{b.append(make('span','',`Move ${t.move} · ${where(t)}`),make('strong','',`${signed(t.before)} → ${signed(t.after)}`));b.title='Open this game at that move';b.onclick=()=>openGame(t.id,t.move).catch(e=>toast(e.message))});
  section('Rated itself winning, then lost',r.ahead,(t,b)=>{b.append(make('span','',`Move ${t.move} · ${where(t)}`),make('strong','',signed(t.peak)));b.title='Open this game at that move';b.onclick=()=>openGame(t.id,t.move).catch(e=>toast(e.message))});
 };
 el('histReset').onclick=()=>{el('histSearch').value='';meChosen=false;for(const id of ['histOpp','histColour','histResult','histOpening'])el(id).value='';el('histMe').value='';refresh().catch(()=>draw(null))};
 el('histReportGo').onclick=async()=>{const me=el('histMe').value;if(!me){toast('Choose a player first.');return}
  try{showReport(await call('report',{me,ids:shownGames.map(g=>g.id)}))}catch(e){toast(window.plainMessage?window.plainMessage(e.message):e.message)}};
 const draw=data=>{
  if(data){allGames=data.games||[];draw.total=data.total||0}
  const {shown,totals}=applyFilters();data={games:shown,total:shown.length};
  shownGames=shown;el('histReportGo').disabled=!el('histMe').value||!shown.length;
  el('histFilters').hidden=!allGames.length;
  const list=el('histList');list.replaceChildren();
  el('histCount').textContent=data.total?`${data.total} game${data.total===1?'':'s'} · ${totals}`:(allGames.length||el('histSearch').value.trim()?'No games match.':'No games yet. Finished games appear here on their own.');
  for(const g of data.games){
   const row=document.createElement('div');row.className='hist-row'+(g.starred?' starred':'');
   const star=document.createElement('button');star.className='hist-star';star.textContent=g.starred?'★':'☆';star.title=g.starred?'Remove the star':'Star: keep at the top of the list';star.setAttribute('aria-pressed',String(!!g.starred));
   star.onclick=async()=>{try{await call('star',{id:g.id,starred:!g.starred});refresh()}catch(e){toast(e.message)}};
   const text=document.createElement('div');text.className='hist-text';
   const title=document.createElement('strong');title.textContent=`${player(g,'white')}  vs  ${player(g,'black')}`;
   // Same three lines as an engine entry: name, a grey detail line, then the highlighted status line.
   const kinds=[g.white_kind,g.black_kind].filter(Boolean).join(' vs ');
   const meta=document.createElement('span');meta.className='caption';meta.textContent=[g.time_control||'',g.source||'',when(g.played||g.saved),kinds,g.note].filter(Boolean).join(' · ');
   const bits=[g.result||'',g.moves?`${g.moves} moves`:''];
   if(g.review)bits.push(g.review.total&&g.review.reviewed<g.review.total?`Partial review · ${g.review.reviewed} of ${g.review.total} moves`:'Reviewed');
   const extra=document.createElement('span');extra.className='hist-result';extra.textContent=bits.filter(Boolean).join(' · ');
   text.append(title);if(meta.textContent)text.append(meta);if(extra.textContent)text.append(extra);
   const buttons=document.createElement('div');buttons.className='hist-buttons';
   const openButton=document.createElement('button');openButton.textContent='Open in Analysis';openButton.onclick=()=>openGame(g.id).catch(e=>toast(e.message));
   const del=document.createElement('button');del.textContent='Delete';
   del.onclick=()=>L().ask('Delete this game?',`${g.white||'White'} vs ${g.black||'Black'} will be removed from the archive`+(g.review?', with its review results':'')+'. Continue?','Delete',async()=>{try{await call('delete',{id:g.id});refresh()}catch(e){toast(e.message)}});
   buttons.append(openButton);
   if(/^https:\/\/hivegame\.com\/game\/[A-Za-z0-9_-]{1,40}$/.test(g.url||'')){ // played on hivegame.com: a link to its page there, after the result on the same line
    const site=document.createElement('a');site.className='hist-link';site.href=g.url;site.target='_blank';site.rel='noopener';site.textContent='Open on hivegame.com ↗';
    site.onclick=e=>{e.preventDefault();fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-Board-Token':window.BOARD_TOKEN},body:JSON.stringify({action:'hivebot_open',url:g.url})}).then(r=>{if(!r.ok)throw 0}).catch(()=>window.open(g.url,'_blank','noopener'))};
    if(extra.textContent&&extra.parentNode===text){const line=document.createElement('span');line.className='hist-last';extra.replaceWith(line);line.append(extra,site)}else text.append(site)}
   buttons.append(del);row.append(star,text,buttons);list.append(row);
  }
 };
 const refresh=async()=>{try{draw(await call('list',{query:el('histSearch').value}))}catch(e){el('histCount').textContent=(window.plainMessage?window.plainMessage(e.message):e.message)}};
 el('histSearch').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(refresh,200)});

 const free=async()=>{for(let i=0;i<40&&typeof busy!=='undefined'&&busy;i++)await new Promise(r=>setTimeout(r,100))};
 // A game opened from History keeps its players on the Analysis status bars: name, rating and change, and what kind of game it was.
 const movesOf=game=>String(game||'').split(';').slice(3).map(m=>m.trim()).filter(Boolean).join(';');
 let opened=null;try{opened=JSON.parse(localStorage.getItem('foulbrood_analysis_players')||'null')}catch(e){}
 // After a page reload, fetch the opened game's details again so newer ones (move times, in-game ratings) appear without reopening it.
 if(opened&&opened.id)setTimeout(()=>call('get',{id:opened.id}).then(g=>{if(!opened||opened.id!==g.id)return;if(Array.isArray(g.times))opened.times=g.times;if(g.bot_evals&&g.bot_name){opened.evals=g.bot_evals;opened.bot=g.bot_name}if(g.result)opened.result=g.result;
  try{localStorage.setItem('foulbrood_analysis_players',JSON.stringify(opened))}catch(e){}try{if(typeof lastBoardKey!=='undefined')lastBoardKey='';if(typeof render==='function'&&typeof serverState!=='undefined'&&(serverState||state))render(serverState||state)}catch(e){}}).catch(()=>{}),600);
 const rememberPlayers=g=>{
  opened={moves:movesOf(g.game),id:g.id};for(const k of ['url','white','black','white_kind','black_kind','white_rating','black_rating','white_change','black_change','time_control','played','source','result'])if(g[k]!=null)opened[k]=g[k];if(Array.isArray(g.times))opened.times=g.times;if(g.bot_evals&&g.bot_name){opened.evals=g.bot_evals;opened.bot=g.bot_name}
  try{localStorage.setItem('foulbrood_analysis_players',JSON.stringify(opened))}catch(e){}
 };
 let wantPly=null;
 const seekPly=s=>{
  if(!wantPly||!s)return;if(Date.now()>wantPly.until){wantPly=null;return}
  if(s.mode!=='analysis'||movesOf(s.review_game||s.game)!==wantPly.moves||(typeof busy!=='undefined'&&busy)||document.querySelector('dialog[open]'))return;
  const ply=wantPly.ply;wantPly=null;if(s.ply!==ply&&ply<=(s.review_total??ply))action({action:'navigate',ply});
 };
 const showPlayers=s=>{
  if(!opened||!s||s.mode!=='analysis'||document.body.classList.contains('hb-live'))return;
  const now=movesOf(s.review_game||s.game);if(!opened.moves||!(now===opened.moves||now.startsWith(opened.moves+';')||opened.moves.startsWith(now+';')||now===''&&false))return; // still that game (stepped back, or played on from it)
  const day=String(opened.played||'').slice(0,10);
  for(const color of ['white','black']){
   const who=opened[color];if(!who)continue;
   const name=el(color+'Name'),label=document.createElement('span');label.className='fb-nm';label.textContent=who;const parts=[label];
   const rating=opened[color+'_rating'],change=opened[color+'_change'];
   if(rating!=null){const rate=document.createElement('span');rate.className='fb-rt';rate.textContent=Math.round(rating);
    if(change!=null){const d=Math.round(change),delta=document.createElement('b');delta.className=d>0?'up':d<0?'down':'';delta.textContent=(d>0?'+':d<0?'−':'±')+Math.abs(d);rate.append(' ',delta)}
    parts.push(rate)}
   name.replaceChildren(...parts);name.title=rating!=null?'Rating at the time of this game, and the change from it':who;
   const source=el(color+'InsightSource');if(source){const bits=[opened[color+'_kind'],opened.time_control,opened.source==='Live'?'hivegame.com':opened.source,day].filter(Boolean);
    if(bits.length){source.hidden=false;source.style.visibility='';source.textContent=bits.join(' · ');source.title=source.textContent}}
  }
 };
 // How the game opened from History ended, while it is still the game on the Analysis board ("... by resignation" / "... on time").
 window.foulbroodOpenedTimes=s=>{try{if(!opened||!opened.moves||!Array.isArray(opened.times)||!s)return null;const now=movesOf(s.review_game||s.game);return now===opened.moves||now.startsWith(opened.moves+';')||opened.moves.startsWith(now+';')?opened.times:null}catch(e){return null}};
 window.foulbroodOpenedEvals=s=>{try{if(!opened||!opened.moves||!opened.evals||!s)return null;const now=movesOf(s.review_game||s.game);if(!(now===opened.moves||now.startsWith(opened.moves+';')||opened.moves.startsWith(now+';')))return null;return {bot:opened.bot,side:opened.white===opened.bot?0:1,evals:opened.evals}}catch(e){return null}};
 // The hivegame.com page of the game on the Analysis board (from the Archive or the Online board), shown under the History title.
 const linkByMoves=new Map();
 window.foulbroodLinkSeen=(game,url)=>{const m=movesOf(game);if(m&&url){linkByMoves.set(m,url);if(linkByMoves.size>40)linkByMoves.delete(linkByMoves.keys().next().value)}};
 const analysisLink=s=>{
  const now=movesOf(s.review_game||s.game);if(!now)return null;
  const same=m=>m&&(now===m||now.startsWith(m+';')||m.startsWith(now+';'));
  if(opened&&opened.url&&same(opened.moves))return opened.url;
  for(const [m,url]of linkByMoves)if(same(m))return url;
  return null;
 };
 {const row=document.createElement('div');row.id='anLinkRow';row.className='hb-link-row';row.hidden=true;
  const a=document.createElement('a');a.href='#';a.textContent='Open on hivegame.com ↗';a.target='_blank';a.rel='noopener noreferrer';row.append(a);
  a.onclick=e=>{e.preventDefault();const url=a.dataset.url;if(url)fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-Board-Token':window.BOARD_TOKEN},body:JSON.stringify({action:'hivebot_open',url})}).then(r=>{if(!r.ok)throw 0}).catch(()=>window.open(url,'_blank'))};
  const panel=document.getElementById('historyPanel'),head=panel&&panel.querySelector(':scope > .row');if(head)head.after(row);
  setInterval(()=>{try{const url=typeof state!=='undefined'&&state&&state.mode==='analysis'&&!document.body.classList.contains('hb-live')&&!(typeof editorDraft!=='undefined'&&editorDraft)?analysisLink(state):null;
   row.hidden=!url;if(url&&a.dataset.url!==url){a.dataset.url=url;a.href=url}}catch(e){}},700)}
 window.foulbroodOpenedResult=s=>{try{if(!opened||!opened.moves||!s)return '';const now=movesOf(s.review_game||s.game);return now===opened.moves||now.startsWith(opened.moves+';')||opened.moves.startsWith(now+';')?String(opened.result||''):''}catch(e){return ''}};
 const openGame=async(id,ply)=>{
  const g=await call('get',{id});
  const loads=[];
  if(g.review_text)loads.push({action:'review_load',text:g.review_text,filename:'history.pgn'});
  if(g.url&&/;InProgress;/.test(g.game||'')&&g.result&&g.result!=='In progress')loads.push({action:'load_link',url:g.url}); // the site's record carries the result
  loads.push({action:'load',text:g.game});
  rememberPlayers(g);
  wantPly=typeof ply==='number'?{moves:movesOf(g.game),ply,until:Date.now()+30000}:null; // go to this move once the game is on the board (also after a confirm dialog)
  const go=async confirmed=>{
   show(false);if(typeof enginePageOpen!=='undefined')enginePageOpen=false;L().setLive(false);
   await free();await action({action:'mode',mode:'analysis'});
   for(const payload of loads){
    await free();
    const done=await action(confirmed?{...payload,confirm_review_clear:true}:payload); // unconfirmed: the viewer asks by itself if Analysis holds a game
    if(done||document.getElementById('resignDialog').open)break;
   }
   // Straight to Game review once the game is on the board (also after the replace question is answered).
   const want=movesOf(g.game);let closedAt=0;
   for(let i=0;i<300;i++){
    const on=typeof state!=='undefined'&&state&&state.mode==='analysis'&&movesOf(state.review_game||state.game)===want;
    if(on&&!(typeof busy!=='undefined'&&busy)){if(!state.game_review)await action({action:'review_enter'});break}
    if(!document.getElementById('resignDialog').open){closedAt=closedAt||Date.now();if(Date.now()-closedAt>3000)break}else closedAt=0;
    await new Promise(r=>setTimeout(r,200));
   }
  };
  // Live may be holding the board with the Analysis game set aside: that set-aside game is what would be replaced.
  if(L().boardIsLive()){
   if(L().hasStash())L().ask('Replace game and history?','This will replace the current Analysis position and game history. Continue?','Open in Analysis',()=>{L().dropStash();go(true)});
   else{L().dropStash();go(true)}
  }else go(false);
 };

 // ---- automatic saving, driven by what the viewer shows ----
 const now=()=>{const d=new Date(),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`};
 const save=fields=>call('save',fields).then(()=>{if(open)refresh()}).catch(()=>{});
 let lastPlay='',lastImport='',lastLive='',lastReview='',reviewBusy=false;
 const outcome=s=>{
  const lost=s.resigned_side!=null?s.resigned_side:s.timeout_side;
  if(lost!=null)return (lost===0?'Black':'White')+' won'+(s.resigned_side!=null?' by resignation':' on time');
  return {WhiteWins:'White won',BlackWins:'Black won',Draw:'Draw','1-0':'White won','0-1':'Black won','1/2-1/2':'Draw'}[s.reported_result]||{WhiteWins:'White won',BlackWins:'Black won',Draw:'Draw'}[s.completed_state]||'In progress';
 };
 const observe=s=>{
  if(!s||!s.review_game)return;
  const names=s.player_names||[];
  if(s.mode==='play'&&s.play_finished&&s.review_game!==lastPlay){
   lastPlay=s.review_game;
   if((s.review_total||0)<2)return; // nothing worth keeping: the clock never started
   const who=i=>{const p=(s.players||[])[i];if(!p||p==='Human')return names[i]||'Human';const e=(s.engines||[]).find(x=>x.id===p);return e?e.name:String(p)};
   const kind=i=>((s.players||[])[i]==='Human'?'Human':'Engine');
   save({game:s.review_game,white:who(0),black:who(1),white_kind:kind(0),black_kind:kind(1),result:outcome(s),source:'Play',time_control:String(s.time_control||''),played:now()});
  }
  if(s.mode!=='analysis'||!s.review_total)return;
  if(L()&&L().boardIsLive()){
   // A bot game on the Live board: once it is over, keep the viewer's exact record of it.
   if(s.review_game!==lastLive&&!/^(InProgress|NotStarted)$/.test(s.completed_state||'')){lastLive=s.review_game;save({game:s.review_game})}
   return;
  }
  const importKey=(s.import_info||'')+'|'+s.review_total;
  if(s.import_info&&!/^Set-up position/.test(s.import_info)&&importKey!==lastImport&&s.ply===s.review_total){
   lastImport=importKey;
   save({game:s.review_game,white:names[0]||'',black:names[1]||'',result:outcome(s),source:'Imported',note:String(s.import_info).slice(0,150)});
  }
  const r=s.game_review,rows=r&&(r.rows||[]).length;
  if(rows&&r.status!=='running'&&!reviewBusy){
   const key=s.review_game+'|'+rows+'|'+r.status+'|'+(r.extras||[]).filter(e=>e.status==='ready').length; // engine lines and tried moves are saved too
   if(key!==lastReview){
    lastReview=key;reviewBusy=true;
    fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-Board-Token':window.BOARD_TOKEN},body:JSON.stringify({action:'review_save'})})
     .then(async res=>{const d=await res.json();if(res.ok&&d.text)await call('review',{game:s.review_game,text:d.text,reviewed:rows,total:r.total||s.review_total,engine:r.engine||''})})
     .catch(()=>{}).finally(()=>{reviewBusy=false;if(open)refresh()});
   }
  }
 };
 const earlier=window.renderBotThoughts;
 window.renderBotThoughts=s=>{if(earlier)earlier(s);try{observe(s)}catch(e){}try{showPlayers(s)}catch(e){}try{seekPly(s)}catch(e){}};
})();

// ---- Sound effects with the FoulBrood attitude (all generated here, no audio files) ----
window.foulbroodSfx=(()=>{
 const A=()=>typeof window.foulbroodAudio==='function'?window.foulbroodAudio():null;
 const noise=(ctx,seconds)=>{const b=ctx.createBuffer(1,Math.ceil(ctx.sampleRate*seconds),ctx.sampleRate),d=b.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;const n=ctx.createBufferSource();n.buffer=b;return n};
 const env=(ctx,out,t,points)=>{const g=ctx.createGain();g.gain.setValueAtTime(0.0001,t);for(const [dt,v] of points)g.gain.linearRampToValueAtTime(Math.max(0.0001,v),t+dt);g.connect(out);return g};
 // A buzzing bee: a sawtooth with a fast wing-beat tremolo, through a low-pass.
 const bee=(ctx,out,t,dur,from,to,level,beat=27)=>{
  const o=ctx.createOscillator(),lp=ctx.createBiquadFilter(),trem=ctx.createGain(),lfo=ctx.createOscillator(),depth=ctx.createGain();
  o.type='sawtooth';o.frequency.setValueAtTime(from,t);o.frequency.exponentialRampToValueAtTime(Math.max(20,to),t+dur);
  lp.type='lowpass';lp.frequency.value=1400;trem.gain.value=0.6;lfo.frequency.value=beat;depth.gain.value=0.4;
  lfo.connect(depth);depth.connect(trem.gain);o.connect(lp);lp.connect(trem);trem.connect(env(ctx,out,t,[[0.04,level],[dur*0.8,level],[dur,0]]));
  o.start(t);lfo.start(t);o.stop(t+dur+0.05);lfo.stop(t+dur+0.05);return trem;
 };
 const swarm=(ctx,out,t,dur,level,rise=1)=>{for(const [f,b] of [[150,23],[187,29],[221,26],[263,31],[305,24]])bee(ctx,out,t+Math.random()*0.05,dur,f,f*rise,level/3,b)};
 const splat=(ctx,out,t)=>{
  const n=noise(ctx,0.3),lp=ctx.createBiquadFilter();lp.type='lowpass';lp.frequency.setValueAtTime(2200,t);lp.frequency.exponentialRampToValueAtTime(180,t+0.22);
  n.connect(lp);lp.connect(env(ctx,out,t,[[0.005,0.5],[0.25,0]]));n.start(t);n.stop(t+0.3);
  const o=ctx.createOscillator();o.type='sine';o.frequency.setValueAtTime(110,t);o.frequency.exponentialRampToValueAtTime(38,t+0.2);o.connect(env(ctx,out,t,[[0.005,0.6],[0.24,0]]));o.start(t);o.stop(t+0.3);
 };
 const sfx={
  // Win: the swarm rises happily, the queen goes splat, then a bright major fanfare with a sparkle on top.
  win(){const a=A();if(!a)return false;const c=a.context,t=c.currentTime+0.02;swarm(c,a.out,t,0.6,0.13,1.9);splat(c,a.out,t+0.6);
   const note=(at,f,dur,level,type='triangle')=>{const o=c.createOscillator();o.type=type;o.frequency.setValueAtTime(f,t+at);o.connect(env(c,a.out,t+at,[[0.012,level],[dur*0.6,level*0.7],[dur,0]]));o.start(t+at);o.stop(t+at+dur+0.05)};
   for(const [at,f] of [[0.78,523.25],[0.9,659.25],[1.02,783.99]])note(at,f,0.16,0.22);
   note(1.14,1046.5,0.55,0.26);note(1.14,1318.5,0.55,0.12);note(1.14,1567.98,0.55,0.1); // the last chord rings out
   for(const [at,f] of [[1.3,2093],[1.38,2637],[1.46,3136]])note(at,f,0.12,0.05,'sine'); // sparkle
   return true},
  // Loss: one bee sputters, drops in pitch and dies.
  loss(){const a=A();if(!a)return false;const c=a.context,t=c.currentTime+0.02,g=c.createGain();g.connect(a.out);
   for(const [at,v] of [[0,1],[0.45,1],[0.5,0.15],[0.62,1],[0.9,1],[0.95,0.1],[1.02,0.9],[1.2,0.1],[1.27,0.7],[1.6,0]])g.gain.linearRampToValueAtTime(v,t+at);
   bee(c,g,t,1.65,230,48,0.2,25);return true},
  // Queen in danger: a low warning rattle.
  rattle(){const a=A();if(!a)return false;const c=a.context,t=c.currentTime+0.02,o=c.createOscillator(),am=c.createGain(),lfo=c.createOscillator(),d=c.createGain();
   o.type='square';o.frequency.value=58;am.gain.value=0.5;lfo.type='square';lfo.frequency.value=17;d.gain.value=0.5;lfo.connect(d);d.connect(am.gain);
   const lp=c.createBiquadFilter();lp.type='lowpass';lp.frequency.value=420;o.connect(lp);lp.connect(am);am.connect(env(c,a.out,t,[[0.02,0.13],[0.5,0.13],[0.62,0]]));
   o.start(t);lfo.start(t);o.stop(t+0.7);lfo.stop(t+0.7);return true},
  // A piece lands: a soft wooden tap; climbing onto the hive (beetle, mosquito as a beetle): a heavier double tap.
  tap(climb=false){const a=A();if(!a)return false;const c=a.context,t=c.currentTime+0.01;
   const hit=(at,freq,level)=>{const n=noise(c,0.06),bp=c.createBiquadFilter();bp.type='bandpass';bp.frequency.value=freq;bp.Q.value=4;n.connect(bp);bp.connect(env(c,a.out,t+at,[[0.002,level],[0.05,0]]));n.start(t+at);n.stop(t+at+0.06)};
   if(climb){hit(0,700,0.5);hit(0.07,1100,0.35)}else hit(0,1700,0.32);return true},
  // Someone challenges the bot by name: two knocks on wood.
  knock(){const a=A();if(!a)return false;const c=a.context,t=c.currentTime+0.01;
   for(const at of [0,0.16]){const n=noise(c,0.09),bp=c.createBiquadFilter();bp.type='bandpass';bp.frequency.value=420;bp.Q.value=3;n.connect(bp);bp.connect(env(c,a.out,t+at,[[0.003,0.7],[0.08,0]]));n.start(t+at);n.stop(t+at+0.09);
    const o=c.createOscillator();o.type='sine';o.frequency.setValueAtTime(160,t+at);o.frequency.exponentialRampToValueAtTime(90,t+at+0.07);o.connect(env(c,a.out,t+at,[[0.003,0.4],[0.08,0]]));o.start(t+at);o.stop(t+at+0.1)}return true},
  // A draw: two bees hold each other off at the same low pitch and neither wins: a level buzz, then two soft, even low notes.
  draw(){const a=A();if(!a)return false;const c=a.context,t=c.currentTime+0.02;
   bee(c,a.out,t,0.55,165,165,0.08,24);bee(c,a.out,t+0.03,0.55,168,168,0.08,26);
   for(const at of [0.62,0.9]){const o=c.createOscillator(),lp=c.createBiquadFilter();o.type='triangle';o.frequency.value=196;lp.type='lowpass';lp.frequency.value=600;o.connect(lp);lp.connect(env(c,a.out,t+at,[[0.02,0.2],[0.18,0.1],[0.26,0]]));o.start(t+at);o.stop(t+at+0.3)}
   return true},
  // Game start: a herald's trumpet call (ta-ta-ta-taaa), brass-like, with a fifth underneath.
  start(){const a=A();if(!a)return false;const c=a.context,t=c.currentTime+0.02;
   const brass=(at,f,dur,level)=>{const o=c.createOscillator(),o2=c.createOscillator(),lp=c.createBiquadFilter();o.type='sawtooth';o2.type='sawtooth';o.frequency.value=f;o2.frequency.value=f*1.003;
    lp.type='lowpass';lp.Q.value=2;lp.frequency.setValueAtTime(500,t+at);lp.frequency.linearRampToValueAtTime(2600,t+at+0.05);lp.frequency.linearRampToValueAtTime(1500,t+at+dur);
    o.connect(lp);o2.connect(lp);lp.connect(env(c,a.out,t+at,[[0.025,level],[dur*0.75,level*0.85],[dur,0]]));o.start(t+at);o2.start(t+at);o.stop(t+at+dur+0.05);o2.stop(t+at+dur+0.05)};
   for(const at of [0,0.14,0.28]){brass(at,523.25,0.11,0.09);brass(at,349.23,0.11,0.05)} // ta-ta-ta (C over F)
   brass(0.42,783.99,0.75,0.1);brass(0.42,523.25,0.75,0.06);brass(0.42,392,0.75,0.04); // taaa (G over C)
   return true},
  // Low on time: a heartbeat.
  thump(){const a=A();if(!a)return false;const c=a.context,t=c.currentTime+0.01;
   for(const [at,v] of [[0,0.5],[0.16,0.35]]){const o=c.createOscillator();o.type='sine';o.frequency.setValueAtTime(70,t+at);o.frequency.exponentialRampToValueAtTime(42,t+at+0.12);o.connect(env(c,a.out,t+at,[[0.008,v],[0.14,0]]));o.start(t+at);o.stop(t+at+0.18)}return true},
  // Game found: one sharp stinger note.
  stinger(){const a=A();if(!a)return false;const c=a.context,t=c.currentTime+0.01,o=c.createOscillator();o.type='sawtooth';o.frequency.setValueAtTime(1175,t);o.frequency.exponentialRampToValueAtTime(880,t+0.18);
   const hp=c.createBiquadFilter();hp.type='highpass';hp.frequency.value=500;o.connect(hp);hp.connect(env(c,a.out,t,[[0.004,0.2],[0.22,0]]));o.start(t);o.stop(t+0.25);return true},
  // Called by the viewer when a game ends on the board. true = handled here; false = play the usual chime.
  ending(result,s){
   if(result==='draw')return sfx.draw();
   if(result!=='win')return false;
   let won=true;
   if(s&&s.live_bot)won=s.bot_won!==false;
   else if(s&&Array.isArray(s.players)){const humans=s.players.map((p,i)=>p==='Human'?i:-1).filter(i=>i>=0);if(humans.length===1){const winner=(s.completed_state||'')==='WhiteWins'?0:1;won=winner===humans[0]}}
   return won?sfx.win():sfx.loss();
  },
 };
 // Triggers that are not game endings: watched from what the viewer shows.
 const around=[[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];
 let wasPlaying=false,lastSecond=null,liveId=null,landed={key:'',moves:0};
 const watch=s=>{
  if(!s)return;
  const L=window.foulbroodLive,card=L&&L.card?L.card():null,liveActive=!!(card&&!card.finished&&s.mode==='analysis');
  const playing=s.mode==='play'&&s.running&&!s.reviewing&&s.timeout_side==null&&s.resigned_side==null&&!/Wins|Draw/.test(s.completed_state||'');
  // game start / game found
  if(playing&&!wasPlaying&&!(s.review_total>0))sfx.start();
  wasPlaying=playing;
  if(card&&!card.finished&&card.id!==liveId){if(liveId!==null||(card.turn||0)<=1)sfx.stinger();liveId=card.id}else if(card&&liveId===null)liveId=card.id;
  // a piece lands on the board being played (Local or Online): a tap, heavier when it climbs onto the hive
  if((playing||liveActive)&&!s.reviewing&&s.last_move&&Array.isArray(s.pieces)){
   const moves=String(s.live_game||s.game||'').split(';').length,key=(liveActive?'live:'+card.id:'play')+'|'+String(s.live_game||s.game||'').split(';')[0];
   if(landed.key===key&&moves>landed.moves){const p=s.pieces.find(q=>q.id===s.last_move.piece);sfx.tap(!!(p&&(p.level||0)>0))}
   landed={key,moves};
  }
  // low on time: a heartbeat under the last ten seconds of a human's clock
  const side=s.live_side??s.side,seconds=playing&&(s.players||[])[side]==='Human'&&s.time_control!=='untimed'?(s.clocks||[])[side]:null;
  if(typeof seconds==='number'&&seconds>0&&seconds<=10){const whole=Math.ceil(seconds);if(lastSecond!==null&&whole<lastSecond)sfx.thump();lastSecond=whole}else lastSecond=null;
 };
 // Try-out buttons in the sound settings.
 const tryBox=document.getElementById('sfxTry');
 if(tryBox)for(const [label,name] of [['White chirp','whiteChirp'],['Black chirp','blackChirp'],['Win','win'],['Loss','loss'],['Draw','draw'],['Game start','start'],['Low time','thump'],['Game found','stinger'],['Piece lands','tap'],['Climbs','tapClimb'],['Challenge','knock'],['Long wait White','longWaitWhite'],['Long wait Black','longWaitBlack']]){
  const b=document.createElement('button');b.type='button';b.className='small';b.textContent=label;
  b.onclick=()=>{const played=name==='whiteChirp'||name==='blackChirp'?window.foulbroodChirp?.(name==='whiteChirp'?0:1):name==='tapClimb'?sfx.tap(true):name==='longWaitWhite'||name==='longWaitBlack'?window.foulbroodLongWait?.(name==='longWaitWhite'?0:1):sfx[name]();if(!played&&typeof toast==='function')toast('Turn sound on to hear it.')};tryBox.append(b);
 }
 const earlier=window.renderBotThoughts;
 window.renderBotThoughts=s=>{if(earlier)earlier(s);try{watch(s)}catch(e){}};
 return sfx;
})();

// ---- The FoulBrood look: board tag, targeting brackets and the game-over stamp ----
(()=>{
 const wrap=document.querySelector('.board-wrap');if(!wrap)return;
 const make=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls;if(text)e.textContent=text;return e};
 for(const c of ['tl','bl','br'])wrap.append(make('div','fb-corner '+c));
 const tag=make('div','fb-tag');tag.hidden=true;wrap.append(tag);
 const over=make('div','fb-over');over.hidden=true;over.setAttribute('role','status');
 const stamp=make('div','fb-stamp'),names=make('div','fb-names'),line=make('div','fb-line'),buttons=make('div','fb-buttons');
 const open=make('button','go','Open in Analysis'),bury=make('button','','Clear game'),close=make('button','','Close');
 buttons.append(open,bury,close);over.append(stamp,names,line,buttons);wrap.append(over);
 let dismissed='',shownKey='';
 const hide=()=>{dismissed=shownKey;over.hidden=true};
 close.onclick=hide;over.addEventListener('click',e=>{if(e.target===over)hide()});
 open.onclick=()=>{hide();const b=document.getElementById(document.body.classList.contains('hb-live')?'hbToAnalysis':'analyzePosition');if(b)b.click()};
 bury.onclick=()=>{hide();const b=document.getElementById('hbClear');if(b)b.click()};
 const around=[[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];
 const boxed=(s,id)=>{const taken=new Set((s.pieces||[]).map(p=>p.q+','+p.r)),q=(s.pieces||[]).find(p=>p.id===id);return !!q&&around.every(([dq,dr])=>taken.has((q.q+dq)+','+(q.r+dr)))};
 const span=(cls,text)=>{const e=document.createElement(cls==='i'?'i':'span');if(cls!=='i')e.className=cls;e.textContent=text;return e};
 const look=s=>{
  if(!s||over.dataset.demo)return; // data-demo: a preview is being shown
  const L=window.foulbroodLive,live=document.body.classList.contains('hb-live'),card=live&&L&&L.card?L.card():null;
  const play=s.mode==='play'&&!document.body.classList.contains('history-open');
  let state=null; // {key, moves, white, black, winner (0|1|null), how}
  if(play){
   const who=i=>{const p=(s.players||[])[i];if(!p||p==='Human')return (s.player_names||[])[i]||(i?'Black':'White');const e=(s.engines||[]).find(x=>x.id===p);return e?e.name:String(p)};
   const moves=s.review_total||0,base={key:'play|'+s.review_game,moves,white:who(0),black:who(1)};
   if(s.play_finished){
    if(s.resigned_side!=null)state={...base,winner:1-s.resigned_side,how:'resign'};
    else if(s.timeout_side!=null)state={...base,winner:1-s.timeout_side,how:'time'};
    else if(s.completed_state==='WhiteWins'||s.completed_state==='BlackWins')state={...base,winner:s.completed_state==='WhiteWins'?0:1,how:'queen'};
    else if(s.completed_state==='Draw')state={...base,winner:null,how:boxed(s,'wQ')&&boxed(s,'bQ')?'both':'repeat'};
   }else if(s.running)state={...base,progress:true,moves:(s.ply||0)+1};
  }else if(card&&s.mode==='analysis'){
   const base={key:'live|'+card.id,moves:card.turn||0,white:card.white||'White',black:card.black||'Black'};
   if(!card.finished)state={...base,progress:true,moves:(card.turn||0)+1};
   else if((s.review_total||0)<(card.turn||0))state={...base,progress:true,moves:(card.turn||0)}; // the result is in but the last move is not on the board yet: wait, so the stamp is right first time
   else if(card.result==='White won'||card.result==='Black won'){const winner=card.result==='White won'?0:1;const ended={Resigned:'resign',Timeout:'time'}[card.how];state={...base,winner,how:ended||(boxed(s,winner?'wQ':'bQ')?'queen':'other')}} // the site says how it ended: resignation and time-outs get their own stamp
   else if(card.result==='Draw')state={...base,winner:null,how:boxed(s,'wQ')&&boxed(s,'bQ')?'both':'repeat'};
  }
  // One message on the board, everywhere: the move being shown when stepped back, else the result, else the game in progress.
  const ply=s.ply||0,total=s.review_total??ply,br=document.getElementById('boardResult');
  let text='';
  if(typeof editorDraft!=='undefined'&&editorDraft)text='Arrange a position';
  else if(ply<total)text=`Move ${ply} of ${total}`;
  else if(br&&!br.hidden&&br.textContent)text=br.textContent+' · move '+total;
  else if(state&&!state.progress&&card&&card.result)text=card.result+' · move '+total;
  else if(state&&state.progress)text='In progress · move '+state.moves;
  else if(total)text=`Move ${ply} of ${total}`;
  tag.hidden=!text;if(text&&tag.textContent!==text)tag.textContent=text;
  if(!state||state.progress){over.hidden=true;return}
  const side=['White','Black'],w=state.winner,winName=w==null?'':[state.white,state.black][w],loseName=w==null?'':[state.white,state.black][1-w];
  shownKey=state.key;
  // stepping back through the moves takes the stamp away; it returns on the last move
  if((s.ply||0)<(s.review_total||0)){over.hidden=true;if(dismissed===state.key)dismissed='';return}
  if(dismissed===state.key){over.hidden=true;return}
  stamp.textContent={queen:'QUEEN DOWN',both:'QUEENS DOWN',repeat:'STANDOFF',resign:'SURRENDER',time:'OUT OF TIME',other:'FLATLINED'}[state.how];
  names.replaceChildren();
  if(w==null){const c=state.how==='both'?'lost':'plain';names.append(span(c,state.white),span('i',state.how==='both'?'and':'vs'),span(c,state.black))}
  else names.append(span('won',winName),span('i',state.how==='resign'?'broke':state.how==='time'?'outlasted':'killed'),span('lost',loseName));
  line.textContent={queen:`${side[w]} wins in ${state.moves} moves · one queen left standing`,other:`${side[w]} wins in ${state.moves} moves`,resign:`${side[1-(w??0)]} gave up on move ${state.moves}`,time:`${side[1-(w??0)]} ran out of time on move ${state.moves}`,both:`Draw in ${state.moves} moves · they took each other out`,repeat:`Draw by repetition in ${state.moves} moves · nobody blinked`}[state.how];
  bury.hidden=!live;over.hidden=false;
 };
 const earlier=window.renderBotThoughts;
 window.renderBotThoughts=s=>{if(earlier)earlier(s);try{look(s)}catch(e){}};
 setInterval(()=>{try{if(typeof state!=='undefined'&&state)look(state)}catch(e){}},1000);
})();

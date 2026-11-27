// Seconds left for an engine line or a tried move being graded (counted from when it was first seen running).
const reviewCountdownStart=new Map();
function reviewCountdown(e){const k=e.kind+'|'+e.ply+'|'+(e.move||'')+'|'+(e.expected||0);if(!reviewCountdownStart.has(k))reviewCountdownStart.set(k,Date.now());
 const left=Math.ceil((e.expected||0)-(Date.now()-reviewCountdownStart.get(k))/1000);return left>0?left+'s':'almost done'}
function reviewLineLength(){let n=4;try{n=parseInt(localStorage.getItem('foulbrood_line_length'),10)||4}catch(e){}return [4,6,8,12].includes(n)?n:4}
// Analysis workspaces share one board and history cursor.
// Analysis reopens where it was last left (Game review the first time).
function analysisWorkspace(w){try{if(w)localStorage.setItem('foulbrood_analysis_workspace',w);return localStorage.getItem('foulbrood_analysis_workspace')||'review'}catch(e){return w||'review'}}
$('modeAnalyze').onclick=()=>{analysisWorkspace('position');if(editorDraft)$('cancelSetup').click();if(state?.game_review)action({action:'review_exit'})};
$('modeSetup').onclick=async()=>{analysisWorkspace('arrange');if(state?.game_review)await action({action:'review_exit'});if(!editorDraft)openPositionSetup(false)};
$('analysisTab').onclick=async()=>{await action({action:'mode',mode:'analysis'});const want=analysisWorkspace();
 if(want==='review'&&state?.mode==='analysis'&&!state.game_review)await action({action:'review_enter'});
 else if(want!=='review'&&state?.game_review)await action({action:'review_exit'});
 if(want==='arrange'&&!editorDraft&&state?.mode==='analysis')openPositionSetup(false)};
$('inGameAnalysis').onchange=()=>action({action:'review_source',source:$('inGameAnalysis').checked?'in_game':'review'});
for(const [id,w] of [['cancelSetup','position'],['applySetup','position'],['startSetup','arrange'],['rearrangeSetup','arrange']])$(id)?.addEventListener('click',e=>{if(e.isTrusted)analysisWorkspace(w)}); // only the person's own clicks (leaving the page also closes Arrange)
$('modeReview').onclick=()=>{if(editorDraft)$('cancelSetup').click();analysisWorkspace('review');action({action:'review_enter'})};
function reviewPoint(score){return score==null?null:Math.abs(score)>99000?Math.sign(score)*100:Math.max(-99,Math.min(99,Math.round(100*Math.tanh(score/666))))}

const reviewMarksCache=new Map(),reviewMarksPending=new Set();
function engineChoiceOn(s){return highlightsOn(s||state)}
{const b=$('engineChoice');if(b){const sync=()=>b.setAttribute('aria-pressed',String(engineChoiceOn()));sync();
 b.onclick=()=>{setHighlights(!engineChoiceOn());sync();if(typeof lastBoardKey!=='undefined')lastBoardKey='';if(state)render(state)}}}
function renderReviewMarks(s){
 {const hb=$('engineChoice');if(hb){const v=String(engineChoiceOn(s));if(hb.getAttribute('aria-pressed')!==v)hb.setAttribute('aria-pressed',v)}} // this section's setting
 const board=$('board');board.querySelectorAll('.review-marks').forEach(e=>e.remove());
 if(window.reviewPreviewActive?.()){ // a tried move on the board carries its grade (or a waiting mark) on the piece itself
  const tried=window.reviewTriedShown?.(s),to=tried?.last_move?.to;if(!tried||!to)return;
  const [x,baseY]=xy(...to),height=Math.max(0,s.pieces.filter(p=>p.q===to[0]&&p.r===to[1]).length-1),y=baseY-height*10;
  const verdict=tried.status==='ready'?reviewTryGrade(s,tried):null,label=verdict?verdict.text:'…',width=Math.max(34,label.length*8.5+14);
  const badge=node('g',{class:'review-marks review-try-badge'+(verdict?'':' waiting'),'data-verdict':verdict?verdict.verdict:'',style:'cursor:pointer'});
  badge.addEventListener('pointerdown',e=>{e.stopPropagation();e.preventDefault();if(!verdict)return; // still being graded: leave it alone
   setReviewPreview(null);
   if(reviewTryOn&&reviewTryOn.ply===tried.ply){reviewTry={game:reviewTryOn.game,ply:tried.ply};setTimeout(()=>action({action:'navigate',ply:tried.ply-1}),0)}}); // ready for the next try // click the grade: the tried move and its result go away
  {const tip=node('title',{});tip.textContent='Click to take this tried move off the board';badge.append(tip)}
  badge.append(node('polygon',{points:hex(x,y,40),fill:'transparent',stroke:'none'})); // the whole piece is the click target, not just the number
  badge.append(node('rect',{x:x-width/2,y:y-12,width,height:24,rx:3}));
  const text=node('text',{x,y:y+5,'text-anchor':'middle'});text.textContent=label;badge.append(text);board.append(badge);
  return;
 }
 // The engine's choice for the move that led here (Local, Online, Position, Game review).
 if(!(s.ply>=1)||editorDraft)return; // shown whether or not the highlighter is on (the highlighter only fades the other pieces)
 const rowsKey=(s.game_review?.rows||[]).map(r=>r.ply+(r.alternative||'')).join(',')+'|'+(s.saved_review_rows||[]).length+'|'+(s.move_ratings||[]).map(r=>r[0]+':'+r[2]).join(',')+'|'+JSON.stringify(s.recorded_analysis||null).length;
 const key=s.game+'|'+s.ply+'|'+rowsKey;
 if(!reviewMarksCache.has(key)){
  if(reviewMarksPending.has(key))return;reviewMarksPending.add(key);
  fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-Board-Token':window.BOARD_TOKEN},body:JSON.stringify({action:'suggest_mark',game:s.game,ply:s.ply})}).then(async r=>{const data=await r.json();if(r.ok){reviewMarksCache.set(key,data.mark);if(reviewMarksCache.size>200)reviewMarksCache.delete(reviewMarksCache.keys().next().value);if(state?.game===s.game)renderReviewMarks(state)}}).catch(()=>{}).finally(()=>reviewMarksPending.delete(key));return;
 }
 const mark=reviewMarksCache.get(key);if(!mark)return;
 // Drawn like an Analysis suggestion: gold for White's moves, blue for Black's.
 const color=hintColor(mark.side??1-s.side);
 const layer=node('g',{class:'review-marks suggestion-trail','pointer-events':'none','aria-label':'Preferred move'}),[x,baseY]=xy(...mark.to);
 const height=mark.level??s.pieces.filter(p=>p.q===mark.to[0]&&p.r===mark.to[1]&&p.id!==mark.piece).length,y=baseY-height*10;
 if(mark.origin){
  const [sx,baseSY]=xy(...mark.origin),sy=baseSY-(mark.origin_level||0)*10,dx=x-sx,dy=y-sy,length=Math.hypot(dx,dy);
  layer.append(node('polygon',{points:hex(sx,sy,39),fill:color+'18',stroke:color,'stroke-width':3,'stroke-dasharray':'6 4'}));
  if(length>43){const ux=dx/length,uy=dy/length,ex=x-ux*42,ey=y-uy*42;
   layer.append(node('line',{x1:sx,y1:sy,x2:ex,y2:ey,stroke:color,'stroke-width':3,'stroke-linecap':'round'}));
   layer.append(node('polygon',{points:`${ex},${ey} ${ex-ux*10-uy*5},${ey-uy*10+ux*5} ${ex-ux*10+uy*5},${ey-uy*10-ux*5}`,fill:color}));
  }
 }
 const to=s.last_move?.to,sameSpot=!!to&&to[0]===mark.to[0]&&to[1]===mark.to[1];
 if(sameSpot){ // the engine wanted a different bug on the very spot that was played (always so on the first move): a small badge, so the real piece stays clear
  const bx=x+27,by=y-25,badge=node('g',{});
  badge.append(node('polygon',{points:hex(bx,by,19),fill:'var(--paper,#fbfaf6)',stroke:color,'stroke-width':3}));
  const mini=node('g',{transform:`translate(${bx},${by}) scale(.42) translate(${-bx},${-by})`});mini.append(artwork(mark.piece,bx,by));badge.append(mini);
  layer.append(badge);board.append(layer);return;
 }
 const ghost=node('g',{opacity:.6});ghost.append(artwork(mark.piece,x,y));layer.append(ghost);
 layer.append(node('polygon',{points:hex(x,y,40),fill:'none',stroke:color,'stroke-width':4}));board.append(layer);
}

window.renderGameReview=s=>{
 const review=s.game_review,active=!!review,editing=!!editorDraft;
 $('analysisModes').hidden=s.mode!=='analysis';$('startSetup').hidden=true;
 for(const [id,on]of [['modeAnalyze',!active&&!editing],['modeSetup',editing],['modeReview',active]])$(id).setAttribute('aria-pressed',String(on));
 renderReviewMarks(s);
 $('reviewPanel').hidden=!active;
 $('inGameAnalysisChoice').hidden=!active||!review.recorded_count;
 $('inGameAnalysis').checked=review?.source==='in_game';$('inGameAnalysis').disabled=review?.status==='running';
 $('reviewFileActions').hidden=s.mode!=='analysis'||editing;


 $('analysisImportHeader').querySelector('h2').textContent=active?'Explore a game':'Explore a position';
 const singles=!!active&&(review.single_working!=null||(review.single_queue||[]).length>0||!!review.side_busy); // moves clicked for review, a tried move or engine line being worked out
 $('analyze').textContent=active?(review.status==='running'||singles?'Stop review':review.can_resume?'Resume review':reviewDone(review)?'Review again':'Start review'):(s.showing_player_thought?'Thinking…':s.insight_job==='hint'?'Stop':'Analyze');
 $('analyze').onclick=active?()=>{const r=state?.game_review;const stop=r?.status==='running'||r?.single_working!=null||(r?.single_queue||[]).length||r?.side_busy;if(stop)reviewSingleWant=null;action({action:stop?'review_stop':'review_start'})}:toggleAnalysis;
 $('stopAnalysis').textContent=active?'Stop review':'Stop analysis';$('stopAnalysis').onclick=()=>action({action:active?'review_stop':'stop_analysis'});
 if(!active)return;
 $('analysisSetup').hidden=false;$('historyPanel').hidden=false;
 $('analyze').disabled=!review.total;$('stopAnalysis').hidden=true;
 $('hintsLabel').hidden=true;$('bookEnabled').closest('label').hidden=true;$('calculateInstead').hidden=true;
 $('reviewProgress').textContent=review.source==='in_game'?`${review.recorded_count} positions with in-game analysis`:review.resume_engine_missing?`Saved results loaded. Connect ${review.engine} to continue reviewing.`:review.error||(!review.total?'Import a game to get started.':review.status==='running'?(review.working_ply&&review.total?`Move ${Math.min(review.working_ply,review.total)} of ${review.total}`:'Starting review…'):review.status==='complete'?`${review.total} moves reviewed`:review.status==='stopped'?`Stopped · ${reviewDone(review)} of ${review.total} reviewed`:`${review.total} moves`);
 const remaining=review.status==='ready'||review.status==='complete'?(review.status==='complete'?0:(2*review.total+1)*s.analysis_ms/1000):review.remaining_seconds;
 $('reviewRemaining').hidden=!review.total||review.source==='in_game';$('reviewProgressBar').hidden=review.source==='in_game';
 const minutes=Math.max(1,Math.ceil(remaining/60));
 $('reviewRemaining').textContent=review.status==='complete'?'Review complete':review.status==='stopped'?'':`Up to about ${minutes} ${minutes===1?'minute':'minutes'} remaining`;
 $('reviewProgress').classList.toggle('search-activity',review.status==='running');
 $('reviewProgressBar').max=Math.max(1,review.total);$('reviewProgressBar').value=reviewDone(review);
 $('turn').hidden=true;
};
// Restore controls after leaving review; the normal render controls their state.
const renderReview=window.renderGameReview;
// Game review in the History list: each move takes the colour of its verdict (as in the status bar) and shows the position rating after it.
const historyVerdicts={'Best move':'good','Book move':'good','No clear error':'good','Inaccuracy':'mid','Uncertain':'mid','Mistake':'poor','Blunder':'bad','Missed win':'bad'};
let reviewWasRunning=null;
function historyEnding(s){
 if(!s||editorDraft)return '';
 const side=['White','Black'],won=w=>side[w]+' won',board=(s.review_game||s.game||'').split(';')[1];
 if(s.resigned_side!=null)return `${won(1-s.resigned_side)} · ${side[s.resigned_side]} resigned`;
 if(s.timeout_side!=null)return `${won(1-s.timeout_side)} · ${side[s.timeout_side]} ran out of time`;
 const final=s.mode==='play'?(s.play_finished?s.completed_state:null):board;
 if(final==='WhiteWins'||final==='BlackWins')return `${won(final==='WhiteWins'?0:1)} · queen surrounded`;
 if(final==='Draw')return 'Draw';
 if(s.mode==='play')return '';
 const reported={WhiteWins:0,BlackWins:1,'1-0':0,'0-1':1}[s.reported_result];
 if(reported!=null){ // the board itself is not over: someone resigned or ran out of time
  let how='';try{const L=window.foulbroodLive,c=document.body.classList.contains('hb-live')&&L&&L.card?L.card():null;if(c&&c.finished)how={Resigned:'resigned',Timeout:'ran out of time'}[c.how]||''}catch(e){}
  if(!how){const saved=window.foulbroodOpenedResult?window.foulbroodOpenedResult(s):'';how=/by resignation/.test(saved)?'resigned':/on time/.test(saved)?'ran out of time':''}
  return `${won(reported)} · ${side[1-reported]} ${how||'resigned or ran out of time'}`;
 }
 if(s.reported_result==='Draw'||s.reported_result==='1/2-1/2')return 'Draw';
 return '';
}
// The review's progress and summary sit at the top of the History box (the separate bar under the board is retired).
const reviewInfo=(()=>{const box=document.createElement('div');box.id='reviewInfo';box.className='review-panel';box.hidden=true;
 for(const id of ['reviewProgress','reviewRemaining','reviewProgressBar']){const e=$(id);if(e)box.append(e)}
 // Start / stop sits beside the progress line; it presses the same button as the Engine insight box.
 const line=document.createElement('div'),go=document.createElement('button');line.className='review-info-line';go.id='reviewGo';go.type='button';go.className='primary small';
 go.onclick=()=>{const b=$('analyze');if(b&&!b.disabled)b.click()};
 const first=box.querySelector('#reviewProgress'),rest=box.querySelector('#reviewRemaining');if(first){const text=document.createElement('div');text.className='review-info-text';box.prepend(line);text.append(first);if(rest)text.append(rest);line.append(text,go)}
 const panel=$('historyPanel'),head=panel?.querySelector(':scope > .row');const under=$('histExport')||head;if(under)under.after(box);return box})();
// ---- What the review adds up to: per-player summary, opening and book exit, and the turning point ----
const reviewScale=x=>Math.abs(x)>99000?Math.sign(x)*100:Math.max(-99,Math.min(99,100*Math.tanh(x/600)));
function reviewRowLoss(row){ // how much the played move gave up, mover's side, on the grading scale (0..200)
 if(!row||row.score==null||row.best_score==null||row.label==='Book move'||row.label==='Best move')return 0;
 const sign=row.side===0?1:-1;return Math.max(0,reviewScale(row.best_score*sign)-reviewScale(row.score*sign));
}
function reviewOpening(game){ // the first three bugs each side put down, e.g. "PAQ vs GBQ"
 const moves=String(game||'').split(';').slice(3),root=String(game||'').split(';')[0];if(root.includes('~')||moves.length<2)return '';
 const bugs=[[],[]];moves.slice(0,6).forEach((m,i)=>{const piece=m.trim().split(' ')[0]||'';bugs[i%2].push(piece.replace(/^[wb]/,'').replace(/\d/,'')||'–')});
 return bugs[0].join('')+' vs '+bugs[1].join('');
}
// Until a review is run, a bot game shows what the bot itself rated each of its moves while playing ("In-game").
function reviewInGameRows(s){
 const data=s?.game_review&&window.foulbroodOpenedEvals?window.foulbroodOpenedEvals(s):null;if(!data)return [];
 const moves=(s.review_game||s.game).split(';').slice(3),real=new Set((s.game_review.rows||[]).map(r=>r.ply)),sign=data.side===0?1:-1,out=[];
 for(const [turn,v]of Object.entries(data.evals)){const ply=+turn+1;if(+turn%2!==data.side||ply>moves.length||real.has(ply)||!Array.isArray(v))continue;
  out.push({ply,side:data.side,move:moves[ply-1],score:v[1]*sign,depth:v[0],label:'In-game',symbol:'',best_score:null,alternative:null,ingame:true,by:data.bot})}
 return out.sort((a,b)=>a.ply-b.ply);
}
window.reviewInGameRow=(s,side)=>reviewInGameRows(s).find(r=>r.ply===s.ply&&r.side===side)||null;
function reviewTurningPoint(s){ // the move where the loser's position dropped the most and never came back
 const review=s?.game_review,rows=[...reviewInGameRows(s),...(review?.rows||[])].filter(r=>r.score!=null).sort((a,b)=>a.ply-b.ply);if(rows.length<4)return null;
 const board=(s.review_game||s.game||'').split(';')[1],reported={WhiteWins:0,BlackWins:1,'1-0':0,'0-1':1}[s.reported_result];
 const winner=s.resigned_side!=null?1-s.resigned_side:s.timeout_side!=null?1-s.timeout_side:board==='WhiteWins'?0:board==='BlackWins'?1:reported!=null?reported:null;
 const sign=winner===0?-1:1; // the loser's side of the bar (White's when there is no winner)
 const value=r=>sign*reviewScale(r.score);
 let best=null;
 for(let i=1;i<rows.length;i++){
  const drop=winner==null?Math.abs(value(rows[i-1])-value(rows[i])):value(rows[i-1])-value(rows[i]);if(drop<10)continue;
  const never=winner!=null&&value(rows[i-1])>-25&&rows.slice(i).every(r=>value(r)<=-25); // playable before, clearly worse ever after
  const weight=drop+(never?1000:0);
  if(!best||weight>best.weight)best={ply:rows[i].ply,drop,weight,side:rows[i].side};
 }
 return best;
}
function renderReviewFacts(s){
 const box=reviewFacts,review=s?.game_review,rows=review?.rows||[];
 const ingame=reviewInGameRows(s);
 const show=!!review&&!editorDraft&&(rows.length>0||ingame.length>0);box.hidden=!show;if(!show){box.dataset.key='';return null}
 const turn=reviewTurningPoint(s),names=s.player_names||[];
 const sides=[0,1].map(side=>{const own=rows.filter(r=>r.side===side&&r.label!=='Book move'&&r.score!=null&&r.best_score!=null),count=l=>rows.filter(r=>r.side===side&&l.includes(r.label)).length;
  const mean=own.length?own.reduce((t,r)=>t+Math.min(50,reviewRowLoss(r)),0)/own.length:null;
  return {side,accuracy:mean==null?null:Math.max(0,Math.round(100-2*mean)),slips:count(['Inaccuracy']),mistakes:count(['Mistake']),blunders:count(['Blunder','Missed win'])}});
 const lastBook=rows.filter(r=>r.label==='Book move').reduce((m,r)=>Math.max(m,r.ply),0),opening=reviewOpening(s.review_game||s.game);
 const turnBusy=!!turn&&!!review&&!(review.rows||[]).some(r=>r.ply===turn.ply)&&(review.single_working===turn.ply||(review.single_queue||[]).includes(turn.ply));
 const key=JSON.stringify([sides,lastBook,opening,turn&&turn.ply,names,s.ply===(turn&&turn.ply),rows.length,ingame.length&&ingame[0].by,turnBusy]);
 if(box.dataset.key!==key){box.dataset.key=key;box.replaceChildren();
  for(const side of rows.length?sides:[]){const line=document.createElement('p');line.className='review-fact';const who=document.createElement('b');who.textContent=side.side===0?'White':'Black';
   const bits=[side.accuracy==null?'—':side.accuracy+'%'];if(side.slips)bits.push(side.slips+' inaccurac'+(side.slips===1?'y':'ies'));if(side.mistakes)bits.push(side.mistakes+' mistake'+(side.mistakes===1?'':'s'));if(side.blunders)bits.push(side.blunders+' blunder'+(side.blunders===1?'':'s'));
   line.append(who,' '+bits.join(' · '));line.title='Accuracy: 100% means every move matched the engine\'s choice or cost nothing.';box.append(line)}
  if(opening||lastBook){const line=document.createElement('p');line.className='review-fact muted';line.textContent=[opening?'Opening '+opening:'',lastBook?'book to move '+lastBook:''].filter(Boolean).join(' · ');line.title='The first three bugs each side placed (White vs Black)';box.append(line)}
  if(turn){const go=document.createElement('button');go.type='button';go.id='reviewTurn';go.className='small';go.textContent=turnBusy?'Reviewing move '+turn.ply+'…':'Turning point · move '+turn.ply;if(turnBusy)go.classList.add('reviewing');go.title='Where the position swung the most and never came back';go.onclick=()=>action({action:'navigate',ply:turn.ply});if(s.ply===turn.ply)go.setAttribute('aria-pressed','true');box.append(go)}
 }
 return turn;
}
// In Game review the History box is the whole workspace: it is titled "Game review" and carries the engine and
// thinking-time choices at its top; the Explore a game and Engine insight boxes are put away until Position is chosen.
const reviewSettingsBox=(()=>{const d=document.createElement('div');d.id='reviewSettings';d.hidden=true;reviewInfo.before(d);return d})();
const reviewFacts=(()=>{const d=document.createElement('div');d.id='reviewFacts';d.hidden=true;reviewInfo.after(d);return d})();
// ---- The engine's line, and trying a different move ----
// Both run one extra search on the server (action review_side) and come back in game_review.extras.
const reviewExtraBox=(()=>{const d=document.createElement('div');d.id='reviewExtra';d.hidden=true;reviewFacts.after(d);return d})();
let reviewPreview=null,reviewTry=null,reviewTryShow=null;const reviewTryDismissed=new Set();const reviewLineHidden=new Set(),reviewTriedKept=new Map();let reviewTryOn=null; // kept: 'game|ply' -> graded tries, listed until cleared // {game,ply}: Try a move stays on for this turn until its button is pressed again // preview: {game,ply,pieces,last_move,key}; try: {game,ply}
window.reviewPreviewActive=()=>!!reviewPreview;
{ // Draw a previewed position (a step of the engine's line, or the tried move) in place of the real one, without touching the game.
 const realRender=render;
 render=function(s){
  // A state that was drawn with a preview carries the real position along, so clearing the preview puts it straight back.
  if(s&&s.previewReal){const real=s.previewReal;s={...s,...real};delete s.previewReal}
  if(reviewPreview&&s&&s.game_review&&s.ply===reviewPreview.ply&&(s.review_game||s.game)===reviewPreview.game)s={...s,previewReal:{pieces:s.pieces,last_move:s.last_move,hint:s.hint},pieces:reviewPreview.pieces,last_move:reviewPreview.last_move||null,hint:null};
  else if(reviewPreview){reviewPreview=null;lastBoardKey=''}
  return realRender(s);
 };
 // While "Try a move" is on, the board accepts one move for the side to play, and that move is graded instead of played.
 const trying=()=>!!reviewTry&&!!state&&!!state.game_review&&state.game_review.status!=='running'&&!editorDraft&&state.ply===reviewTry.ply-1&&(state.review_game||state.game)===reviewTry.game;
 const realCanMove=canMove,realPlay=play;
 // Normally a move dropped on the board waits for a second click to confirm it (and is dropped if the window loses focus).
 // A tried move is graded, not played, so it goes in as soon as it is dropped.
 const realStage=stageMove;
 stageMove=function(m,suggestion=false){
  if(trying()&&!suggestion&&m&&m.to&&state.legal.some(x=>x.move===m.move)){selected=null;pieceDrag=null;try{removeDragGhost()}catch(e){}lastBoardKey='';renderBoard();play(m.move);return}
  return realStage(m,suggestion);
 };
 canMove=function(){return trying()||realCanMove()};
 play=function(move){
  if(!trying())return realPlay(move);
  const ply=reviewTry.ply,game=reviewTry.game;
  // Already graded: show it again straight away instead of grading it a second time.
  const known=(reviewTriedKept.get(game+'|'+ply)||[]).find(e=>e.move===move&&e.status==='ready'&&e.pieces);
  if(known){reviewTry=null;reviewTryDismissed.delete(ply+'|'+move);(async()=>{await action({action:'navigate',ply});setReviewPreview({game,ply,pieces:known.pieces,last_move:known.last_move,key:'try'+ply+'|'+move})})();return}
  reviewTry=null;reviewTryShow=ply;reviewTryDismissed.delete(ply+'|'+move); // once the server has the position, keep the tried move on the board
  (async()=>{
   // Wait for any move still being reviewed on its own, then grade; if grading could not start, stay ready to try again.
   for(let i=0;i<240&&(state?.game_review?.single_working||(state?.game_review?.single_queue||[]).length);i++)await new Promise(r=>setTimeout(r,500));
   for(let i=0;i<40&&busy;i++)await new Promise(r=>setTimeout(r,50));
   const ok=await action({action:'review_side',kind:'try',ply,move});
   if(!ok){reviewTry={game,ply};reviewTryShow=null;lastBoardKey='';render(serverState||state);return}
   for(let i=0;i<20&&busy;i++)await new Promise(r=>setTimeout(r,50));await action({action:'navigate',ply})})();
 };
}
// The tried move currently shown on the board (if the preview is of a tried move), and its grade.
window.reviewTriedShown=s=>{if(!reviewPreview||!/^try/.test(reviewPreview.key)||!s?.game_review)return null;const k=reviewPreview.key;
 return (reviewTriedKept.get((s.review_game||s.game)+'|'+s.ply)||[]).find(e=>'try'+e.ply+'|'+e.move===k)||(s.game_review.extras||[]).find(e=>e.kind==='try'&&'try'+e.ply+'|'+e.move===k)||null};
function reviewTryGrade(s,tried){
 const row=(s.game_review.rows||[]).find(r=>r.ply===tried.ply);if(!row)return null;
 const sign=row.side===0?1:-1,best=row.best_score!=null?row.best_score:row.score;
 const grade=tried.score==null||best==null?['Uncertain','']:(tried.move===row.alternative?['Best move','']:gradeReviewMove(best*sign,tried.score*sign,row.best_depth,tried.depth));
 const rating=tried.score==null?null:reviewPoint(tried.score),name=({'No clear error':'Fine','Uncertain':'Unclear','Best move':'Best'}[grade[0]]||grade[0]);
 return {name,rating,verdict:historyVerdicts[grade[0]]||'',text:rating==null?name:(rating>0?'+':'')+rating};
}
// A tried move on the board: a click anywhere on the board, or reaching for a bug, takes it off (and, while Try a move is on,
// goes back to the position to try from). Nothing happens while it is still being graded.
document.addEventListener('pointerdown',e=>{
 if(!reviewPreview||!/^try/.test(reviewPreview.key)||!e.target.closest||!e.target.closest('#board,.reserve'))return;
 e.stopPropagation();e.preventDefault();
 const shown=window.reviewTriedShown(state);if(shown&&shown.status==='running')return;
 const ply=reviewPreview.ply,piece=shown?.last_move?.piece;
 // Pressing on the tried piece itself picks it up again: its grade goes and it can be dropped somewhere else.
 const onTried=!!piece&&e.button===0&&(!!e.target.closest('.review-try-badge')||e.target.closest('.tile')?.dataset.piece===piece);
 setReviewPreview(null);
 if(reviewTryOn&&reviewTryOn.ply===ply){reviewTry={game:reviewTryOn.game,ply};
  let held=null;
  if(onTried){held={id:piece,pointer:e.pointerId,x:e.clientX,y:e.clientY,moved:false,game:null,wasSelected:true};
   document.addEventListener('pointerup',u=>{if(u.pointerId===held.pointer)held.released=true},{capture:true,once:true})}
  setTimeout(async()=>{await action({action:'navigate',ply:ply-1});
   // The board has gone back to the position to try from: the piece is still in hand while the button is held.
   if(held&&!held.released&&canMove()){held.game=state.game;pieceDrag=held;selected=piece;lastBoardKey='';renderBoard()}},0)}
},true);
function setReviewPreview(next){reviewPreview=next;lastBoardKey='';
 // Make sure the previewed move is in view: refit the board when it falls outside the current frame (and when the preview is cleared after that).
 try{autoFitKey=null;const to=next&&next.last_move&&next.last_move.to;if(to&&boardFrame){const [px,py]=xy(...to);if(Math.abs(px-boardFrame.x)>boardFrame.w/2-45||Math.abs(py-boardFrame.y)>boardFrame.h/2-45){boardFrame=null;boardZoom=1;panX=panY=0;setReviewPreview.refit=true}}else if(!next&&setReviewPreview.refit){boardFrame=null;boardZoom=1;panX=panY=0;setReviewPreview.refit=false}}catch(e){}
 if(typeof serverState!=='undefined'&&(serverState||state))render(serverState||state)}
function renderReviewExtra(s){
 const box=reviewExtraBox,review=s?.game_review;
 if(reviewTry&&(!review||(s.review_game||s.game)!==reviewTry.game||(s.ply!==reviewTry.ply-1&&s.ply!==reviewTry.ply)))reviewTry=null;
 if(reviewTryOn&&(!review||(s.review_game||s.game)!==reviewTryOn.game||(s.ply!==reviewTryOn.ply-1&&s.ply!==reviewTryOn.ply)))reviewTryOn=null; // moved on to another move: trying ends
 const ply=reviewTry?reviewTry.ply:reviewTryOn?reviewTryOn.ply:s?.ply,total=(s?.review_game||s?.game||'').split(';').length-3;
 // A move the review has not reached yet still offers both: the move is reviewed on its own first.
 const row=review?(review.rows||[]).find(r=>r.ply===ply)||(s.mode==='analysis'&&ply>=1&&ply<=total?{ply,side:s.ply===ply?1-s.side:s.side,label:'',pending:true}:null):null;
 const usable=!!row&&row.label!=='Book move'&&!editorDraft&&review.source!=='in_game';
 box.hidden=!usable;if(!usable){box.dataset.key='';document.body.classList.remove('review-grading');return}
 const extras=review.extras||[],lineFound=extras.find(e=>e.kind==='line'&&e.ply===ply),line=lineFound&&!reviewLineHidden.has(ply)?lineFound:null,found=extras.filter(e=>e.kind==='try'&&e.ply===ply).sort((a,b)=>(b.seq||0)-(a.seq||0))[0],tried=found&&!reviewTryDismissed.has(found.ply+'|'+found.move)?found:null,game=s.review_game||s.game;
 // Every graded try stays listed (and is kept with the review in the Archive) until its x is pressed.
 const kept=extras.filter(e=>e.kind==='try'&&e.ply===ply&&e.status==='ready'&&!reviewTryDismissed.has(e.ply+'|'+e.move)).sort((a,b)=>(a.seq||0)-(b.seq||0));reviewTriedKept.set(game+'|'+ply,kept);
 const tryKey=tried?'try'+ply+'|'+tried.move:'';
 // A move just tried stays on the board (pulsing while it is graded) until the chip is clicked or another move is chosen.
 if(reviewTryShow===ply&&tried&&tried.pieces&&s.ply===ply){reviewTryShow=null;const shown={game,ply,pieces:tried.pieces,last_move:tried.last_move,key:tryKey};setTimeout(()=>setReviewPreview(shown),0)}
 document.body.classList.toggle('review-grading',!!tried&&tried.status==='running'&&!!reviewPreview&&reviewPreview.key===tryKey);
 const key=JSON.stringify([line&&line.status==='running'?reviewCountdown(line):0,tried&&tried.status==='running'?reviewCountdown(tried):0,ply,line&&[line.status,line.moves,line.error],tried&&[tried.status,tried.move,tried.score,tried.depth,tried.error],reviewPreview&&reviewPreview.key,!!reviewTry,!!reviewTryOn,reviewLineHidden.has(ply),tried&&!!tried.pieces,kept.map(e=>e.move+e.score),row.best_score,row.side]);
 if(box.dataset.key===key)return;box.dataset.key=key;box.replaceChildren();
 const text=m=>{try{return shownMove(m)}catch(e){return m}};
 const button=(label,title,click,pressed)=>{const b=document.createElement('button');b.type='button';b.className='small';b.textContent=label;if(title)b.title=title;b.onclick=click;if(pressed)b.setAttribute('aria-pressed','true');return b};
 const controls=document.createElement('div');controls.className='review-extra-row';
 // Either button pauses a running review first (the engine can only do one thing at a time).
 const pause=async()=>{if(state?.game_review?.status==='running'){await action({action:'review_stop'});for(let i=0;i<40&&busy;i++)await new Promise(r=>setTimeout(r,50))}
  for(let i=0;i<240&&(state?.game_review?.single_working||(state?.game_review?.single_queue||[]).length);i++)await new Promise(r=>setTimeout(r,500))}; // a move being reviewed on its own finishes first
 // Engine line: one button that stays put and shows or hides the line in the move list.
 {const shown=!!line&&line.status!=='error';
  controls.append(button('Engine line',shown?'Hide the engine line':'Show the moves the engine expected after its preferred move',()=>{
   if(shown){reviewLineHidden.add(ply);if(reviewPreview&&/^line/.test(reviewPreview.key))setReviewPreview(null)}
   else if(lineFound&&lineFound.status==='ready')reviewLineHidden.delete(ply);
   else{reviewLineHidden.delete(ply);pause().then(()=>action({action:'review_side',kind:'line',ply,length:reviewLineLength()}));return}
   box.dataset.key='';renderReviewExtra(state);renderHistoryLine(state,$('moves'))},shown))}
 // How many moves the engine line runs; changing it finds the line again at the new length.
 {const pick=document.createElement('select');pick.className='review-line-length';pick.title='How many moves the engine line shows';pick.setAttribute('aria-label','Engine line length');
  for(const n of [4,6,8,12]){const o=document.createElement('option');o.value=n;o.textContent=n+' moves';pick.append(o)}pick.value=String(reviewLineLength());
  pick.onchange=async()=>{try{localStorage.setItem('foulbrood_line_length',pick.value)}catch(e){}
   if(lineFound&&lineFound.status!=='running'&&!reviewLineHidden.has(ply)){await pause();action({action:'review_side',kind:'line',ply,length:+pick.value})}};
  controls.append(pick)}
 controls.append(reviewTry||reviewTryOn?button('Stop trying','Leave Try a move',async()=>{const back=(reviewTry||reviewTryOn).ply,grading=found&&found.status==='running';reviewTry=null;reviewTryOn=null;reviewTryShow=null;
   if(grading)reviewTryDismissed.add(found.ply+'|'+found.move); // stopped in the middle of thinking: no result for that move
   if(reviewPreview)setReviewPreview(null);
   if(grading){await action({action:'review_stop'});for(let i=0;i<20&&busy;i++)await new Promise(r=>setTimeout(r,50))}
   action({action:'navigate',ply:back})},true)
  :button('Try a move','Play different moves for this turn on the board and have each one graded',async()=>{await pause();if(reviewPreview)setReviewPreview(null);reviewTry={game,ply};reviewTryOn={game,ply};await action({action:'navigate',ply:ply-1})}));
 box.append(controls);
 const note=t=>{const p=document.createElement('p');p.className='review-fact muted';p.textContent=t;box.append(p)};
 if(reviewTry)note(`Move a ${row.side===0?'White':'Black'} bug on the board to grade it.`);
 if(line&&line.status==='running')note('Finding engine line · '+reviewCountdown(line));
 if(line&&line.status==='error')note(line.error||'The engine line is not available.');
 if(tried&&tried.status==='running'&&!reviewTry)note(`Grading ${text(tried.move)} · `+reviewCountdown(tried));
 if(tried&&tried.status==='error'&&!reviewTry)note(tried.error||'That move could not be graded.');
 if(kept.length){
  const title=document.createElement('span');title.className='review-line-label review-line-title';title.textContent='Tried';box.append(title);
  for(const e of kept){
   const g=reviewTryGrade(s,e)||{name:'Unclear',rating:null,verdict:''},k='try'+ply+'|'+e.move,on=reviewPreview&&reviewPreview.key===k;
   const line=document.createElement('div');line.className='review-line review-tried';
   line.append(button(text(e.move),'Show the board after this move you tried',()=>{if(!e.pieces)return;setReviewPreview(on?null:{game,ply,pieces:e.pieces,last_move:e.last_move,key:k})},on));
   const verdict=document.createElement('span');verdict.className='review-try-verdict';verdict.dataset.verdict=g.verdict;verdict.textContent=g.name+(g.rating==null?'':' · '+(g.rating>0?'+':'')+g.rating);line.append(verdict);
   const x=document.createElement('button');x.type='button';x.className='review-line-clear';x.textContent='×';x.title='Clear this tried move';x.setAttribute('aria-label','Clear this tried move');
   x.onclick=()=>{kept.splice(kept.indexOf(e),1);reviewTryDismissed.add(ply+'|'+e.move);fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-Board-Token':window.BOARD_TOKEN},body:JSON.stringify({action:'review_try_forget',ply,move:e.move})}).then(()=>reviewTryDismissed.delete(ply+'|'+e.move)).catch(()=>{});if(reviewPreview&&reviewPreview.key===k)setReviewPreview(null);box.dataset.key='';renderReviewExtra(state)};line.append(x);
   box.append(line);
  }
 }
}
const reviewMoved=[];let reviewSettingsOn=false;
function reviewSettings(on){
 if(on===reviewSettingsOn)return;reviewSettingsOn=on;
 document.body.classList.toggle('review-mode',on);reviewSettingsBox.hidden=!on;
 const title=$('historyPanel')?.querySelector(':scope > .row > h2');if(title)title.textContent=on?'Game review':'History';
 {const panel=$('historyPanel');if(panel){if(on){reviewSettings.wasFolded=panel.classList.contains('hb-folded');panel.classList.remove('hb-folded')}else if(reviewSettings.wasFolded)panel.classList.add('hb-folded')}} // the only box on the page cannot be folded away
 if(on){
  for(const node of [$('insightEngineChoice'),$('analysisTime')?.closest('label')]){if(!node)continue;reviewMoved.push([node,node.parentNode,node.nextSibling]);reviewSettingsBox.append(node)}
 }else{
  for(const [node,parent,next]of reviewMoved.splice(0).reverse())parent.insertBefore(node,next&&next.parentNode===parent?next:null);
 }
}
function playedRatings(s){
 const out=new Map();if(!s||s.game_review)return out;
 const live=window.foulbroodLiveEvals?.(s);
 if(live){const sign=live.side===0?1:-1;for(const [turn,v]of Object.entries(live.evals)){if(!Array.isArray(v))continue;out.set(+turn+1,{played:true,score:v[1]*sign,depth:v[0]})}
  for(const turn of live.hand||[])out.set(+turn+1,{played:true,hand:true});
  for(const [ply,v]of Object.entries(live.opp||{}))if(!out.has(+ply))out.set(+ply,{played:true,rating:v.rating,depth:v.depth,opp:true});return out} // moves played by hand have no engine rating
 for(const [ply,score,depth]of s.move_ratings||[])out.set(ply,{played:true,score,depth,book:depth===1&&score===0});
 return out;
}
// The engine line sits in the move list itself, under the move it belongs to, numbered and rated like the game's moves.
function renderHistoryLine(s,list){
 const review=s?.game_review;let box=list.querySelector(':scope > .history-line');
 const found=review&&s.mode==='analysis'?(review.extras||[]).find(e=>e.kind==='line'&&e.ply===s.ply&&e.status==='ready'):null;
 const line=found&&!reviewLineHidden.has(s.ply)&&!reviewTry&&!editorDraft?found:null;
 if(!line){if(box)box.remove();return}
 const game=s.review_game||s.game,key=JSON.stringify([game,line.ply,line.moves,line.scores,reviewPreview&&reviewPreview.key]);
 const total=(s.review_game||s.game).split(';').length-3,n=line.ply,anchorPly=n%2&&n<total?n+1:n;
 const anchor=[...list.querySelectorAll(':scope > button.history-move')].find(b=>parseInt(b.querySelector('.move-number')?.textContent,10)===anchorPly);
 if(box&&box.dataset.key===key&&anchor&&box.previousElementSibling===anchor)return;
 if(!box){box=document.createElement('div');box.className='history-line'}
 box.dataset.key=key;box.replaceChildren();
 const head=document.createElement('div');head.className='history-line-head';
 const title=document.createElement('span');title.textContent='Engine line';head.append(title);
 box.append(head);
 const grid=document.createElement('div');grid.className='history-line-moves';
 if(n%2===0){const gap=document.createElement('span');gap.className='history-line-gap';grid.append(gap)} // a Black move starts in the right-hand column
 const text=m=>{try{return shownMove(m)}catch(e){return m}};
 line.moves.forEach((m,i)=>{const k='line'+n+'-'+i,on=!!reviewPreview&&reviewPreview.key===k,step=line.steps[i],score=(line.scores||[])[i];
  const b=document.createElement('button');b.type='button';b.className='history-move line-move'+(on?' current':'');b.title='Show the board after this move of the engine line';
  const num=document.createElement('span');num.className='move-number';num.textContent=`${n+i}.`;
  const mv=document.createElement('span');mv.textContent=text(m);b.append(num,mv);
  const rating=reviewPoint(score??null);if(rating!=null){const t=document.createElement('span');t.className='move-rating';t.textContent=(rating>0?'+':'')+rating;b.append(t)}
  b.onclick=e=>{e.stopPropagation();if(!step?.pieces)return;setReviewPreview(on?null:{game,ply:n,pieces:step.pieces,last_move:step.last_move,key:k})};
  grid.append(b)});
 box.append(grid);
 if(anchor)anchor.after(box);else list.append(box);
}
// Clicking a move the review has not reached yet reviews just that move (when the review is not running).
let reviewUserAt=0;for(const ev of ['pointerdown','keydown'])document.addEventListener(ev,()=>{reviewUserAt=Date.now()},true);
let reviewSingleLastPly=null,reviewSingleWant=null;
function reviewSingleOnSelect(s){
 // A move chosen in this window (not the review stopping on a move, and not another open window) is wanted;
 // it is asked for once the review is idle, and dropped once that move has a result or is being worked on.
 if(s&&s.ply!==reviewSingleLastPly){reviewSingleLastPly=s.ply;if(Date.now()-reviewUserAt<3000&&document.hasFocus())reviewSingleWant={game:s.review_game||s.game,ply:s.ply}}
 const want=reviewSingleWant,review=s?.game_review;if(!want||!review)return;
 const game=s.review_game||s.game;if(want.game!==game||want.ply!==s.ply){reviewSingleWant=null;return}
 if(s.mode!=='analysis'||review.source==='in_game'||editorDraft||reviewTry||reviewTryOn){reviewSingleWant=null;return}
 const ply=want.ply,total=game.split(';').length-3;
 if(!(ply>=1&&ply<=total)||(review.rows||[]).some(r=>r.ply===ply)||review.single_working===ply||(review.single_queue||[]).includes(ply)){reviewSingleWant=null;return}
 if(review.status==='running'){reviewSingleWant=null;return} // the full review will get there
 reviewSingleWant=null;
 fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-Board-Token':window.BOARD_TOKEN},body:JSON.stringify({action:'review_one',ply})}).then(r=>r.json()).then(d=>{if(d&&d.game&&typeof render==='function')render(d)}).catch(()=>{});
}
window.decorateHistory=s=>{
 const review=s?.game_review,list=$('moves');if(!list)return;
 reviewInfo.hidden=!review||!!editorDraft;
 reviewSettings(!!review&&!editorDraft&&s.mode==='analysis');
 {const go=$('reviewGo'),src=$('analyze');if(go&&src){if(go.textContent!==src.textContent)go.textContent=src.textContent;go.disabled=src.disabled;go.hidden=!review}}
 const running=review?.status==='running';
 if(reviewWasRunning===false&&running)window.setMovesMax?.(true); // a review just started: give the history the whole side panel
 reviewWasRunning=running;
 reviewSingleOnSelect(s);
 const turning=renderReviewFacts(s);
 renderReviewExtra(s);
 renderHistoryLine(s,list);
 const rows=new Map([...reviewInGameRows(s),...(review?.rows||[])].map(r=>[r.ply,r]));
 // Seconds each move took (hivegame.com games saved from now on), shown small beside the move.
 {const times=window.foulbroodOpenedTimes?window.foulbroodOpenedTimes(s):null;
  for(const item of list.querySelectorAll(':scope > button.history-move')){const number=item.querySelector('.move-number'),ply=number?parseInt(number.textContent,10):0,t=times&&ply?times[ply-1]:null;let tag=item.querySelector('.move-time');
   if(t==null||t<0.1){if(tag)tag.remove();continue} // instant (book) moves show no time
   const text=t<60?(t<10?t.toFixed(1):Math.round(t))+'s':Math.floor(t/60)+':'+String(Math.round(t%60)).padStart(2,'0');
   if(!tag){tag=document.createElement('span');tag.className='move-time';tag.title='Time spent on this move';const rating=item.querySelector('.move-rating');if(rating)rating.before(tag);else item.append(tag)}
   if(tag.textContent!==text)tag.textContent=text}}
 // Local and Online (no review): the engine's own rating of each move it made, as in Game review.
 const played=review?null:playedRatings(s);
 // Outside Game review, a review already done on this game still colours and rates the moves (clicking does not review).
 const savedRows=!review&&Array.isArray(s.saved_review_rows)?new Map(s.saved_review_rows.map(r=>[r.ply,r])):null;
 for(const item of list.querySelectorAll(':scope > button.history-move')){
  const number=item.querySelector('.move-number'),ply=number?parseInt(number.textContent,10):0,row=review&&ply?rows.get(ply):(savedRows&&ply&&savedRows.get(ply))||(played&&ply?played.get(ply):null);
  const verdict=row?historyVerdicts[row.label]||'':'';
  let tag=item.querySelector('.move-rating');
  // The move being reviewed on its own says so in the list, where it was clicked.
  if(review&&(review.single_working===ply||(review.status==='running'&&review.working_ply===ply)||(review.single_queue||[]).includes(ply))&&!(review.rows||[]).some(r=>r.ply===ply)){const now=review.single_working===ply||review.status==='running'&&review.working_ply===ply;item.classList.remove('ingame');if(!tag){tag=document.createElement('span');tag.className='move-rating';item.append(tag)}tag.textContent=now?'Reviewing':'Queued';tag.classList.add('reviewing');tag.classList.toggle('queued',!now);continue}
  if(tag)tag.classList.remove('queued');
  if(tag)tag.classList.remove('reviewing');
  if(!row){item.classList.remove('turning','ingame');if(tag)tag.remove();delete item.dataset.verdict;if(item.dataset.reviewTitle){item.title='';delete item.dataset.reviewTitle}continue}
  if(row.played){const text=row.hand?'Hand':row.book?'Book':((r=>(r>0?'+':'')+r)(row.rating??reviewPoint(row.score)));item.classList.remove('turning','ingame');delete item.dataset.verdict;
   if(!tag){tag=document.createElement('span');tag.className='move-rating';item.append(tag)}if(tag.textContent!==text)tag.textContent=text;
   item.title=row.hand?'Played by hand':row.opp?'Engine insight on the opponent':row.book?'Book move':'Engine rating while playing'+(row.depth?` (depth ${row.depth})`:'')+' · position '+text;item.dataset.reviewTitle='1';continue}
  if(verdict)item.dataset.verdict=verdict;else delete item.dataset.verdict;
  item.classList.toggle('turning',!!turning&&turning.ply===ply);
  item.classList.toggle('ingame',!!row.ingame);
  const rating=row.label==='Book move'&&row.score==null?null:reviewPoint(row.score),text=rating==null?(row.label==='Book move'?'Book':''):(rating>0?'+':'')+rating;
  if(!tag){tag=document.createElement('span');tag.className='move-rating';item.append(tag)}
  if(tag.textContent!==text)tag.textContent=text;
  item.title=(row.ingame?`${row.by}'s rating while playing (depth ${row.depth})`:row.label)+(rating==null?'':' · position '+text);item.dataset.reviewTitle='1';{const spent=item.querySelector('.move-time');if(spent&&spent.textContent)item.title+=' · '+spent.textContent+' thinking'}
 }
 // Last line of the list: how the game ended.
 let end=list.querySelector('.history-end');const ending=historyEnding(s);
 if(!ending||!list.querySelector('button.history-move')){if(end)end.remove()}
 else{if(!end){end=document.createElement('p');end.className='history-end'}if(list.lastElementChild!==end)list.append(end);if(end.textContent!==ending)end.textContent=ending}
};
window.renderGameReview=s=>{$('hintsLabel').hidden=false;$('bookEnabled').closest('label').hidden=false;renderReview(s);window.decorateHistory(s)};
if(state)window.renderGameReview(state);


// The ⏮ ◀ ▶ ⏭ buttons step through an engine line that is showing under the current move: from the played move,
// ▶ goes into the line one move at a time; past its end it carries on with the game; ◀ from the line's first move
// goes back to the played move, and on from there as usual. ⏮ / ⏭ leave the line.
function visibleLine(s){
 const review=s?.game_review;if(!review||s.mode!=='analysis'||reviewTry||editorDraft||reviewLineHidden.has(s.ply))return null;
 return (review.extras||[]).find(e=>e.kind==='line'&&e.ply===s.ply&&e.status==='ready'&&(e.steps||[]).length)||null;
}
for(const [id,dir]of [['historyFirst','first'],['historyPrevious','previous'],['historyNext','next'],['historyLast','last']]){
 const b=$(id);if(!b)continue;
 b.addEventListener('click',e=>{
  const s=state,line=visibleLine(s);if(!line)return;
  const n=line.ply,game=s.review_game||s.game,m=reviewPreview&&String(reviewPreview.key||'').match(/^line(\d+)-(\d+)$/),at=m&&+m[1]===n?+m[2]:-1;
  const show=i=>{const step=line.steps[i];if(!step?.pieces)return false;setReviewPreview({game,ply:n,pieces:step.pieces,last_move:step.last_move,key:'line'+n+'-'+i});return true};
  let handled=false;
  if(dir==='next'){if(at<0)handled=show(0);else if(at+1<line.steps.length)handled=show(at+1);else{setReviewPreview(null)}} // past the end: on with the game
  else if(dir==='previous'&&at>=0){if(at>0)handled=show(at-1);else{setReviewPreview(null);handled=true}} // before the line: the played move
  else if(at>=0)setReviewPreview(null); // ⏮ ⏭ leave the line
  if(handled){e.stopImmediatePropagation();e.preventDefault()}
 },true);
}

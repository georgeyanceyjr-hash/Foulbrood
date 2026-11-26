// Analysis workspaces share one board and history cursor.
$('modeAnalyze').onclick=()=>{if(editorDraft)$('cancelSetup').click();if(state?.game_review)action({action:'review_exit'})};
$('modeSetup').onclick=async()=>{if(state?.game_review)await action({action:'review_exit'});if(!editorDraft)openPositionSetup(false)};
$('inGameAnalysis').onchange=()=>action({action:'review_source',source:$('inGameAnalysis').checked?'in_game':'review'});
$('modeReview').onclick=()=>{if(editorDraft)$('cancelSetup').click();action({action:'review_enter'})};
function reviewPoint(score){return score==null?null:Math.abs(score)>99000?Math.sign(score)*100:Math.max(-99,Math.min(99,Math.round(100*Math.tanh(score/300))))}
function reviewBannerText(s){
 const review=s.game_review,row=review.rows.find(r=>r.ply===s.ply),point=review.points.find(p=>p.ply===s.ply);
 const name=s.ply?`Move ${s.ply}`:'Starting position',score=row?.score??point?.score;
 if(row?.label==='Book move')return `${name} · Book move`;
 if(score==null)return `${name} · ${review.status==='running'&&review.working_ply===s.ply?'Reviewing…':review.status==='ready'?'Start review to assess this position':'Not reviewed yet'}`;
 const rating=reviewPoint(score),description=review.external&&Math.abs(score)>99000?(score>0?'White':'Black')+' has a forced win':positionAssessment({score,side:0,depth:row?.depth||0});
 return [name,row?.symbol?`${row.label} ${row.symbol}`:null,description,`${rating>0?'+':''}${rating}`].filter(Boolean).join(' · ');
}
let reviewGraphKey='';
function reviewActivityText(review){
 // Older running backends leave this phase set during the next parent search.
 // The actual working move, rather than its previous completed card, is active.
 if(review.stage?.endsWith(' · book check'))return `Reviewing move ${review.working_ply} of ${review.total}`;
 return review.stage||'Starting review…';
}
const reviewMarksCache=new Map(),reviewMarksPending=new Set();
function renderReviewMarks(s){
 const board=$('board');board.querySelectorAll('.review-marks').forEach(e=>e.remove());
 if(window.reviewPreviewActive?.()){ // a tried move on the board carries its grade (or a waiting mark) on the piece itself
  const tried=window.reviewTriedShown?.(s),to=tried?.last_move?.to;if(!tried||!to)return;
  const [x,baseY]=xy(...to),height=Math.max(0,s.pieces.filter(p=>p.q===to[0]&&p.r===to[1]).length-1),y=baseY-height*10;
  const verdict=tried.status==='ready'?reviewTryGrade(s,tried):null,label=verdict?verdict.text:'…',width=Math.max(34,label.length*8.5+14);
  const badge=node('g',{class:'review-marks review-try-badge'+(verdict?'':' waiting'),'data-verdict':verdict?verdict.verdict:'',style:'cursor:pointer'});
  badge.addEventListener('pointerdown',e=>{e.stopPropagation();e.preventDefault();reviewTryDismissed.add(tried.ply+'|'+tried.move);setReviewPreview(null)}); // click the grade: the tried move and its result go away
  {const tip=node('title',{});tip.textContent='Click to clear this tried move';badge.append(tip)}
  badge.append(node('polygon',{points:hex(x,y,40),fill:'transparent',stroke:'none'})); // the whole piece is the click target, not just the number
  badge.append(node('rect',{x:x-width/2,y:y-12,width,height:24,rx:3}));
  const text=node('text',{x,y:y+5,'text-anchor':'middle'});text.textContent=label;badge.append(text);board.append(badge);
  return;
 }
 if(globalThis.insightSuggestionsVisible?.(s)===false)return;
 const row=s.game_review?.rows.find(r=>r.ply===s.ply);
 if(!row?.symbol||!row.alternative||row.alternative===row.move)return;
 const key=s.game+'|'+row.alternative;
 if(!reviewMarksCache.has(key)){
  if(reviewMarksPending.has(key))return;reviewMarksPending.add(key);
  fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-Board-Token':window.BOARD_TOKEN},body:JSON.stringify({action:'review_marks',ply:s.ply})}).then(async r=>{const data=await r.json();if(r.ok){reviewMarksCache.set(key,data.mark);if(reviewMarksCache.size>200)reviewMarksCache.delete(reviewMarksCache.keys().next().value);if(state?.game===s.game)renderReviewMarks(state)}}).catch(()=>{}).finally(()=>reviewMarksPending.delete(key));return;
 }
 const mark=reviewMarksCache.get(key);if(!mark)return;
 const layer=node('g',{class:'review-marks opponent-insight-preview','pointer-events':'none','aria-label':'Preferred move preview',style:`--preview-blue:${hintColor(row.side??1-s.side)}`}),[x,baseY]=xy(...mark.to);
 const height=s.pieces.filter(p=>p.q===mark.to[0]&&p.r===mark.to[1]&&p.id!==mark.piece).length,y=baseY-height*10;
 if(mark.origin){
  const [sx,sy]=xy(...mark.origin),dx=x-sx,dy=y-sy,length=Math.hypot(dx,dy);
  layer.append(node('polygon',{points:hex(sx,sy,39),class:'opponent-insight-outline','stroke-dasharray':'6 4'}));
  if(length>42){const ux=dx/length,uy=dy/length,ex=x-ux*43,ey=y-uy*43;
   layer.append(node('line',{x1:sx,y1:sy,x2:ex,y2:ey,class:'opponent-insight-arrow'}));
   layer.append(node('polygon',{points:`${ex},${ey} ${ex-ux*11-uy*5},${ey-uy*11+ux*5} ${ex-ux*11+uy*5},${ey-uy*11-ux*5}`,class:'opponent-insight-arrowhead'}));
  }
 }
 const ghost=node('g',{opacity:.55});ghost.append(artwork(mark.piece,x,y));layer.append(ghost);
 layer.append(node('polygon',{points:hex(x,y,40),class:'opponent-insight-outline'}));board.append(layer);
}
function reviewIssue(direction){const rows=state?.game_review?.rows||[];const candidates=rows.filter(r=>r.symbol&&(direction>0?r.ply>state.ply:r.ply<state.ply));const row=direction>0?candidates[0]:candidates.at(-1);if(row)action({action:'navigate',ply:row.ply})}
$('previousIssue').onclick=()=>reviewIssue(-1);$('nextIssue').onclick=()=>reviewIssue(1);

window.renderGameReview=s=>{
 const review=s.game_review,active=!!review,editing=!!editorDraft;
 $('analysisModes').hidden=s.mode!=='analysis';$('startSetup').hidden=true;
 for(const [id,on]of [['modeAnalyze',!active&&!editing],['modeSetup',editing],['modeReview',active]])$(id).setAttribute('aria-pressed',String(on));
 renderReviewMarks(s);
 $('reviewPanel').hidden=!active;
 $('inGameAnalysisChoice').hidden=!active||!review.recorded_count;
 $('inGameAnalysis').checked=review?.source==='in_game';$('inGameAnalysis').disabled=review?.status==='running';
 $('reviewFileActions').hidden=s.mode!=='analysis'||editing;
 $('saveReviewedGame').disabled=s.mode!=='analysis'||!(review?.total??s.review_total);
 $('reviewIssueNav').hidden=!active;
 $('analysisImportHeader').querySelector('h2').textContent=active?'Explore a game':'Explore a position';
 $('analyze').textContent=active?(review.status==='running'?'Stop review':review.can_resume?'Resume review':review.rows.length?'Review again':'Start review'):(s.showing_player_thought?'Thinking…':s.insight_job==='hint'?'Stop':'Analyze');
 $('analyze').onclick=active?()=>action({action:state?.game_review?.status==='running'?'review_stop':'review_start'}):toggleAnalysis;
 $('stopAnalysis').textContent=active?'Stop review':'Stop analysis';$('stopAnalysis').onclick=()=>action({action:active?'review_stop':'stop_analysis'});
 if(!active){reviewGraphKey='';return;}
 $('analysisSetup').hidden=false;$('historyPanel').hidden=false;
 $('analyze').disabled=!review.total;$('stopAnalysis').hidden=true;
 $('hintsLabel').hidden=true;$('bookEnabled').closest('label').hidden=true;$('calculateInstead').hidden=true;
 $('reviewProgress').textContent=review.source==='in_game'?`${review.recorded_count} positions with in-game analysis`:review.resume_engine_missing?`Saved results loaded. Connect ${review.engine} to continue reviewing.`:review.error||(!review.total?'Import a game to get started.':review.status==='running'?(review.working_ply&&review.total?`Move ${Math.min(review.working_ply,review.total)} of ${review.total}`:'Starting review…'):review.status==='complete'?`${review.total} moves reviewed`:review.status==='stopped'?`Stopped · ${review.rows.length} of ${review.total} reviewed`:`${review.total} moves`);
 const remaining=review.status==='ready'||review.status==='complete'?(review.status==='complete'?0:(2*review.total+1)*s.analysis_ms/1000):review.remaining_seconds;
 $('reviewRemaining').hidden=!review.total||review.source==='in_game';$('reviewProgressBar').hidden=review.source==='in_game';
 const minutes=Math.max(1,Math.ceil(remaining/60));
 $('reviewRemaining').textContent=review.status==='complete'?'Review complete':review.status==='stopped'?'':`Up to about ${minutes} ${minutes===1?'minute':'minutes'} remaining`;
 $('reviewProgress').classList.toggle('search-activity',review.status==='running');
 $('reviewProgressBar').max=Math.max(1,review.total);$('reviewProgressBar').value=review.rows.length;
 $('turn').hidden=true;
 const row=review.rows.find(r=>r.ply===s.ply),point=review.points.find(p=>p.ply===s.ply),insight=$('insight');insight.replaceChildren();
 const title=document.createElement('strong');title.className='insight-move';title.textContent=row?`${row.ply}. ${shownMove(row.move)} ${row.symbol}`:s.ply===0?'Starting position':`Move ${s.ply}`;insight.append(title);
 const assessment=document.createElement('p');assessment.className='insight-assessment';assessment.textContent=row?row.label:point?.score!=null?positionAssessment({score:point.score,side:0,depth:point.depth}):'This position has not been reviewed yet.';insight.append(assessment);
 if(!row&&point?.score!=null)appendEvaluationScale(insight,{score:point.score,side:0,depth:point.depth},{side:s.side});
 if(row){
  if(row.score!=null)appendEvaluationScale(insight,{score:row.score,side:0,depth:row.depth},{side:row.side??1-s.side});
  if(row.alternative&&row.alternative!==row.move){
   const line=document.createElement('div');line.className='review-alternative';
   const label=document.createElement('small');label.textContent='Preferred move';
   const moves=document.createElement('strong');moves.className='insight-move';moves.style.color=hintColor(row.side??1-s.side);moves.textContent=`${row.ply}. ${shownMove(row.alternative)}`;line.append(label,moves);insight.append(line);
  }
  if(row.best_score!=null&&row.score!=null&&row.alternative!==row.move){
   const comparison=document.createElement('div');comparison.className='review-comparison';
   const heading=document.createElement('small');heading.className='review-comparison-heading';heading.textContent='Continuation ratings · White’s perspective';comparison.append(heading);
   for(const [label,score,depth]of [['Preferred',row.best_score,row.best_depth],['Played',row.score,row.depth]]){
    const cell=document.createElement('div');cell.className='review-comparison-cell';
    appendEvaluationScale(cell,{score,side:0,depth},{side:row.side??1-s.side,label,showDepth:false});
    const detail=document.createElement('small');detail.textContent=`Depth ${depth}`;cell.append(detail);comparison.append(cell);
   }
   insight.append(comparison);
  }
  if(row.label==='Uncertain'||row.label==='Missed win'){
   const detail=document.createElement('small');detail.textContent=row.label==='Uncertain'?'Comparison inconclusive at this depth.':'The preferred line retains a forced win.';insight.append(detail);
  }
 }
 const issues=review.rows.filter(r=>r.symbol),books=review.rows.filter(r=>r.label==='Book move').length;$('reviewSummary').textContent=review.source==='in_game'?'Original suggestions and scores recorded during play.':(review.engine?review.engine+' · ':'')+(books?`${books} book ${books===1?'move':'moves'} · `:'')+(issues.length?`${issues.length} flagged ${issues.length===1?'move':'moves'}`:'No moves flagged');$('reviewSummary').title=review.source==='in_game'?'Scores may come from different engines and thinking times.':'Move labels use approximate engine-specific score-loss thresholds, not calibrated winning probabilities.';
 $('previousIssue').disabled=!issues.some(r=>r.ply<s.ply);$('nextIssue').disabled=!issues.some(r=>r.ply>s.ply);
 const key=JSON.stringify([review.points,s.ply,review.status,review.working_ply,review.rows.map(r=>r.symbol),$('reviewGraph').clientWidth]);if(key===reviewGraphKey)return;reviewGraphKey=key;
 const graph=$('reviewGraph'),width=Math.max(300,graph.clientWidth),span=width-24;graph.setAttribute('viewBox',`0 0 ${width} 160`);graph.replaceChildren();graph.append(node('line',{x1:12,y1:80,x2:width-12,y2:80,class:'review-zero'}));
 const points=review.points.filter(p=>p.score!=null&&p.ply>=1),x=p=>12+span*(p.ply-1)/Math.max(1,review.total-1),y=p=>80-reviewPoint(p.score)*.65;
 // Move numbers along the bottom: the first move, every tenth, and the last.
 {const total=Math.max(1,review.total),marks=new Set([1,total]);for(let m=10;m<total-3;m+=10)marks.add(m);
  for(const m of marks){const at=12+span*(m-1)/Math.max(1,total-1),end=m===total,first=m===1;graph.append(node('line',{x1:at,y1:first||end?6:140,x2:at,y2:146,class:'review-tick'+(first||end?' edge':'')}));const t=node('text',{x:at,y:157,class:'review-tick-label','text-anchor':end?'end':first?'start':'middle'});t.textContent=first?'Move 1':end?'Move '+total:String(m);graph.append(t)}}
 if(review.status==='running'){const at=12+span*Math.max(0,review.working_ply-1)/Math.max(1,review.total-1);graph.append(node('line',{x1:at,y1:10,x2:at,y2:150,class:'review-working'}));}
 if(points.length){const path=points.map(p=>`${x(p)},${y(p)}`).join(' ');graph.append(node('polyline',{points:path,class:'review-line-case'}));graph.append(node('polyline',{points:path,class:'review-line'}))}
 for(const p of points){const r=review.rows.find(r=>r.ply===p.ply);const group=node('g',{role:'button',tabindex:0,'aria-label':`Move ${p.ply}: ${reviewPoint(p.score)}${r?.symbol?', '+r.label:''}`});group.append(node('circle',{cx:x(p),cy:y(p),r:9,fill:'transparent'}));group.append(node('circle',{cx:x(p),cy:y(p),r:p.ply===s.ply?5:3.5,class:'review-dot'+(r?.symbol?' flagged':'')+(p.ply===s.ply?' current':'')+(r?' v-'+(({'Best move':'good','Book move':'good','No clear error':'good','Inaccuracy':'mid','Uncertain':'mid','Mistake':'poor','Blunder':'bad','Missed win':'bad'})[r.label]||'none'):'')}));group.onclick=()=>action({action:'navigate',ply:p.ply});group.onkeydown=e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();group.onclick()}};graph.append(group);}
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
 for(const id of ['reviewProgress','reviewRemaining','reviewProgressBar','reviewSummary']){const e=$(id);if(e)box.append(e)}
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
function reviewOpening(game){ // the first three bugs each side put down, e.g. "P·A·Q vs G·B·Q"
 const moves=String(game||'').split(';').slice(3),root=String(game||'').split(';')[0];if(root.includes('~')||moves.length<2)return '';
 const bugs=[[],[]];moves.slice(0,6).forEach((m,i)=>{const piece=m.trim().split(' ')[0]||'';bugs[i%2].push(piece.replace(/^[wb]/,'').replace(/\d/,'')||'–')});
 return bugs[0].join('·')+' vs '+bugs[1].join('·');
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
 const key=JSON.stringify([sides,lastBook,opening,turn&&turn.ply,names,s.ply===(turn&&turn.ply),rows.length,ingame.length&&ingame[0].by]);
 if(box.dataset.key!==key){box.dataset.key=key;box.replaceChildren();
  for(const side of rows.length?sides:[]){const line=document.createElement('p');line.className='review-fact';const who=document.createElement('b');who.textContent=side.side===0?'White':'Black';
   const bits=[side.accuracy==null?'—':side.accuracy+'%'];if(side.slips)bits.push(side.slips+' inaccurac'+(side.slips===1?'y':'ies'));if(side.mistakes)bits.push(side.mistakes+' mistake'+(side.mistakes===1?'':'s'));if(side.blunders)bits.push(side.blunders+' blunder'+(side.blunders===1?'':'s'));
   line.append(who,' '+bits.join(' · '));line.title='Accuracy: 100% means every move matched the engine\'s choice or cost nothing.';box.append(line)}
  if(opening||lastBook){const line=document.createElement('p');line.className='review-fact muted';line.textContent=[opening?'Opening '+opening:'',lastBook?'book to move '+lastBook:''].filter(Boolean).join(' · ');line.title='The first three bugs each side placed (White vs Black)';box.append(line)}
  if(turn){const go=document.createElement('button');go.type='button';go.id='reviewTurn';go.className='small';go.textContent='Turning point · move '+turn.ply;go.title='Where the position swung the most and never came back';go.onclick=()=>action({action:'navigate',ply:turn.ply});if(s.ply===turn.ply)go.setAttribute('aria-pressed','true');box.append(go)}
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
let reviewPreview=null,reviewTry=null,reviewTryShow=null;const reviewTryDismissed=new Set(); // preview: {game,ply,pieces,last_move,key}; try: {game,ply}
window.reviewPreviewActive=()=>!!reviewPreview;
{ // Draw a previewed position (a step of the engine's line, or the tried move) in place of the real one, without touching the game.
 const realRender=render;
 render=function(s){
  if(reviewPreview&&s&&s.game_review&&s.ply===reviewPreview.ply&&(s.review_game||s.game)===reviewPreview.game)s={...s,pieces:reviewPreview.pieces,last_move:reviewPreview.last_move||null,hint:null};
  else if(reviewPreview){reviewPreview=null;lastBoardKey=''}
  return realRender(s);
 };
 // While "Try a move" is on, the board accepts one move for the side to play, and that move is graded instead of played.
 const trying=()=>!!reviewTry&&!!state&&!!state.game_review&&state.game_review.status!=='running'&&!editorDraft&&state.ply===reviewTry.ply-1&&(state.review_game||state.game)===reviewTry.game;
 const realCanMove=canMove,realPlay=play;
 canMove=function(){return trying()||realCanMove()};
 play=function(move){
  if(!trying())return realPlay(move);
  const ply=reviewTry.ply;reviewTry=null;reviewTryShow=ply;reviewTryDismissed.delete(ply+'|'+move); // once the server has the position, keep the tried move on the board
  (async()=>{await action({action:'review_side',kind:'try',ply,move});for(let i=0;i<20&&busy;i++)await new Promise(r=>setTimeout(r,50));await action({action:'navigate',ply})})();
 };
}
// The tried move currently shown on the board (if the preview is of a tried move), and its grade.
window.reviewTriedShown=s=>{if(!reviewPreview||!/^try/.test(reviewPreview.key)||!s?.game_review)return null;return (s.game_review.extras||[]).find(e=>e.kind==='try'&&'try'+e.ply===reviewPreview.key)||null};
function reviewTryGrade(s,tried){
 const row=(s.game_review.rows||[]).find(r=>r.ply===tried.ply);if(!row)return null;
 const sign=row.side===0?1:-1,best=row.best_score!=null?row.best_score:row.score;
 const grade=tried.score==null||best==null?['Uncertain','']:(tried.move===row.alternative?['Best move','']:gradeReviewMove(best*sign,tried.score*sign,row.best_depth,tried.depth));
 const rating=tried.score==null?null:reviewPoint(tried.score),name=({'No clear error':'Fine','Uncertain':'Unclear','Best move':'Best'}[grade[0]]||grade[0]);
 return {name,rating,verdict:historyVerdicts[grade[0]]||'',text:rating==null?name:(rating>0?'+':'')+rating};
}
function setReviewPreview(next){reviewPreview=next;lastBoardKey='';if(typeof serverState!=='undefined'&&(serverState||state))render(serverState||state)}
function renderReviewExtra(s){
 const box=reviewExtraBox,review=s?.game_review;
 if(reviewTry&&(!review||(s.review_game||s.game)!==reviewTry.game||(s.ply!==reviewTry.ply-1&&s.ply!==reviewTry.ply)))reviewTry=null;
 const ply=reviewTry?reviewTry.ply:s?.ply,row=review?(review.rows||[]).find(r=>r.ply===ply):null;
 const usable=!!row&&review.status!=='running'&&row.label!=='Book move'&&!editorDraft&&review.source!=='in_game';
 box.hidden=!usable;if(!usable){box.dataset.key='';document.body.classList.remove('review-grading');return}
 const extras=review.extras||[],line=extras.find(e=>e.kind==='line'&&e.ply===ply),found=extras.find(e=>e.kind==='try'&&e.ply===ply),tried=found&&!reviewTryDismissed.has(found.ply+'|'+found.move)?found:null,game=s.review_game||s.game;
 // A move just tried stays on the board (pulsing while it is graded) until the chip is clicked or another move is chosen.
 if(reviewTryShow===ply&&tried&&tried.pieces&&s.ply===ply){reviewTryShow=null;const shown={game,ply,pieces:tried.pieces,last_move:tried.last_move,key:'try'+ply};setTimeout(()=>setReviewPreview(shown),0)}
 document.body.classList.toggle('review-grading',!!tried&&tried.status==='running'&&!!reviewPreview&&reviewPreview.key==='try'+ply);
 const key=JSON.stringify([ply,line&&[line.status,line.moves,line.error],tried&&[tried.status,tried.move,tried.score,tried.depth,tried.error],reviewPreview&&reviewPreview.key,!!reviewTry,tried&&!!tried.pieces,row.best_score,row.side]);
 if(box.dataset.key===key)return;box.dataset.key=key;box.replaceChildren();
 const text=m=>{try{return shownMove(m)}catch(e){return m}};
 const button=(label,title,click,pressed)=>{const b=document.createElement('button');b.type='button';b.className='small';b.textContent=label;if(title)b.title=title;b.onclick=click;if(pressed)b.setAttribute('aria-pressed','true');return b};
 const controls=document.createElement('div');controls.className='review-extra-row';
 if(!line||line.status==='error')controls.append(button('Engine line','Show the moves the engine expected after its preferred move',()=>action({action:'review_side',kind:'line',ply})));
 controls.append(reviewTry?button('Cancel try','Stop trying a move',()=>{const back=reviewTry.ply;reviewTry=null;action({action:'navigate',ply:back})},true)
  :button('Try a move','Play a different move for this turn on the board and have it graded',async()=>{if(reviewPreview)setReviewPreview(null);reviewTry={game,ply};await action({action:'navigate',ply:ply-1})}));
 box.append(controls);
 const note=t=>{const p=document.createElement('p');p.className='review-fact muted';p.textContent=t;box.append(p)};
 if(reviewTry)note(`Move a ${row.side===0?'White':'Black'} bug on the board to grade it.`);
 if(line&&line.status==='running')note('Finding the engine line…');
 if(line&&line.status==='error')note(line.error||'The engine line is not available.');
 if(line&&line.status==='ready'&&!reviewTry){
  const chips=document.createElement('div');chips.className='review-line';const label=document.createElement('span');label.className='review-line-label';label.textContent='Line';chips.append(label);
  line.moves.forEach((m,i)=>{const k='line'+ply+'-'+i,on=reviewPreview&&reviewPreview.key===k;const step=line.steps[i];
   chips.append(button(text(m),'Show the board after this move of the line',()=>setReviewPreview(on?null:{game,ply,pieces:step.pieces,last_move:step.last_move,key:k}),on))});
  box.append(chips);
 }
 if(tried&&tried.status==='running'&&!reviewTry)note(`Grading ${text(tried.move)}…`);
 if(tried&&tried.status==='error'&&!reviewTry)note(tried.error||'That move could not be graded.');
 if(tried&&tried.status==='ready'&&!reviewTry){
  const g=reviewTryGrade(s,tried)||{name:'Unclear',rating:null,verdict:''},rating=g.rating,k='try'+ply,on=reviewPreview&&reviewPreview.key===k;
  const chips=document.createElement('div');chips.className='review-line';const label=document.createElement('span');label.className='review-line-label';label.textContent='Tried';chips.append(label);
  const b=button(text(tried.move),'Show the board after the move you tried',()=>setReviewPreview(on?null:{game,ply,pieces:tried.pieces,last_move:tried.last_move,key:k}),on);chips.append(b);
  const verdict=document.createElement('span');verdict.className='review-try-verdict';verdict.dataset.verdict=g.verdict;
  verdict.textContent=g.name+(rating==null?'':' · '+(rating>0?'+':'')+rating);chips.append(verdict);
  box.append(chips);
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
window.decorateHistory=s=>{
 const review=s?.game_review,list=$('moves');if(!list)return;
 reviewInfo.hidden=!review||!!editorDraft;
 reviewSettings(!!review&&!editorDraft&&s.mode==='analysis');
 {const go=$('reviewGo'),src=$('analyze');if(go&&src){if(go.textContent!==src.textContent)go.textContent=src.textContent;go.disabled=src.disabled;go.hidden=!review}}
 const running=review?.status==='running';
 if(reviewWasRunning===false&&running)window.setMovesMax?.(true); // a review just started: give the history the whole side panel
 reviewWasRunning=running;
 const turning=renderReviewFacts(s);
 renderReviewExtra(s);
 const rows=new Map([...reviewInGameRows(s),...(review?.rows||[])].map(r=>[r.ply,r]));
 // Seconds each move took (hivegame.com games saved from now on), shown small beside the move.
 {const times=window.foulbroodOpenedTimes?window.foulbroodOpenedTimes(s):null;
  for(const item of list.querySelectorAll('button.history-move')){const number=item.querySelector('.move-number'),ply=number?parseInt(number.textContent,10):0,t=times&&ply?times[ply-1]:null;let tag=item.querySelector('.move-time');
   if(t==null||t<0.1){if(tag)tag.remove();continue} // instant (book) moves show no time
   const text=t<60?(t<10?t.toFixed(1):Math.round(t))+'s':Math.floor(t/60)+':'+String(Math.round(t%60)).padStart(2,'0');
   if(!tag){tag=document.createElement('span');tag.className='move-time';tag.title='Time spent on this move';const rating=item.querySelector('.move-rating');if(rating)rating.before(tag);else item.append(tag)}
   if(tag.textContent!==text)tag.textContent=text}}
 for(const item of list.querySelectorAll('button.history-move')){
  const number=item.querySelector('.move-number'),ply=number?parseInt(number.textContent,10):0,row=review&&ply?rows.get(ply):null;
  const verdict=row?historyVerdicts[row.label]||'':'';
  let tag=item.querySelector('.move-rating');
  if(!row){item.classList.remove('turning','ingame');if(tag)tag.remove();delete item.dataset.verdict;if(item.dataset.reviewTitle){item.title='';delete item.dataset.reviewTitle}continue}
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

async function saveReviewedGame(){
 if(busy)return;busy=true;actionEpoch++;
 try{
  const response=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-Board-Token':window.BOARD_TOKEN},body:JSON.stringify({action:'review_save'})});
  const data=await response.json();if(!response.ok)throw Error(data.error);
  const url=URL.createObjectURL(new Blob([data.text],{type:data.mime})),link=document.createElement('a');
  link.href=url;link.download=data.filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
 }catch(e){toast(e.message)}finally{busy=false}
}
$('saveReviewedGame').onclick=saveReviewedGame;
$('loadReviewedGame').onclick=()=>{if(!busy)$('reviewedGameFile').click()};
$('reviewedGameFile').onchange=async()=>{
 const file=$('reviewedGameFile').files[0];if(!file)return;
 try{if(file.size>8000000)throw Error('Please use a reviewed game smaller than 8 MB.');await action({action:'review_load',text:await file.text(),filename:file.name})}
 catch(e){toast(e.message)}finally{$('reviewedGameFile').value=''}
};

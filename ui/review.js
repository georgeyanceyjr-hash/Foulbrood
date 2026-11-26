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
 $('reviewRemaining').textContent=review.status==='complete'?'Review complete':review.status==='stopped'?'Completed assessments are kept.':`Up to about ${minutes} ${minutes===1?'minute':'minutes'} remaining`;
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
 const first=box.querySelector('#reviewProgress');if(first){box.prepend(line);line.append(first,go)}
 const panel=$('historyPanel'),head=panel?.querySelector(':scope > .row');const under=$('histExport')||head;if(under)under.after(box);return box})();
window.decorateHistory=s=>{
 const review=s?.game_review,list=$('moves');if(!list)return;
 reviewInfo.hidden=!review||!!editorDraft;
 {const go=$('reviewGo'),src=$('analyze');if(go&&src){if(go.textContent!==src.textContent)go.textContent=src.textContent;go.disabled=src.disabled;go.hidden=!review}}
 const running=review?.status==='running';
 if(reviewWasRunning===false&&running)window.setMovesMax?.(true); // a review just started: give the history the whole side panel
 reviewWasRunning=running;
 const rows=new Map((review?.rows||[]).map(r=>[r.ply,r]));
 for(const item of list.querySelectorAll('button.history-move')){
  const number=item.querySelector('.move-number'),ply=number?parseInt(number.textContent,10):0,row=review&&ply?rows.get(ply):null;
  const verdict=row?historyVerdicts[row.label]||'':'';
  let tag=item.querySelector('.move-rating');
  if(!row){if(tag)tag.remove();delete item.dataset.verdict;if(item.dataset.reviewTitle){item.title='';delete item.dataset.reviewTitle}continue}
  if(verdict)item.dataset.verdict=verdict;else delete item.dataset.verdict;
  const rating=row.label==='Book move'&&row.score==null?null:reviewPoint(row.score),text=rating==null?(row.label==='Book move'?'Book':''):(rating>0?'+':'')+rating;
  if(!tag){tag=document.createElement('span');tag.className='move-rating';item.append(tag)}
  if(tag.textContent!==text)tag.textContent=text;
  item.title=row.label+(rating==null?'':' · position '+text);item.dataset.reviewTitle='1';
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

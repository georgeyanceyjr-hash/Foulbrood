// Analysis workspaces share one board and history cursor.
$('modeAnalyze').onclick=()=>{if(editorDraft)$('cancelSetup').click();if(state?.game_review)action({action:'review_exit'})};
$('modeSetup').onclick=async()=>{if(state?.game_review)await action({action:'review_exit'});if(!editorDraft)openPositionSetup(false)};
$('inGameAnalysis').onchange=()=>action({action:'review_source',source:$('inGameAnalysis').checked?'in_game':'review'});
$('modeReview').onclick=()=>{if(editorDraft)$('cancelSetup').click();action({action:'review_enter'})};
function reviewPoint(score){return score==null?null:Math.abs(score)>99000?Math.sign(score)*100:Math.max(-99,Math.min(99,Math.round(100*Math.tanh(score/300))))}
function reviewBannerText(s){
 const review=s.game_review,row=review.rows.find(r=>r.ply===s.ply),point=review.points.find(p=>p.ply===s.ply);
 const name=s.ply?`Move ${s.ply}`:'Starting position',score=row?.score??point?.score;
 if(score==null)return `${name} · ${review.status==='running'&&review.working_ply===s.ply?'Reviewing…':review.status==='ready'?'Start review to assess this position':'Not reviewed yet'}`;
 const rating=reviewPoint(score),description=review.external&&Math.abs(score)>99000?(score>0?'White':'Black')+' has a forced win':positionAssessment({score,side:0,depth:row?.depth||0});
 return [name,row?.symbol?`${row.label} ${row.symbol}`:null,description,`${rating>0?'+':''}${rating}`].filter(Boolean).join(' · ');
}
let reviewGraphKey='';
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
 $('reviewProgress').textContent=review.source==='in_game'?`${review.recorded_count} positions with in-game analysis`:review.resume_engine_missing?`Saved results loaded. Connect ${review.engine} to continue reviewing.`:review.error||(!review.total?'Import a game to get started.':review.status==='running'?`${review.stage||'Starting review…'} · ${review.rows.length} reviewed`:review.status==='complete'?`${review.total} moves reviewed`:review.status==='stopped'?`Stopped · ${review.rows.length} of ${review.total} reviewed`:`${review.total} moves · Click Start review`);
 const remaining=review.status==='ready'||review.status==='complete'?(review.status==='complete'?0:(2*review.total+1)*s.analysis_ms/1000):review.remaining_seconds;
 $('reviewRemaining').hidden=!review.total||review.source==='in_game';$('reviewProgressBar').hidden=review.source==='in_game';
 const minutes=Math.max(1,Math.ceil(remaining/60));
 $('reviewRemaining').textContent=review.status==='complete'?'Review complete':review.status==='stopped'?(review.can_resume?'Completed assessments are kept. Click Resume review to continue.':'Completed assessments are kept.'):`Up to about ${minutes} ${minutes===1?'minute':'minutes'} remaining`;
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
 const issues=review.rows.filter(r=>r.symbol);$('reviewSummary').textContent=review.source==='in_game'?'Original suggestions and scores recorded during play.':(review.engine?review.engine+' · ':'')+(issues.length?`${issues.length} flagged ${issues.length===1?'move':'moves'}`:'No moves flagged');$('reviewSummary').title=review.source==='in_game'?'Scores may come from different engines and thinking times.':'Move labels use approximate engine-specific score-loss thresholds, not calibrated winning probabilities.';
 $('previousIssue').disabled=!issues.some(r=>r.ply<s.ply);$('nextIssue').disabled=!issues.some(r=>r.ply>s.ply);
 const key=JSON.stringify([review.points,s.ply,review.status,review.working_ply,review.rows.map(r=>r.symbol),$('reviewGraph').clientWidth]);if(key===reviewGraphKey)return;reviewGraphKey=key;
 const graph=$('reviewGraph'),width=Math.max(300,graph.clientWidth),span=width-24;graph.setAttribute('viewBox',`0 0 ${width} 160`);graph.replaceChildren();graph.append(node('line',{x1:12,y1:80,x2:width-12,y2:80,class:'review-zero'}));
 const points=review.points.filter(p=>p.score!=null),x=p=>12+span*p.ply/Math.max(1,review.total),y=p=>80-reviewPoint(p.score)*.65;
 if(review.status==='running'){const at=12+span*review.working_ply/Math.max(1,review.total);graph.append(node('line',{x1:at,y1:10,x2:at,y2:150,class:'review-working'}));}
 if(points.length)graph.append(node('polyline',{points:points.map(p=>`${x(p)},${y(p)}`).join(' '),class:'review-line'}));
 for(const p of points){const r=review.rows.find(r=>r.ply===p.ply);const group=node('g',{role:'button',tabindex:0,'aria-label':`Move ${p.ply}: ${reviewPoint(p.score)}${r?.symbol?', '+r.label:''}`});group.append(node('circle',{cx:x(p),cy:y(p),r:9,fill:'transparent'}));group.append(node('circle',{cx:x(p),cy:y(p),r:p.ply===s.ply?5:3.5,class:'review-dot'+(r?.symbol?' flagged':'')+(p.ply===s.ply?' current':'')}));group.onclick=()=>action({action:'navigate',ply:p.ply});group.onkeydown=e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();group.onclick()}};graph.append(group);}
};
// Restore controls after leaving review; the normal render controls their state.
const renderReview=window.renderGameReview;
window.renderGameReview=s=>{$('hintsLabel').hidden=false;$('bookEnabled').closest('label').hidden=false;renderReview(s)};
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

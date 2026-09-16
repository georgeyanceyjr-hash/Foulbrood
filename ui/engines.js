let enginePageOpen=false,engineListKey='',passiveSuggestions=true;
try{passiveSuggestions=!document.cookie.split('; ').includes('foulbrood_passive_suggestions=off')}catch(e){}
function passiveSuggestionMode(s,players=s.players){return !!s.game_review||(s.mode==='play'&&players?.length===2&&players.every(p=>p!=='Human'))}
window.insightSuggestionsVisible=(s,players=s.players)=>s.mode==='analysis'||(passiveSuggestionMode(s,players)?passiveSuggestions:!!s.hints);
$('hints').onchange=()=>{
 const s=serverState||state,enabled=$('hints').checked;
 if(s&&passiveSuggestionMode(s,seatPreviewPlayers||s.players)){
  passiveSuggestions=enabled;
  try{document.cookie=`foulbrood_passive_suggestions=${enabled?'on':'off'}; Max-Age=31536000; Path=/; SameSite=Strict`}catch(e){}
  lastBoardKey='';render(s);
 }else action({action:'hints',enabled,milliseconds:Number($('analysisTime').value)});
};
window.syncEnginePlayers=s=>{
 const choices=[{id:'Human',name:'Human'},...(s.engines||[]).filter(e=>e.connected)];
 const key=JSON.stringify(choices.map(e=>[e.id,e.name]));
 for(const id of ['whitePlayer','blackPlayer']){const select=$(id);if(select.dataset.engines===key)continue;const value=select.value;select.replaceChildren();for(const e of choices){const option=document.createElement('option');option.value=e.id;option.textContent=e.name;select.append(option)}select.value=choices.some(e=>e.id===value)?value:'Human';select.dataset.engines=key;}
 if(seatPreviewPlayers)seatPreviewPlayers=seatPreviewPlayers.map(p=>choices.some(e=>e.id===p)?p:'Human');
};
window.renderEngines=s=>{
 $('engineInsightContent').hidden=false;$('insightEngineStatus').hidden=false;
 $('enginePage').hidden=!enginePageOpen;document.querySelector('main').hidden=enginePageOpen;
 $('engineTab').classList.toggle('active',enginePageOpen);
 if(enginePageOpen){$('playTab').classList.remove('active');$('analysisTab').classList.remove('active');}
 const connected=[...(s.engines||[]).filter(e=>e.connected)];
 const selectedEngine=connected.find(e=>e.id===s.analysis_engine),available=!!selectedEngine,reviewUnsupported=!!s.game_review&&!selectedEngine?.review_supported;
 const choices=s.game_review?connected.filter(e=>e.review_supported):connected;
 const select=$('insightEngine'),choiceKey=JSON.stringify([!!s.game_review,reviewUnsupported?selectedEngine?.id:null,choices.map(e=>[e.id,e.name])]);
 if(select.dataset.choices!==choiceKey){select.replaceChildren();if(s.game_review&&selectedEngine&&!selectedEngine.review_supported){const option=document.createElement('option');option.value=selectedEngine.id;option.textContent=selectedEngine.name+' · no game review';option.disabled=true;select.append(option)}for(const e of choices){const option=document.createElement('option');option.value=e.id;option.textContent=e.name;select.append(option)}if(!choices.length){const option=document.createElement('option');option.textContent=s.game_review?'No game review engine connected':'No engine connected';select.append(option)}select.dataset.choices=choiceKey;}select.disabled=!choices.length;if(available&&document.activeElement!==select&&select.value!==s.analysis_engine)select.value=s.analysis_engine;
 $('insightEngineChoice').hidden=!(choices.length>1||s.game_review&&choices.length>0&&!selectedEngine?.review_supported);
 $('insightEngineName').hidden=!$('insightEngineChoice').hidden||!selectedEngine;$('insightEngineName').textContent=selectedEngine?.name||'';
 const panel=$('engineInsightContent');panel.classList.toggle('engine-disconnected',!available||reviewUnsupported);
 let notice=$('engineDisconnectedNotice');if(!notice){notice=document.createElement('div');notice.id='engineDisconnectedNotice';notice.setAttribute('role','status');panel.append(notice)}
 notice.hidden=available&&!reviewUnsupported;notice.textContent=reviewUnsupported&&available?'Current engine does not support game review.':'No engine connected. Connect an engine in the Engine tab.';
 if(s.game_review&&(!available||reviewUnsupported&&!choices.length))notice.textContent+=' Verified for game review: Mzinga and Nokamute.';
 $('engineReviewWarning').hidden=s.mode==='analysis'||!!s.game_review||!available||!!selectedEngine?.review_supported;$('engineReviewWarning').textContent='This engine does not support game review.';
 $('bookEnabled').closest('label').hidden=!!s.game_review||s.analysis_engine!=='Computer';
 if(s.analysis_engine!=='Computer')$('calculateInstead').hidden=true;
 if(available){$('calculateInstead').disabled=false;}
 for(const id of ['hints','bookEnabled','calculateInstead','analyze'])if(!available||reviewUnsupported)$(id).disabled=true;
 if(!available||reviewUnsupported){$('insight').textContent='';$('stopAnalysis').hidden=true;}
 syncThinkingTimeSelector(s,available,reviewUnsupported);
 const entries=s.engines||[];
 const key=JSON.stringify(entries);if(key===engineListKey)return;engineListKey=key;
 $('engineList').replaceChildren();
 for(const e of entries){
  const row=document.createElement('div');row.className='engine-entry';const info=document.createElement('div'),name=document.createElement('strong'),path=document.createElement('small'),status=document.createElement('span');name.textContent=e.name;path.textContent=e.path;status.textContent=(e.connected?'Connected':'Disconnected')+(e.review_supported?' · Game review supported'+(e.score_format_check==='matched'?' · '+({mzinga:'Mzinga',nokamute:'Nokamute',foulbrood:'FoulBrood'}[e.score_adapter]||e.score_adapter)+' format':''):e.score_adapter?' · Scores available':' · Moves only');status.className='engine-connection'+(e.connected?' connected':'');info.append(name,path,status);
  const controls=document.createElement('div');controls.className='engine-entry-controls';const toggle=document.createElement('button');toggle.textContent=e.connected?'Disconnect':'Connect';toggle.onclick=()=>engineRequest({action:'engine_toggle',id:e.id,connected:!e.connected});controls.append(toggle);
  {const remove=document.createElement('button');remove.textContent='Remove';remove.disabled=e.connected;remove.title=e.connected?'Disconnect before removing':'';remove.onclick=()=>engineRequest({action:'engine_remove',id:e.id});controls.append(remove)}row.append(info,controls);$('engineList').append(row);
 }
};
async function engineRequest(payload){
 if(busy)return;busy=true;actionEpoch++;const status=$(payload.action==='engine_select'?'insightEngineStatus':'engineStatus');status.textContent=(payload.action==='engine_add'||payload.action==='engine_toggle'&&payload.connected)?'Checking connection and game review support…':payload.action==='engine_discover'?'Looking in Downloads, Applications and your other common folders…':'';
 for(const id of ['browseEngine','addEngine','discoverEngines'])$(id).disabled=true;
 try{const response=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-Board-Token':window.BOARD_TOKEN},body:JSON.stringify(payload)});const data=await response.json();if(!response.ok)throw Error(data.error);
 if(data.review_confirmation){busy=false;status.textContent='';confirmViewerAction('Clear review results?',data.review_confirmation,'Continue',{...payload,confirm_review_clear:true});return;}
 if(payload.action==='engine_browse'){if(data.path)$('enginePath').value=data.path;}
 else if(payload.action==='engine_discover'){renderDiscoveredEngines(data);status.textContent='';}
 else{render(data);if(payload.action==='engine_add'){$('enginePath').value='';status.textContent='Engine connected.';}}
 }catch(e){status.textContent=e.message}finally{busy=false;for(const id of ['browseEngine','addEngine','discoverEngines'])$(id).disabled=false}
}
$('engineTab').onclick=async()=>{if(state?.game_review?.status==='running')await action({action:'review_stop'});else if(state?.running)await action({action:'toggle'});else if(state?.job)await action({action:'stop_analysis'});enginePageOpen=true;render(serverState||state)};
for(const id of ['playTab','analysisTab'])$(id).addEventListener('click',()=>{enginePageOpen=false;if(state)renderEngines(state)});
$('browseEngine').onclick=()=>engineRequest({action:'engine_browse'});
$('addEngine').onclick=()=>engineRequest({action:'engine_add',path:$('enginePath').value.trim()});
$('insightEngine').onchange=()=>engineRequest({action:'engine_select',id:$('insightEngine').value});
$('discoverEngines').setAttribute('aria-controls','discoveredEngines');
$('discoverEngines').setAttribute('aria-expanded','false');
$('discoverEngines').onclick=()=>{
 if(!$('discoveredEngines').hidden){$('discoveredEngines').hidden=true;$('discoverEngines').setAttribute('aria-expanded','false');return;}
 engineRequest({action:'engine_discover'});
};
if(state){syncEnginePlayers(state);renderEngines(state)}

$('findEngines').onclick=()=>{const section=$('engineCatalog');section.hidden=!section.hidden;$('findEngines').setAttribute('aria-expanded',String(!section.hidden));if(!section.hidden)section.scrollIntoView({block:'nearest'})};

function renderDiscoveredEngines(data){
 $('discoveredEngines').hidden=false;$('discoverEngines').setAttribute('aria-expanded','true');$('discoveryList').replaceChildren();
 const candidates=data.candidates||[];
 $('discoverySummary').textContent=(candidates.length?'Choose an engine to check and connect.':'No engines found. Try Browse this Mac, or download an engine below.')+(data.limited?' Search stopped at its limit; some folders were not checked.':'')+(data.skipped?' Some folders could not be read.':'');
 for(const e of candidates){
  const row=document.createElement('div');row.className='engine-entry';
  const info=document.createElement('div'),name=document.createElement('strong'),path=document.createElement('small'),button=document.createElement('button');
  name.textContent=e.name;path.textContent=e.path;info.append(name,path);
  const existing=(serverState?.engines||state?.engines||[]).find(saved=>saved.path===e.path);
  button.textContent=existing?.connected?'Connected':'Add & connect';button.disabled=!!existing?.connected;
  button.onclick=async()=>{await engineRequest({action:'engine_add',path:e.path});renderDiscoveredEngines(data)};
  row.append(info,button);$('discoveryList').append(row);
 }
}

function botThoughtGame(s,thought){
 const parts=(s.live_game||s.game||'').split(';'),total=parts.length-3,before=thought.ply-1;
 if(!Number.isInteger(before)||before<0||before>total)return null;
 if(before===total)return parts.join(';');
 const turn=parts[2]?.match(/^(White|Black)\[(\d+)\]$/);if(!turn)return null;
 // Played thoughts belong to an earlier board. Rewind both history and turn;
 // setup roots can start at a later turn, so history length alone is not enough.
 const ply=2*(Number(turn[2])-1)+(turn[1]==='Black'?1:0)-(total-before);
 if(ply<0)return null;
 parts[1]=ply===0&&!parts[0].includes('~')?'NotStarted':'InProgress';
 parts[2]=(ply%2?'Black':'White')+'['+(Math.floor(ply/2)+1)+']';
 return parts.slice(0,before+3).join(';');
}
function insightMoveText(game,move,followBoard=true){
 if(!move)return '—';
 const traditional=followBoard?orientMove(move):move;
 if(notationMode!=='analytic')return traditional;
 if(!game)return traditional+' (traditional)';
 const key=game+'|'+move;
 if(!hintNotationCache.has(key)&&!hintNotationPending.has(key))loadHintNotation(game,move);
 const translated=hintNotationCache.get(key);
 return translated===move+' (traditional)'?traditional+' (traditional)':translated||'Translating…';
}
function botThoughtMove(s,thought){return insightMoveText(thought?botThoughtGame(s,thought):null,thought?.evaluation?.move)}
function botThoughtFields(strip){
 if(strip.thoughtFields)return strip.thoughtFields;
 const field=(className,label)=>{
  const box=document.createElement('div'),caption=document.createElement('span'),value=document.createElement(className==='bot-move'?'button':'strong');
  box.className=className;caption.className='bot-field-label';caption.textContent=label;value.className='bot-field-value';box.append(caption,value);strip.append(box);return {box,caption,value};
 };
 const move=field('bot-move','Suggested move'),score=createPositionScore();score.box.classList.add('bot-position');strip.append(score.box);
 move.value.type='button';move.value.onclick=()=>restoreSuggestionPreview();
 const depth=field('bot-depth','Depth'),time=field('bot-time','Thinking');
 return strip.thoughtFields={move,score,depth,time};
}
const retainedInsights=new Map();
function insightMemory(s,players){
 const engine=s.engines?.find(e=>e.id===s.analysis_engine);
 const key=JSON.stringify([players,s.analysis_engine,engine?.path,engine?.connected]);
 const game=(s.mode==='play'?s.live_game:null)||s.game,parts=game.split(';'),moves=parts.slice(3);
 let memory=retainedInsights.get(s.mode);
 const previous=memory?.game.split(';'),before=previous?.slice(3);
 if(!memory||memory.key!==key||previous[0]!==parts[0]||before.length>moves.length||before.some((move,i)=>move!==moves[i])){
  memory={key,rows:[null,null]};retainedInsights.set(s.mode,memory);
 }
 memory.game=game;
 return memory;
}
function insightSideData(s,side,players){
 if(s.use_recorded_analysis){
  const record=s.recorded_analysis?.[side],identity=record?.engine;
  const engine=identity?{name:identity.name,score_adapter:identity.adapter,connected:true}:null;
  return {engine,evaluation:record?.evaluation,thinking:false,caption:record?`Before move ${record.ply+1}`:'No recorded analysis',moveText:record?insightMoveText(record.game,record.evaluation.move,notationFollowsBoard()):'—',seconds:record?.evaluation.seconds,preview:false};
 }
 const duel=s.mode==='play'&&players.every(p=>p!=='Human');
 const engine=s.engines?.find(e=>e.id===(duel?players[side]:s.analysis_engine));
 if(duel){
  const thought=!s.reviewing&&players[side]===s.players[side]?s.engine_thoughts?.[side]:null;
  const status=s.reviewing?'History':thought?.status==='thinking'?'Thinking':thought?.status==='played'?'Played':thought?.status==='stopped'?'Paused':'Waiting';
  return {engine,evaluation:thought?.evaluation,thinking:thought?.status==='thinking',caption:status+(thought?.ply?' · Move '+thought.ply:''),moveText:botThoughtMove(s,thought),seconds:thought?.elapsed};
 }
 const memory=insightMemory(s,players),active=side===s.side&&!s.reviewing&&!!engine?.connected;
 const evaluation=active&&s.hints?s.hint:null,thinking=active&&s.insight_job==='hint';
 const seconds=thinking?s.search_elapsed:evaluation?.seconds;
 const caption=s.reviewing?'History':!engine?.connected?'No engine connected':!active?'Waiting':thinking?'Thinking':evaluation?'Suggested move':s.hints?'Ready to analyze':'Suggestions off';
 if(evaluation)memory.rows[side]={evaluation:{...evaluation},game:s.game,seconds,caption};
 const previous=!active&&!s.reviewing&&engine?.connected&&s.hints?memory.rows[side]:null;
 if(previous)return {engine,evaluation:previous.evaluation,thinking:false,caption:previous.caption,moveText:insightMoveText(previous.game,previous.evaluation.move,notationFollowsBoard()),seconds:previous.seconds,preview:false};
 return {engine,evaluation,thinking,caption,moveText:insightMoveText(s.game,evaluation?.move,notationFollowsBoard()),seconds,preview:!!evaluation&&canMove()&&!!s.legal?.some(m=>m.move===evaluation.move&&m.to)};
}
function reviewMoveDifference(row){
 const played=positionScoreValue({score:row?.score,side:0},null),preferred=positionScoreValue({score:row?.best_score,side:0},null);
 return played==null||preferred==null?null:(preferred-played)*(row.side===0?1:-1);
}
function rankedReviewMoves(rows,ascending=false){
 return rows.map(row=>({row,difference:reviewMoveDifference(row)})).filter(item=>item.difference!==null).sort((a,b)=>(ascending?a.difference-b.difference:b.difference-a.difference)||a.row.ply-b.row.ply);
}
function renderReviewRanking(s){
 const panel=$('reviewRankingPanel'),list=$('reviewRankingList');
 panel.hidden=!s.game_review||!!editorDraft;
 if(panel.hidden){list.rankingKey=null;return;}
 const order=$('reviewRankingOrder');
 order.textContent=list.rankingAscending?'Smallest':'Largest';
 order.setAttribute('aria-label',list.rankingAscending?'Smallest difference first. Switch to largest first.':'Largest difference first. Switch to smallest first.');
 order.onclick=()=>{list.rankingAscending=!list.rankingAscending;list.scrollTop=0;renderReviewRanking(s)};
 const ranked=rankedReviewMoves(s.game_review.rows,!!list.rankingAscending).map(item=>({...item,move:insightMoveText(botThoughtGame({game:s.review_game||s.game},item.row),item.row.move,notationFollowsBoard())}));
 $('reviewRankingEmpty').hidden=ranked.length>0;
 $('reviewRankingEmpty').textContent=s.game_review.source==='in_game'?'Run a review to compare moves.':'Reviewed moves appear here.';
 const key=JSON.stringify(ranked.map(({row,difference,move})=>[row.ply,row.side,row.label,difference,move]));
 if(list.rankingKey!==key){
  const scroll=list.scrollTop;list.rankingKey=key;list.replaceChildren();list.rankingButtons=[];
  for(const {row,difference,move}of ranked){
   const button=document.createElement('button'),details=document.createElement('span'),caption=document.createElement('span'),notation=document.createElement('strong'),value=document.createElement('strong');
   button.type='button';button.className='review-ranking-row';button.style.setProperty('--rank-color',hintColor(row.side));
   details.className='review-ranking-details';caption.className='review-ranking-caption';caption.textContent=`Move ${row.ply} · ${row.side===0?'White':'Black'}`;
   notation.textContent=move;value.className='review-ranking-value';value.textContent=String(difference);
   details.append(caption,notation);button.append(details,value);button.title=row.label;
   button.setAttribute('aria-label',`${caption.textContent}, ${move}, difference ${difference}`);
   button.onclick=()=>action({action:'navigate',ply:row.ply});list.append(button);list.rankingButtons.push({button,ply:row.ply});
  }
  list.scrollTop=scroll;
 }
 for(const {button,ply}of list.rankingButtons||[]){button.classList.toggle('current',ply===s.ply);if(ply===s.ply)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');}
}
function reviewThoughtFields(strip){
 if(strip.reviewFields)return strip.reviewFields;
 const summary=document.createElement('div'),heading=document.createElement('div'),difference=document.createElement('div');
 summary.className='review-thought-summary';heading.className='review-thought-heading';difference.className='review-thought-difference';
 const differenceLabel=document.createElement('span'),differenceValue=document.createElement('strong');
 differenceLabel.textContent='Difference';difference.append(differenceLabel,differenceValue);summary.append(heading,difference);strip.append(summary);
 const fields={heading,difference,differenceValue};
 for(const [key,label]of [['played','Played'],['preferred','Preferred']]){
  const box=document.createElement('div'),caption=document.createElement('span'),move=document.createElement('strong'),depth=document.createElement('small');
  box.className='review-thought-cell';caption.className='bot-field-label';caption.textContent=label;move.className='bot-field-value';depth.className='review-thought-depth';
  const score=createPositionScore();box.append(caption,move,score.box,depth);strip.append(box);fields[key]={move,score,depth};
 }
 return strip.reviewFields=fields;
}
function renderReviewThought(strip,s,side,engine){
 const fields=reviewThoughtFields(strip),review=s.game_review;
 const available=!!(review.rows.length||review.points.length)||!!engine?.connected&&engine.review_supported;
 const row=available?review.rows.filter(r=>r.side===side&&r.ply<=s.ply).at(-1):null;
 const point=available&&s.ply===0?review.points.find(p=>p.ply===0):null;
 fields.heading.textContent=!available?'Game review unavailable':row?`Move ${row.ply}\n${row.label}`:s.ply===0?'Starting position':'Not reviewed yet';
 fields.heading.classList.toggle('has-reviewed-move',!!row);
 fields.heading.title=row?.label==='Uncertain'?'Comparison inconclusive at this depth.':row?.label==='Missed win'?'The preferred line retains a forced win.':'';
 const difference=reviewMoveDifference(row);
 fields.difference.hidden=difference==null;
 fields.differenceValue.textContent=difference==null?'':String(difference);
 fields.difference.title='Difference from the player’s perspective: positive favors the preferred move; negative favors the played move.';
 const game=row?botThoughtGame({game:s.review_game||s.game},row):null;
 for(const [key,move,score,depth]of [['played',row?.move,row?.score??point?.score,row?.depth??point?.depth],['preferred',row?.alternative,row?.best_score,row?.best_depth]]){
  const field=fields[key];field.move.textContent=row&&move?insightMoveText(game,move,notationFollowsBoard()):'—';field.move.title=field.move.textContent;
  updatePositionScore(field.score,{score,side:0},null,{side});field.depth.textContent=depth==null?'Depth —':'Depth '+depth;
 }
 return !!row&&row.ply===s.ply;
}
window.renderBotThoughts=s=>{
 renderReviewRanking(s);
 const players=seatPreviewPlayers||s.players,duel=s.mode==='play'&&players?.length===2&&players.every(p=>p!=='Human');
 const visible=window.insightSuggestionsVisible(s,players)&&!editorDraft,review=!!s.game_review&&s.game_review.source!=='in_game';
 if(!duel&&!review&&!editorDraft)insightMemory(s,players);
 $('hints').checked=window.insightSuggestionsVisible(s,players);
 $('engineInsightPanel').hidden=!!editorDraft;
 $('analysisControls').hidden=duel;
 $('hintsLabel').hidden=s.mode==='analysis';
 if(duel||review)$('hints').disabled=!!editorDraft;
 for(const id of ['insightEngineChoice','insightEngineName','engineReviewWarning','insightEngineStatus','engineInsightContent'])if(duel)$(id).hidden=true;
 $('engineInsightContent').hidden=duel;
 $('insight').hidden=true;$('insightSuggestion').hidden=true;
 for(let side=0;side<2;side++){
  const color=side===0?'white':'black',strip=$(color+'Thought'),reviewStrip=$(color+'ReviewThought'),bar=$(color+'Clock').closest('.player'),source=$(color+'InsightSource');
  strip.hidden=!visible||review;reviewStrip.hidden=!visible||!review;
  bar.classList.toggle('bot-duel',!editorDraft);bar.classList.toggle('review-insight',!editorDraft&&review);bar.classList.toggle('analysis-insight',s.mode==='analysis');
  source.hidden=!!editorDraft||duel;source.style.visibility=visible?'':'hidden';
  if(!visible){bar.classList.remove('bot-thinking');continue;}
  const data=insightSideData(s,side,players);
  source.textContent='Insight: '+(review?(s.game_review.engine||data.engine?.name||'No engine connected'):(data.engine?.connected?data.engine.name:'No engine connected'));source.title=source.textContent;
  if(review){bar.classList.toggle('bot-thinking',renderReviewThought(reviewStrip,s,side,data.engine));continue;}
  const {engine,evaluation,thinking}=data,fields=botThoughtFields(strip);
  bar.classList.toggle('bot-thinking',thinking);
  fields.move.caption.textContent=data.caption;fields.move.value.textContent=data.moveText;
  fields.move.value.title=evaluation?.move?'Suggested move: '+data.moveText:'Waiting for a suggested move';fields.move.value.disabled=!data.preview;
  fields.depth.value.textContent=evaluation?.depth??'—';fields.time.value.textContent=data.seconds==null?'—':Number(data.seconds||0).toFixed(1)+'s';
  const value=positionScoreValue(evaluation,engine),forced=value===100||value===-100;
  updatePositionScore(fields.score,evaluation,engine,{side,label:forced?positionAssessment(evaluation):'Position'});
 }
};

function syncThinkingTimeSelector(s,available,reviewUnsupported){
 const select=$('analysisTime'),matchTiming=select.querySelector('option[value="-1"]');
 const busy=s.insight_job==='hint'||s.game_review?.status==='running';
 const disabled=!available||reviewUnsupported||!!s.reviewing||busy;
 if(select.disabled!==disabled)select.disabled=disabled;
 const noMatchTiming=s.mode!=='play'||!!s.game_review;
 if(matchTiming.disabled!==noMatchTiming)matchTiming.disabled=noMatchTiming;
 const value=String(s.analysis_ms??2000);
 // Native menus must keep the user's pending choice between server polls.
 if(document.activeElement!==select&&select.value!==value)select.value=value;
 const title=busy?'Stop analysis before changing the thinking time.':'';
 if(select.title!==title)select.title=title;
}

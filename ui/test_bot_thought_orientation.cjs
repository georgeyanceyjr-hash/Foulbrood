const fs=require('fs'),vm=require('vm'),assert=require('assert');
const app=fs.readFileSync(__dirname+'/app.js','utf8');
const engines=fs.readFileSync(__dirname+'/engines.js','utf8');
const element=(tag,attrs={})=>({tag,attrs,dataset:{},style:{setProperty(k,v){this[k]=v}},children:[],scrollTop:0,
 append(...items){this.children.push(...items)},replaceChildren(){this.children=[]},
 classList:{values:new Set(),toggle(k,on){on?this.values.add(k):this.values.delete(k)},remove(k){this.values.delete(k)},add(k){this.values.add(k)},contains(k){return this.values.has(k)}},setAttribute(k,v){this.attrs[k]=v},removeAttribute(k){delete this.attrs[k]},
 closest(){return this.parent}
});
const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,element('div'));return elements.get(id)};
for(const side of ['white','black'])get(side+'Clock').parent=get(side+'Bar');
const requests=[],hintNotationCache=new Map(),hintNotationPending=new Set();
const ctx=vm.createContext({notationMode:'traditional',state:{mode:'play'},editorDraft:null,seatPreviewPlayers:null,passiveSuggestions:true,canMove:()=>false,hintNotationCache,hintNotationPending,
 loadHintNotation(game,move){hintNotationPending.add(game+'|'+move);requests.push({game,move})},
 window:{},document:{createElement:element},$:get,node:element,
 hex:(x,y,r)=>[x,y,r],artwork:(id,x,y)=>element('art',{id,x,y})});
vm.runInContext(app.slice(app.indexOf('let boardRotation='),app.indexOf('function hex(')),ctx);
vm.runInContext(app.slice(app.indexOf('function hintColor('),app.indexOf('function renderSuggestionTrail(')),ctx);
vm.runInContext(app.slice(app.indexOf('function selectedPlayerThought('),app.indexOf('function timeText(')),ctx);
vm.runInContext(app.slice(app.indexOf('function evaluationNumbers('),app.indexOf('function compactInsightNumber(')),ctx);
vm.runInContext(app.slice(app.indexOf('function positionAssessment('),app.indexOf('function boardResultText(')),ctx);
vm.runInContext(engines.slice(engines.indexOf('function passiveSuggestionMode('),engines.indexOf("$('hints').onchange")),ctx);
ctx.insightSuggestionsVisible=ctx.window.insightSuggestionsVisible;
vm.runInContext(engines.slice(engines.indexOf('function botThoughtGame('),engines.indexOf('function syncThinkingTimeSelector(')),ctx);
const forms=['@-','@\\','/@','-@','\\@','@/'],dirs=[[1,0],[0,1],[-1,1],[-1,0],[0,-1],[1,-1]];
const pixels=([q,r])=>[Math.sqrt(3)*40*(q+r/2),60*r];
const turned=([x,y],t,mirror)=>{const a=t*Math.PI/3,c=Math.cos(a),s=Math.sin(a);return [(mirror?-1:1)*(x*c-y*s),x*s+y*c]};
const near=(a,b,label)=>a.forEach((v,i)=>assert(Math.abs(v-b[i])<1e-8,`${label}: ${a} != ${b}`));
let cases=0;
for(const notation of ['traditional','analytic'])for(const side of [0,1])for(let direction=0;direction<6;direction++)for(let t=0;t<6;t++)for(const mirror of [false,true]){
 const piece=side?'bA1':'wA1',reference=side?'wQ':'bQ',move=piece+' '+forms[direction].replace('@',reference);
 const to=[1+dirs[direction][0],1+dirs[direction][1]],from=[-2,0];
 const s={mode:'play',job:'computer',players:['engine-a','engine-b'],side,ply:12,hints:false,game:'Base;InProgress;White[7];'+Array.from({length:12},(_,i)=>i%2?'bQ':'wQ').join(';'),
  pieces:[{id:piece,q:from[0],r:from[1],level:0},{id:reference,q:1,r:1,level:0}],
  legal:[{move,piece,to}],engine_thoughts:[0,1].map(n=>({status:n===side?'thinking':'played',ply:n===side?13:12,evaluation:{move},elapsed:1}))};
 const original=JSON.stringify(s);ctx.state=s;
 vm.runInContext(`notationMode='${notation}';boardRotation=${t};boardMirrored=${mirror}`,ctx);
 const directionPixels=turned(pixels(dirs[direction]),t,mirror);
 const j=dirs.findIndex(d=>pixels(d).every((v,i)=>Math.abs(v-directionPixels[i])<1e-8));
 const analytic=piece.slice(0,2)+' @ '+reference.slice(0,2);
 for(const thought of s.engine_thoughts)hintNotationCache.set(ctx.botThoughtGame(s,thought)+'|'+move,analytic);
 const expected=notation==='analytic'?analytic:piece+' '+forms[j].replace('@',reference);
 for(let poll=0;poll<2;poll++){
  ctx.window.renderBotThoughts(s);
  for(const color of ['white','black']){
   assert.equal(get(color+'Thought').thoughtFields.move.value.textContent,expected,`thought text: ${notation}, side ${side}, rotation ${t}, mirrored ${mirror}`);
   assert.equal(get(color+'Thought').thoughtFields.move.value.title,'Suggested move: '+expected);
  }
  const board=element('svg');ctx.renderOpponentInsight(board,s);
  assert.equal(board.children.length,1);const layer=board.children[0];
  assert(layer.attrs.style.includes(side?'#83bde6':'#d5b675'));
  const ghost=layer.children.find(n=>n.attrs.opacity===.55).children[0];
  near([ghost.attrs.x,ghost.attrs.y],turned(pixels(to),t,mirror),'ghost destination');
  near(layer.children[0].attrs.points.slice(0,2),turned(pixels(from),t,mirror),'source outline');
  const arrow=layer.children.find(n=>n.tag==='line').attrs;
  near([arrow.x1,arrow.y1],turned(pixels(from),t,mirror),'arrow origin');
  const delta=[ghost.attrs.x-arrow.x2,ghost.attrs.y-arrow.y2];
  assert(Math.abs(Math.hypot(...delta)-43)<1e-8,'arrow ends at destination edge');
 }
 assert.equal(JSON.stringify(s),original,'view changes must not alter the engine move or game');cases++;
}
console.log(`PASS: ${cases} engine-thought cases: both colors, six directions, twelve views, both History notations, repeated updates, and matching ghost/arrow coordinates.`);

// Translation needs the pre-move board, including opening/finished/setup turns.
const first={ply:1,evaluation:{move:'wS1'}},second={ply:2,evaluation:{move:'bS1 -wS1'}};
const opening={game:'Base;InProgress;White[2];wS1;bS1 -wS1'};
assert.equal(ctx.botThoughtGame(opening,first),'Base;NotStarted;White[1]');
assert.equal(ctx.botThoughtGame(opening,second),'Base;InProgress;Black[1];wS1');
assert.equal(ctx.botThoughtGame({game:'Base;WhiteWins;Black[2];wS1;bS1 -wS1;wQ wS1-'},{ply:3}),'Base;InProgress;White[2];wS1;bS1 -wS1');
const root='Base~1~9~wQ:0:0:0,bQ:1:0:0~';
assert.equal(ctx.botThoughtGame({game:root+';InProgress;White[10];bS1 bQ-'},first),root+';InProgress;Black[9]');
assert.equal(ctx.botThoughtGame({...opening,live_game:opening.game,game:'Base;NotStarted;White[1]'},second),'Base;InProgress;Black[1];wS1');
assert.equal(ctx.botThoughtGame(opening,{ply:99}),null);
hintNotationCache.clear();hintNotationPending.clear();requests.length=0;
ctx.notationMode='analytic';
for(let poll=0;poll<3;poll++)assert.equal(ctx.botThoughtMove(opening,first),'Translating…');
assert.equal(requests.length,1,'polls must not duplicate a pending translation');
assert.equal(requests[0].game,'Base;NotStarted;White[1]');
const changed={...first,evaluation:{move:'wA1'}};
assert.equal(ctx.botThoughtMove(opening,changed),'Translating…');
hintNotationCache.set('Base;NotStarted;White[1]|wS1','wS');
assert.equal(ctx.botThoughtMove(opening,changed),'Translating…','an old reply must not replace the current suggestion');
hintNotationCache.set('Base;NotStarted;White[1]|wA1','wA');
assert.equal(ctx.botThoughtMove(opening,changed),'wA');
assert.equal(ctx.botThoughtMove(opening,first),'wS','returning to a suggestion uses its own cached translation');
ctx.notationMode='traditional';assert.equal(ctx.botThoughtMove(opening,changed),'wA1');
ctx.notationMode='analytic';
const key=ctx.botThoughtGame(opening,second)+'|'+second.evaluation.move;
hintNotationCache.set(key,second.evaluation.move+' (traditional)');
assert.equal(ctx.botThoughtMove(opening,second),ctx.orientMove(second.evaluation.move)+' (traditional)','unavailable translations use a marked, oriented fallback');
console.log('PASS: pre-move histories, opening/finished/setup turns, translation deduplication, stale replies, switching notation, and explicit fallback.');

// The complete action group (including confirmation) disappears for two bots.
const visibility=app.match(/\$\('playerActions'\)\.hidden=[^;]+;/)[0];
ctx.s={mode:'play',reviewing:false};ctx.finished=false;
for(const players of [['engine-a','engine-b'],['Human','engine-b'],['engine-a','Human'],['Human','Human']]){
 ctx.shownPlayers=players;vm.runInContext(visibility,ctx);assert.equal(get('playerActions').hidden,players.every(p=>p!=='Human'));
}
console.log('PASS: bot-versus-bot hides takeback and confirmation; either human seat retains them.');

// A common display scale must preserve score direction and distinguish unknown from equal.
const external=engine_score=>({source:'external',engine_score,side:1});
assert.equal(ctx.positionScoreValue(external(0),{score_adapter:'mzinga'}),0);
assert.equal(ctx.positionScoreValue(external(1000000),{score_adapter:'mzinga'}),76);
assert.equal(ctx.positionScoreValue(external(-1000000),{score_adapter:'mzinga'}),-76);
assert.equal(ctx.positionScoreValue(external(100),{score_adapter:'nokamute'}),76);
for(const score of [null,undefined,NaN,Infinity])assert.equal(ctx.positionScoreValue(external(score),{score_adapter:'mzinga'}),null);
assert.equal(ctx.positionScoreValue(external(123),{}),null);
for(const sign of [-1,1]){
 assert.equal(ctx.positionScoreValue(external(sign*1e20),{score_adapter:'mzinga'}),sign*99);
 assert.equal(ctx.positionScoreValue({...external(null),engine_forced_winner:sign>0?'White':'Black'},{}),sign*100);
}
assert.equal(ctx.positionScoreValue({source:'foulbrood',score:300,side:1},{}),-76);
assert.equal(ctx.positionScoreValue({source:'foulbrood',score:99995,side:1},{}),-100);
console.log('PASS: Mzinga/Nokamute scales match Game Review; White perspective, unknown scores, finite extremes and forced results are distinct.');

const duel=ctx.state,strip=get('whiteThought'),fields=strip.thoughtFields;
ctx.window.renderBotThoughts(duel);
assert(!get('engineInsightPanel').hidden);assert(!strip.hidden);
assert.equal(strip.thoughtFields,fields,'polls reuse existing fields');
assert.equal(strip.children.length,4,'polls do not duplicate strip contents');
for(const override of [{players:['Human','engine-b']},{players:['Human','Human']},{mode:'analysis'}]){
 ctx.window.renderBotThoughts({...duel,...override,hints:true});assert(!get('engineInsightPanel').hidden);
 assert(!get('whiteThought').hidden&&!get('blackThought').hidden);
}
ctx.editorDraft={};ctx.window.renderBotThoughts({...duel,mode:'analysis'});assert(get('engineInsightPanel').hidden);ctx.editorDraft=null;
ctx.window.renderBotThoughts({...duel,reviewing:true});assert(!get('engineInsightPanel').hidden);
assert.equal(fields.move.value.textContent,'—','browsing history never displays a live thought on the wrong position');
assert.equal(fields.move.caption.textContent,'History');
ctx.seatPreviewPlayers=['Human','engine-b'];ctx.window.renderBotThoughts(duel);assert(!get('engineInsightPanel').hidden);
ctx.seatPreviewPlayers=['new-engine','engine-b'];ctx.window.renderBotThoughts(duel);assert(!get('engineInsightPanel').hidden);
assert.equal(fields.move.value.textContent,'—','changing a player cannot show the old engine thought');
console.log('PASS: stable player-bar fields; sidebar controls remain available across game types, hide in Setup, and stale live thoughts are hidden in History.');

const analyst={id:'analysis',name:'Nokamute',connected:true,review_supported:true,score_adapter:'nokamute'};
const live={legal:[{move:'wQ wS1-',to:[1,0]}],mode:'play',players:['Human','other'],side:0,ply:2,game:'Base;InProgress;White[2];wS1;bS1 -wS1',hints:true,analysis_engine:'analysis',engines:[analyst],hint:{source:'external',engine_score:100,depth:8,move:'wQ wS1-',seconds:2},insight_job:'hint',search_elapsed:1.2};
ctx.notationMode='traditional';ctx.state=live;ctx.seatPreviewPlayers=null;ctx.canMove=()=>true;
let view=ctx.insightSideData(live,0,live.players);assert.equal(view.evaluation,live.hint);assert(view.thinking&&view.preview);assert.equal(view.seconds,1.2);
view=ctx.insightSideData(live,1,live.players);assert(!view.evaluation);assert.equal(view.caption,'Waiting');
view=ctx.insightSideData({...live,hints:false,insight_job:null},0,live.players);assert(!view.evaluation);assert.equal(view.caption,'Suggestions off');
view=ctx.insightSideData({...live,engines:[]},0,live.players);assert(!view.evaluation);assert.equal(view.caption,'No engine connected');
view=ctx.insightSideData({...live,reviewing:true},0,live.players);assert(!view.evaluation);assert.equal(view.caption,'History');
for(const mode of ['play','analysis']){
 const s={...live,mode};ctx.state=s;
 ctx.window.renderBotThoughts(s);assert(!get('whiteThought').hidden&&!get('blackThought').hidden);assert(get('insight').hidden&&get('insightSuggestion').hidden);
 assert.equal(get('whiteThought').thoughtFields.score.value.textContent,'+76');assert.equal(get('blackThought').thoughtFields.score.value.textContent,'—');
 assert(!get('whiteThought').thoughtFields.move.value.disabled);assert(get('blackThought').thoughtFields.move.value.disabled);
 ctx.window.renderBotThoughts({...s,hints:false});assert.equal(get('whiteThought').hidden,mode==='play');assert.equal(get('blackThought').hidden,mode==='play');assert(!get('engineInsightPanel').hidden);assert.equal(get('hintsLabel').hidden,mode==='analysis');
 ctx.window.renderBotThoughts(s);assert(!get('whiteThought').hidden&&!get('blackThought').hidden);
}
ctx.passiveSuggestions=false;ctx.window.renderBotThoughts(duel);assert(get('whiteThought').hidden&&get('blackThought').hidden);ctx.passiveSuggestions=true;
console.log('PASS: human games and Position use the current side’s selected engine; hide/show restores bars without stale opponent values or losing sidebar controls.');

const rows=[
 {ply:1,side:0,move:'wS1',alternative:'wA1',score:0,best_score:300,depth:4,best_depth:5,label:'Mistake',symbol:'?'},
 {ply:2,side:1,move:'bS1 -wS1',alternative:'bQ -wS1',score:-300,best_score:-600,depth:6,best_depth:7,label:'Inaccuracy',symbol:'?!'},
 {ply:3,side:0,move:'wQ wS1-',alternative:'wQ wS1-',score:600,best_score:600,depth:8,best_depth:8,label:'Best move',symbol:''}
];
const reviewed={...live,mode:'analysis',ply:2,game_review:{engine:'Nokamute',rows,points:[{ply:0,score:0}]}};
ctx.state=reviewed;ctx.canMove=()=>false;ctx.window.renderBotThoughts(reviewed);
const whiteReview=get('whiteReviewThought'),blackReview=get('blackReviewThought'),whiteFields=whiteReview.reviewFields,blackFields=blackReview.reviewFields;
assert(!whiteReview.hidden&&!blackReview.hidden);assert(get('whiteThought').hidden&&get('blackThought').hidden);
assert(whiteFields.heading.textContent.startsWith('Move 1'));assert(blackFields.heading.textContent.startsWith('Move 2'));
assert.equal(whiteFields.played.score.value.textContent,'0');assert.equal(whiteFields.preferred.score.value.textContent,'+76');
assert.equal(blackFields.played.score.value.textContent,'-76');assert.equal(blackFields.preferred.score.value.textContent,'-96');
assert.equal(whiteFields.differenceValue.textContent,'76');assert.equal(blackFields.differenceValue.textContent,'20');assert(!blackFields.difference.hidden);
assert.equal(blackFields.preferred.depth.textContent,'Depth 7');assert.equal(blackFields.preferred.move.textContent,ctx.insightMoveText(ctx.botThoughtGame({game:reviewed.game},rows[1]),rows[1].alternative,ctx.notationFollowsBoard()));assert(!/^\d+\. /.test(blackFields.played.move.textContent));
assert.equal(blackFields.preferred.score.box.style['--score-color'],'#83bde6');assert.equal(whiteFields.preferred.score.box.style['--score-color'],'#d5b675');
ctx.window.renderBotThoughts(reviewed);assert.equal(whiteReview.reviewFields,whiteFields);assert.equal(whiteReview.children.length,3);
// A worse preferred continuation remains negative for either player.
const reversedRows=rows.map(r=>({...r,score:r.best_score,best_score:r.score}));
ctx.window.renderBotThoughts({...reviewed,game_review:{...reviewed.game_review,rows:reversedRows}});
assert.equal(whiteFields.differenceValue.textContent,'-76');assert.equal(blackFields.differenceValue.textContent,'-20');
ctx.window.renderBotThoughts(reviewed);
ctx.window.renderBotThoughts({...reviewed,ply:3});assert.equal(whiteFields.differenceValue.textContent,'0');assert(!whiteFields.difference.hidden);
ctx.window.renderBotThoughts({...reviewed,ply:1});assert(blackFields.difference.hidden);assert.equal(blackFields.heading.textContent,'Not reviewed yet');assert.equal(blackFields.played.score.value.textContent,'—');
ctx.window.renderBotThoughts({...reviewed,ply:0});assert(whiteFields.difference.hidden);assert.equal(whiteFields.heading.textContent,'Starting position');assert.equal(whiteFields.played.score.value.textContent,'0');
ctx.window.renderBotThoughts({...reviewed,engines:[]});assert(whiteFields.heading.textContent.startsWith('Move 1'));assert.equal(whiteFields.played.score.value.textContent,'0','saved results remain visible without a connected engine');
ctx.window.renderBotThoughts({...reviewed,game_review:{...reviewed.game_review,rows:[],points:[]},engines:[{...analyst,review_supported:false}]});assert.equal(whiteFields.heading.textContent,'Game review unavailable');assert.equal(whiteFields.played.score.value.textContent,'—');
ctx.passiveSuggestions=false;ctx.window.renderBotThoughts(reviewed);assert(!whiteReview.hidden&&!blackReview.hidden);assert(get('hintsLabel').hidden);ctx.passiveSuggestions=true;
console.log('PASS: review bars show each side’s latest reviewed move through the viewed ply, both comparisons, zero, depths, colors, unknown/unsupported cases, and stable fields.');

// Rankings use exactly the bar differential, highest first; ties use game order.
const rankingRows=[...rows,{...rows[0],ply:4,score:null},{...rows[1],ply:5,score:-600,best_score:-300},{...rows[2],ply:6}];
const unchangedRankingRows=JSON.stringify(rankingRows);
assert.equal(JSON.stringify(ctx.rankedReviewMoves(rankingRows).map(x=>[x.row.ply,x.difference])),JSON.stringify([[1,76],[2,20],[3,0],[6,0],[5,-20]]));
assert.equal(JSON.stringify(rankingRows),unchangedRankingRows);
const rankingState={...reviewed,game_review:{...reviewed.game_review,rows:rankingRows}};
ctx.window.renderBotThoughts(rankingState);
const rankingList=get('reviewRankingList'),rankingPanel=get('reviewRankingPanel');
assert(!rankingPanel.hidden);assert(get('reviewRankingEmpty').hidden);
assert.equal(rankingList.children.length,5);assert.equal(rankingList.children[1].attrs['aria-current'],'step');
assert.equal(get('reviewRankingOrder').textContent,'Largest');
get('reviewRankingOrder').onclick();
assert.equal(get('reviewRankingOrder').textContent,'Smallest');
assert.equal(JSON.stringify(rankingList.rankingButtons.map(item=>item.ply)),JSON.stringify([5,3,6,2,1]));
assert.equal(rankingList.scrollTop,0);assert.equal(rankingList.children[3].attrs['aria-current'],'step');
ctx.window.renderBotThoughts(rankingState);assert.equal(rankingList.rankingButtons[0].ply,5);
get('reviewRankingOrder').onclick();assert.equal(rankingList.rankingButtons[0].ply,1);
const rankingButton=rankingList.children[0];rankingList.scrollTop=70;
ctx.window.renderBotThoughts({...rankingState,ply:3});
assert.equal(rankingList.children[0],rankingButton);assert.equal(rankingList.scrollTop,70);assert.equal(rankingList.children[2].attrs['aria-current'],'step');
let rankingNavigation;ctx.action=p=>rankingNavigation=p;rankingButton.onclick();assert.equal(rankingNavigation.action,'navigate');assert.equal(rankingNavigation.ply,1);
ctx.window.renderBotThoughts({...reviewed,game_review:{...reviewed.game_review,rows:[]}});assert(!get('reviewRankingEmpty').hidden);assert.equal(rankingList.children.length,0);
ctx.window.renderBotThoughts(live);assert(rankingPanel.hidden);
console.log('PASS: review ranking sorts signed player-relative differences, ties, zero and missing scores; click navigation, selection and scroll stability work.');

// Passive display changes must not issue unsupported review hints or start a third bot.
const actions=[],renders=[];ctx.action=p=>actions.push(p);ctx.render=s=>renders.push(s);ctx.serverState=null;
vm.runInContext(engines.slice(engines.indexOf("$('hints').onchange"),engines.indexOf('window.syncEnginePlayers')),ctx);
get('analysisTime').value='2000';
for(const s of [duel,reviewed]){
 ctx.state=s;const before=JSON.stringify(s);
 for(const enabled of [false,true]){
  get('hints').checked=enabled;get('hints').onchange();
  assert.equal(ctx.insightSuggestionsVisible(s),s.mode==='analysis'||enabled);assert.equal(renders.at(-1),s);
  assert.equal(actions.length,0);assert.equal(JSON.stringify(s),before);
 }
}
ctx.state=live;get('hints').checked=false;get('hints').onchange();
assert.equal(JSON.stringify(actions),JSON.stringify([{action:'hints',enabled:false,milliseconds:2000}]));
console.log('PASS: one suggestions checkbox controls all bars; review and bot display toggles preserve running work, while normal hints use the existing analysis action.');

for(const s of [{...live,hints:false},{...live,hints:true},duel,reviewed]){
 for(const enabled of [false,true]){
  ctx.passiveSuggestions=enabled;ctx.window.renderBotThoughts(s);
  for(const side of ['white','black']){
   assert(get(side+'Bar').classList.contains('bot-duel'),'bar layout stays reserved with suggestions off');
   assert.equal(get(side+'Bar').classList.contains('review-insight'),!!s.game_review);
  }
 }
}
console.log('PASS: player bars retain their normal/review dimensions regardless of suggestions visibility.');

// Keep the idle side's last result without treating it as a current-board hint.
ctx.seatPreviewPlayers=null;ctx.state=live;
ctx.insightSideData(live,0,live.players);
const next={...live,side:1,ply:3,game:live.game+';wQ wS1-',hint:null};
let retained=ctx.insightSideData(next,0,next.players);
assert.equal(retained.evaluation.move,live.hint.move);assert.equal(retained.evaluation.depth,8);
assert.equal(retained.seconds,live.search_elapsed);assert(!retained.preview&&!retained.thinking);
assert.equal(retained.caption,'Thinking','idle bar preserves its previous caption exactly');
ctx.window.renderBotThoughts(next);
assert.equal(get('whiteThought').thoughtFields.score.value.textContent,'+76');
assert(get('whiteThought').thoughtFields.move.value.disabled);
const reply={...next,hint:{...live.hint,move:'bQ bS1-',engine_score:-50,depth:9}};
ctx.insightSideData(reply,1,reply.players);
assert.equal(ctx.insightSideData(reply,0,reply.players).evaluation.depth,8);
const third={...reply,side:0,ply:4,game:reply.game+';bQ bS1-',hint:null};
assert.equal(ctx.insightSideData(third,1,third.players).evaluation.depth,9);
assert(!ctx.insightSideData({...third,analysis_engine:'new'},1,third.players).evaluation);
ctx.insightSideData(live,0,live.players);
assert(!ctx.insightSideData({...next,game:'Base;NotStarted;White[1]',ply:0},1,live.players).evaluation);
assert(!ctx.insightSideData(next,0,next.players).evaluation,'reset discards previous-game results');
ctx.insightSideData(live,0,live.players);
assert(!ctx.insightSideData({...next,game:live.game+';wA1 wS1-'},1,next.players).evaluation);
assert(!ctx.insightSideData({...next,reviewing:true},0,next.players).evaluation);
console.log('PASS: idle player retains its own last move/score/depth/time; old suggestions cannot be played, and engine changes, resets and history remain isolated.');

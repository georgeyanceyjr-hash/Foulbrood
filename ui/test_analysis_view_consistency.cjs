const fs=require('fs'),vm=require('vm'),assert=require('assert');
const app=fs.readFileSync(__dirname+'/app.js','utf8'),engines=fs.readFileSync(__dirname+'/engines.js','utf8'),review=fs.readFileSync(__dirname+'/review.js','utf8');
const element=(tag,attrs={})=>({tag,attrs,children:[],dataset:{},style:{setProperty(k,v){this[k]=v}},scrollTop:0,
 append(...items){this.children.push(...items)},replaceChildren(...items){this.children=items},querySelectorAll(){return []},
 classList:{values:new Set(),add(v){this.values.add(v)},remove(v){this.values.delete(v)},toggle(v,on){on?this.values.add(v):this.values.delete(v)}},
 setAttribute(k,v){this.attrs[k]=v},removeAttribute(k){delete this.attrs[k]},closest(){return this.parent}});
const els=new Map(),get=id=>{if(!els.has(id))els.set(id,element('div'));return els.get(id)};
for(const side of ['white','black'])get(side+'Clock').parent=get(side+'Bar');
const game='Base;InProgress;White[3];wS1;bS1 wS1-;wQ -wS1;bQ bS1-';
const rows=[{ply:3,side:0,move:'wQ -wS1',alternative:'wQ wS1/',score:0,best_score:300,depth:6,best_depth:6,label:'Mistake',symbol:'?'},{ply:4,side:1,move:'bQ bS1-',alternative:'bQ /bS1',score:-300,best_score:-600,depth:6,best_depth:6,label:'Inaccuracy',symbol:'?!'}];
const base={mode:'analysis',players:['Human','Human'],analysis_engine:'e',engines:[{id:'e',name:'Test',connected:true,review_supported:true}],game,review_game:game,ply:4,side:0,hints:true,legal:[],pieces:[],timeout_side:null,resigned_side:null};
const ctx=vm.createContext({window:{},state:base,editorDraft:null,seatPreviewPlayers:null,notationMode:'traditional',passiveSuggestions:true,canMove:()=>false,
 document:{createElement:element},$:get,node:element,hex:(x,y,r)=>[x,y,r],artwork:(id,x,y)=>element('art',{id,x,y}),
 notationCache:new Map([[game,game.split(';').slice(3).map((m,i)=>({analytic:'analytic history '+i}))]]),notationPending:new Set(),hintNotationCache:new Map(),hintNotationPending:new Set(),
 loadHintNotation(){throw Error('unexpected uncached hint')},loadNotation(){throw Error('unexpected uncached history')},action(){}});
vm.runInContext(app.slice(app.indexOf('let boardRotation='),app.indexOf('function hex(')),ctx);
vm.runInContext(app.slice(app.indexOf('function hintColor('),app.indexOf('function renderSuggestionTrail(')),ctx);
vm.runInContext(app.slice(app.indexOf('function renderSuggestionTrail('),app.indexOf('function selectedPlayerThought(')),ctx);
vm.runInContext(app.slice(app.indexOf('function evaluationNumbers('),app.indexOf('function compactInsightNumber(')),ctx);
vm.runInContext(app.slice(app.indexOf('function setupLastMoveLabel('),app.indexOf('async function loadNotation(')),ctx);
vm.runInContext(engines.slice(engines.indexOf('function passiveSuggestionMode('),engines.indexOf("$('hints').onchange")),ctx);
ctx.insightSuggestionsVisible=ctx.window.insightSuggestionsVisible;
vm.runInContext(engines.slice(engines.indexOf('function botThoughtGame('),engines.indexOf('function syncThinkingTimeSelector(')),ctx);
vm.runInContext(review.slice(review.indexOf('const reviewMarksCache='),review.indexOf('function reviewIssue(')),ctx);
const forms=['@-','@\\','/@','-@','\\@','@/'],dirs=[[1,0],[0,1],[-1,1],[-1,0],[0,-1],[1,-1]];
const rotate=([q,r],turn,mirror)=>{for(let i=0;i<turn;i++)[q,r]=[-r,q+r];return mirror?[-q-r,r]:[q,r]};
const expectedMove=(move,turn,mirror)=>{const [piece,ref]=move.split(' ');if(!ref)return move;const index=forms.indexOf(ref.replace(/[wb][QABGSLMP][123]?/,'@'));if(index<0)return move;const d=rotate(dirs[index],turn,mirror),next=dirs.findIndex(v=>v[0]===d[0]&&v[1]===d[1]);return piece+' '+forms[next].replace('@',ref.replace(/[-/\\]/g,''))};
let cases=0;
for(const mode of ['review','position'])for(const notation of ['traditional','analytic'])for(const follow of [false,true])for(let turn=0;turn<6;turn++)for(const mirror of [false,true])for(const side of [0,1]){
 const s={...base,side,hint:{move:side?'bQ /bS1':'wQ wS1/',score:100,side,depth:6},game_review:mode==='review'?{rows,points:[]}:null};
 const original=JSON.stringify(s);ctx.state=s;
 vm.runInContext(`notationMode='${notation}';analysisFollowsBoard=${follow};boardRotation=${turn};boardMirrored=${mirror}`,ctx);
 ctx.hintNotationCache.set(game+'|'+s.hint.move,'analytic suggestion '+side);
 for(const row of rows)for(const [kind,move]of [['played',row.move],['preferred',row.alternative]])ctx.hintNotationCache.set(ctx.botThoughtGame({game},row)+'|'+move,`analytic ${kind} ${row.ply}`);
 ctx.window.renderBotThoughts(s);ctx.renderHistory();
 const display=move=>follow?expectedMove(move,turn,mirror):move;
 game.split(';').slice(3).forEach((move,i)=>assert.equal(get('moves').children[i].children[1].textContent,notation==='analytic'?'analytic history '+i:display(move)));
 if(mode==='review'){
  for(const row of rows){const fields=get((row.side?'black':'white')+'ReviewThought').reviewFields;
   assert.equal(fields.played.move.textContent,notation==='analytic'?`analytic played ${row.ply}`:display(row.move));
   assert.equal(fields.preferred.move.textContent,notation==='analytic'?`analytic preferred ${row.ply}`:display(row.alternative));
  }
  const list=get('reviewRankingList');assert.equal(list.rankingButtons[0].ply,3);assert.equal(list.children[0].children[0].children[1].textContent,notation==='analytic'?'analytic played 3':display(rows[0].move));
  assert.equal(list.children[0].children[1].textContent,'76');assert.equal(list.children[1].children[1].textContent,'20');
  const row=rows[side],mark={piece:side?'wA1':'bA1',origin:[0,1],to:[2,-1]};ctx.cacheKey=game+'|'+row.alternative;ctx.mark=mark;
  vm.runInContext('reviewMarksCache.set(cacheKey,mark)',ctx);get('board').replaceChildren();ctx.renderReviewMarks({...s,ply:row.ply});
  const layer=get('board').children[0],ghost=layer.children.find(n=>n.attrs.opacity===.55).children[0];
  const [q,r]=rotate(mark.to,turn,mirror);assert(Math.abs(ghost.attrs.x-Math.sqrt(3)*40*(q+r/2))<1e-8);assert.equal(ghost.attrs.y,60*r);
  assert(layer.attrs.style.includes(side?'#83bde6':'#d5b675'));
 }else{
  const fields=get((side?'black':'white')+'Thought').thoughtFields;
  assert.equal(fields.move.value.textContent,notation==='analytic'?'analytic suggestion '+side:display(s.hint.move));
  const board=element('svg'),piece=side?'bB1':'wB1',to=[2,-1],origin=[0,1];
  const pieces=[{id:piece,q:origin[0],r:origin[1],level:1},{id:'wA3',q:to[0],r:to[1],level:0}];
  ctx.renderSuggestionTrail(board,{...s,pieces},{piece,to,suggestion:true});
  const [q,r]=rotate(to,turn,mirror),[oq,or]=rotate(origin,turn,mirror),outline=board.children[0].children[0].attrs,source=board.children[0].children[1].attrs;
  assert(Math.abs(outline.points[0]-Math.sqrt(3)*40*(q+r/2))<1e-8);assert.equal(outline.points[1],60*r-10);
  assert(Math.abs(source.points[0]-Math.sqrt(3)*40*(oq+or/2))<1e-8);assert.equal(source.points[1],60*or-10);
  assert.equal(outline.stroke,side?'#83bde6':'#d5b675');
  assert(get('reviewRankingPanel').hidden);
 }
 assert.equal(JSON.stringify(s),original);cases++;
}
console.log(`PASS: ${cases} Position/Review combinations: both colors, both notations, follow on/off, six rotations and mirrors; bars, differential list, History and preferred previews agree without changing game data.`);

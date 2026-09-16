const fs=require('fs'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(__dirname+'/app.js','utf8');
const node=(tag,attrs={})=>({tag,attrs,children:[],append(...items){this.children.push(...items)}});
const ctx=vm.createContext({editorDraft:null,node,xy:(q,r)=>[q*70,r*70],hex:(x,y,r)=>`${x},${y},${r}`,artwork:(id,x,y)=>node('art',{id,x,y})});
vm.runInContext(src.slice(src.indexOf('function hintColor('),src.indexOf('function renderSuggestionTrail(')),ctx);
vm.runInContext(src.slice(src.indexOf('function selectedPlayerThought('),src.indexOf('function timeText(')),ctx);
const s={side:1,mode:'play',job:'computer',parallel_insight_allowed:true,hints:true,pieces:[{id:'bA1',q:0,r:0,level:0}],legal:[{move:'bA1 wQ-',piece:'bA1',to:[2,0]}],hint:{move:'bA1 wQ-'}};
let b=node('svg');ctx.renderOpponentInsight(b,s);assert.equal(b.children.length,1);const overlay=b.children[0];assert.equal(overlay.attrs['pointer-events'],'none');assert(!JSON.stringify(overlay).includes('pending-move'));assert(overlay.children.some(n=>n.tag==='line'));
for(const override of [{hints:false},{job:null},{parallel_insight_allowed:false},{reviewing:true},{mode:'analysis'},{hint:null}]){b=node('svg');ctx.renderOpponentInsight(b,{...s,...override});assert.equal(b.children.length,0)}
b=node('svg');ctx.renderOpponentInsight(b,{...s,pieces:[]});assert.equal(b.children.length,1);assert(!b.children[0].children.some(n=>n.tag==='line'));
assert.equal(s.pieces[0].q,0,'preview must not move the actual piece');
console.log('PASS: opponent preview is view-only, handles placements, and clears outside active separate-engine analysis.');

for(const side of [0,1]){
 const duel={...s,players:['a','b'],side,ply:4,hints:false,parallel_insight_allowed:false,engine_thoughts:[]};
 duel.engine_thoughts[side]={status:'thinking',ply:5,evaluation:s.hint};
 b=node('svg');ctx.renderOpponentInsight(b,duel);assert.equal(b.children.length,1);
 assert(b.children[0].attrs.style.includes(side===0?'#d5b675':'#83bde6'));
 duel.engine_thoughts[side].ply=3;b=node('svg');ctx.renderOpponentInsight(b,duel);assert.equal(b.children.length,0,'old turn is not previewed');
}
console.log('PASS: bot duel shows current White thought in gold and Black in blue, without needing hints.');

const self={...s,players:['Human','Computer'],analysis_engine:'Computer',side:1,ply:3,parallel_insight_allowed:false,engine_thoughts:[null,{status:'thinking',ply:4,evaluation:s.hint}]};
assert(ctx.selectedPlayerThought(self));b=node('svg');ctx.renderOpponentInsight(b,self);assert.equal(b.children.length,1);assert(b.children[0].attrs.style.includes('#83bde6'));
assert.equal(ctx.selectedPlayerThought({...self,analysis_engine:'other'}),null);
assert.equal(ctx.selectedPlayerThought({...self,hints:false}),null);
console.log('PASS: selected player engine shares live thoughts and blue preview against a human.');

vm.runInContext(src.slice(src.indexOf('function renderSuggestionTrail('),src.indexOf('function selectedPlayerThought(')),ctx);
for(const [mode,players,side,color]of [['play',['Human','Human'],0,'#d5b675'],['play',['Human','Human'],1,'#83bde6'],['analysis',['Human','Human'],1,'#83bde6'],['play',['Computer','Human'],1,'#83bde6']]){
 b=node('svg');ctx.renderSuggestionTrail(b,{...s,mode,players,side},{...s.legal[0],suggestion:true});
 assert.equal(b.children[0].children[0].attrs.stroke,color);
 assert(b.children[0].children.filter(n=>n.attrs.stroke).every(n=>n.attrs.stroke===color));
}
console.log('PASS: all own-turn suggestions use White gold/Black blue in Play and Analysis.');

for(const side of [0,1])for(const ownEngine of [false,true]){
 const player=side===0?['Computer','Human']:['Human','Computer'];
 const game={...s,players:player,side,ply:3,analysis_engine:ownEngine?'Computer':'other',engine_thoughts:[]};
 game.engine_thoughts[side]={status:'thinking',ply:4,evaluation:s.hint};
 b=node('svg');ctx.renderOpponentInsight(b,game);assert.equal(b.children.length,1);
 assert(b.children[0].attrs.style.includes(side===0?'#d5b675':'#83bde6'));
}
console.log('PASS: same-engine and separate-engine analysis use the moving player’s color, including a White bot against a human.');
const review=fs.readFileSync(__dirname+'/review.js','utf8');
ctx.$=()=>b;vm.runInContext(review.slice(review.indexOf('const reviewMarksCache='),review.indexOf('function reviewIssue(')),ctx);
for(const side of [0,1]){
 const game={game:'review-'+side,ply:2,side:1-side,pieces:[],game_review:{rows:[{ply:2,side,symbol:'?',move:'actual',alternative:'better'}]}};
 // Pillbug moves can relocate the opponent’s piece: color follows the mover, not the bug.
 ctx.key=game.game+'|better';ctx.mark={piece:side===0?'bA1':'wA1',origin:[0,0],to:[2,0]};
 vm.runInContext('reviewMarksCache.set(key,mark)',ctx);
 b=node('svg');b.querySelectorAll=()=>[];ctx.renderReviewMarks(game);
 assert(b.children[0].attrs.style.includes(side===0?'#d5b675':'#83bde6'));
}
console.log('PASS: game-review preferred moves use the reviewed player’s color, including opponent-piece relocation.');

// The suggestions switch also hides bot and review board marks.
ctx.insightSuggestionsVisible=()=>false;
b=node('svg');ctx.renderOpponentInsight(b,self);assert.equal(b.children.length,0);
let cleared=false;b=node('svg');b.querySelectorAll=()=>[{remove(){cleared=true}}];
ctx.renderReviewMarks({game:'review-0',ply:2,game_review:{rows:[{ply:2,side:0,symbol:'?',move:'actual',alternative:'better'}]}});
assert(cleared);assert.equal(b.children.length,0);
console.log('PASS: suggestions off clears board overlays together with the insight bars.');

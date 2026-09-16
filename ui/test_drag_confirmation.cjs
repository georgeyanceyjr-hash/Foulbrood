const fs=require('fs'),vm=require('vm'),assert=require('assert');
const handlers={},win={},sent=[],board={setAttribute(){},classList:{remove(){},add(){}},getScreenCTM:()=>({inverse:()=>({})}),getBoundingClientRect:()=>({left:-100,top:-100,right:300,bottom:300})};
let hovered=null;
const ctx=vm.createContext({editorDraft:null,pendingMove:null,pieceDrag:null,dragGhost:null,ignoreDropClick:false,selected:null,lastBoardKey:'',expandedStack:null,busy:false,state:{game:'original',mode:'analysis',pieces:[],legal:[{piece:'wA1',to:[1,0],move:'wA1 bQ-'}]},canMove:()=>true,renderBoard(){},removeDragGhost(){},hideStack(){},pick(id){ctx.selected=id},xy:(q,r)=>[q*60,r*60],node:()=>({style:{},append(){},remove(){}}),artwork(){},play:m=>sent.push(m),$:()=>board,DOMPoint:class{constructor(x,y){this.x=x;this.y=y}matrixTransform(){return this}},document:{addEventListener:(n,f)=>(handlers[n]??=[]).push(f),elementFromPoint:()=>hovered,body:{append(){}}},window:{addEventListener:(n,f)=>win[n]=f}});
const src=fs.readFileSync(__dirname+'/app.js','utf8');vm.runInContext(src.slice(src.indexOf('function reserveActionPiece('),src.indexOf('function pick(')),ctx);vm.runInContext(src.slice(src.indexOf('// Dragging stages')),ctx);
const target=kind=>({dataset:{piece:'wA1'},closest:sel=>kind==='piece'&&(sel==='.tile,.reserve button')?target('piece'):kind==='pending'&&sel==='.pending-move'?{}:null});
function emit(name,kind='empty',x=0,y=0){const e={target:target(kind),button:0,pointerId:1,clientX:x,clientY:y,preventDefault(){},stopPropagation(){},stopImmediatePropagation(){}};for(const f of handlers[name]||[])f(e)}
function drop(){emit('pointerdown','piece');emit('pointermove','empty',60,0);emit('pointerup','empty',60,0);assert(ctx.pendingMove);assert.equal(ctx.state.game,'original');emit('click','pending',60,0)}
drop();assert.equal(sent.length,0,'drop click must not confirm');emit('pointerdown','empty');emit('click','empty');assert.equal(ctx.pendingMove,null);assert.equal(ctx.selected,null);assert.equal(sent.length,0);
drop();emit('pointerdown','pending',60,0);emit('click','pending',60,0);assert.deepStrictEqual(sent,['wA1 bQ-']);assert.equal(ctx.pendingMove,null);
emit('pointerdown','piece');emit('pointerup','piece');emit('click','piece');assert.equal(ctx.pendingMove,null);assert.equal(sent.length,1,'simple click must never move');
emit('pointerdown','piece');emit('pointerup','piece');emit('click','piece');assert.equal(ctx.selected,null,'second click deselects');assert.equal(sent.length,1);
emit('pointerdown','piece');emit('pointerup','piece');emit('click','piece');
assert.equal(ctx.selected,'wA1');emit('pointermove','empty',60,0);assert.equal(ctx.selected,'wA1','clicked selection survives leaving the piece');
emit('pointerdown','empty',60,0);emit('pointerup','empty',60,0);emit('click','pending',60,0);assert(ctx.pendingMove);assert.equal(sent.length,1,'destination click only previews');
emit('pointerdown','pending',60,0);emit('click','pending',60,0);assert.equal(sent.length,2,'third click confirms');
emit('pointerdown','piece');emit('pointermove','empty',250,250);emit('pointerup','empty',250,250);emit('click');assert.equal(ctx.pendingMove,null);assert.equal(ctx.selected,null);
drop();win.blur();assert.equal(ctx.pendingMove,null);assert.equal(sent.length,2);
console.log('PASS: legal drop previews only; later click confirms once; outside click/invalid drop/blur cancel; piece click selects persistently; destination click previews; third click confirms.');

ctx.state.hint={move:'wA1 bQ-'};
vm.runInContext('stageMove(state.legal[0])',ctx);
vm.runInContext('cancelPendingMove()',ctx);
assert.equal(ctx.state.hint.move,'wA1 bQ-','canceling preview retains the engine suggestion');
assert.equal(ctx.pendingMove,null);

ctx.state.hint={move:'wA1 bQ-'};
vm.runInContext('cancelPendingMove()',ctx);

ctx.suggestionPreviewContext=null;ctx.suggestionPreviewDismissed=false;
ctx.state.hints=true;ctx.selected=null;ctx.pendingMove=null;
vm.runInContext('syncAutomaticPreview()',ctx);
assert(ctx.pendingMove?.suggestion,'suggestions automatically stage the piece');
const count=sent.length;
vm.runInContext('syncAutomaticPreview()',ctx);assert.equal(sent.length,count,'polling must never commit preview');
emit('pointerdown','piece');emit('pointerup','piece');emit('click','piece');
assert.equal(ctx.pendingMove,null);assert.equal(ctx.selected,'wA1','one click switches from preview to another piece');
vm.runInContext('syncAutomaticPreview()',ctx);assert.equal(ctx.pendingMove,null,'polling must not override player choice');
ctx.state.hints=false;vm.runInContext('syncAutomaticPreview()',ctx);
ctx.selected=null;ctx.state.hints=true;vm.runInContext('syncAutomaticPreview()',ctx);
assert(ctx.pendingMove?.suggestion,'turning suggestions back on previews again');
emit('pointerdown','pending');emit('click','pending');assert.equal(sent.length,count+1,'clicking auto preview commits once');
ctx.suggestionPreviewDismissed=false;vm.runInContext('syncAutomaticPreview()',ctx);
ctx.state.hints=false;vm.runInContext('syncAutomaticPreview()',ctx);assert.equal(ctx.pendingMove,null,'turning suggestions off removes preview');
console.log('PASS: auto preview, single-click alternative selection, no polling hijack, off/on, and explicit commit.');

ctx.state.hints=true;ctx.state.analysis_engine='first';ctx.selected=null;
vm.runInContext('syncAutomaticPreview();cancelPendingMove()',ctx);
assert(ctx.suggestionPreviewDismissed);
ctx.state.analysis_engine='second';ctx.state.hint=null;
vm.runInContext('syncAutomaticPreview()',ctx);
assert.equal(ctx.pendingMove,null);assert.equal(ctx.suggestionPreviewDismissed,false);
ctx.state.hint={move:'wA1 bQ-'};vm.runInContext('syncAutomaticPreview()',ctx);
assert(ctx.pendingMove?.suggestion,'new engine suggestion appears after previous preview was dismissed');
console.log('PASS: engine switching resets preview dismissal and waits for the new suggestion.');

vm.runInContext('cancelPendingMove()',ctx);const beforeRestore=sent.length;
vm.runInContext('restoreSuggestionPreview()',ctx);assert(ctx.pendingMove?.suggestion);
vm.runInContext('restoreSuggestionPreview()',ctx);assert(ctx.pendingMove?.suggestion,'repeated click keeps preview visible');
assert.equal(sent.length,beforeRestore,'restore never plays the move');
console.log('PASS: move text restores preview without toggling off or playing.');

ctx.pendingMove=null;ctx.selected=null;ctx.suggestionPreviewDismissed=false;
const changedSuggestion={piece:'wB1',to:[2,0],move:'wB1 bQ/'};ctx.state.legal.push(changedSuggestion);
vm.runInContext('syncAutomaticPreview()',ctx);
ctx.state.hint={move:changedSuggestion.move};vm.runInContext('syncAutomaticPreview()',ctx);
assert.equal(ctx.pendingMove.move,changedSuggestion.move,'live preview follows updated engine suggestion');
emit('pointerdown','pending');ctx.state.hint={move:'wA1 bQ-'};vm.runInContext('syncAutomaticPreview()',ctx);
assert.equal(ctx.pendingMove.move,changedSuggestion.move,'do not swap move during confirmation press');
vm.runInContext('cancelPendingMove();stageMove(state.legal[0])',ctx);
ctx.state.hint={move:changedSuggestion.move};vm.runInContext('syncAutomaticPreview()',ctx);
assert.equal(ctx.pendingMove.move,'wA1 bQ-','manual staged move is preserved');
console.log('PASS: live suggestions update preview, preserve manual moves, and freeze during confirmation.');

for(const name of ['analyze','pause','analysisTab','analysisTime']){
 vm.runInContext('stageMove(state.legal[0],true)',ctx);
 let blocked=false;const e={button:0,target:{closest(selector){return selector==='button,input,select,label,a,summary,[role=button]'?{id:name}:null}},preventDefault(){blocked=true},stopImmediatePropagation(){blocked=true}};
 handlers.pointerdown[0](e);handlers.click[0](e);
 assert.equal(blocked,false,name+' must receive its first click');assert.equal(ctx.pendingMove,null);
 vm.runInContext('stageMove(state.legal[0],true)',ctx);handlers.click[0](e);
 assert.equal(blocked,false,name+' keyboard activation must pass through');assert.equal(ctx.pendingMove,null);
}
console.log('PASS: sidebar controls work on first pointer or keyboard click during preview.');

// Analyze explicitly restores a dismissed preview; polling alone must not do so.
const analysisRequests=[];ctx.action=p=>analysisRequests.push(p);board.value='2000';
ctx.state.mode='analysis';ctx.state.game_review=null;ctx.state.insight_job=null;ctx.state.hints=true;ctx.state.hint={move:changedSuggestion.move};
vm.runInContext('cancelPendingMove();toggleAnalysis()',ctx);
assert(ctx.pendingMove?.suggestion);assert.equal(ctx.pendingMove.move,changedSuggestion.move);assert.equal(analysisRequests.at(-1).action,'analyze');
vm.runInContext('cancelPendingMove();syncAutomaticPreview()',ctx);assert.equal(ctx.pendingMove,null);
ctx.selected='wA1';vm.runInContext('toggleAnalysis()',ctx);assert.equal(ctx.selected,null);assert(ctx.pendingMove?.suggestion);
ctx.state.insight_job='hint';vm.runInContext('cancelPendingMove();toggleAnalysis()',ctx);assert(ctx.pendingMove?.suggestion);assert.equal(analysisRequests.at(-1).action,'stop_analysis');
ctx.state.insight_job=null;ctx.state.hint=null;vm.runInContext('cancelPendingMove();toggleAnalysis()',ctx);assert.equal(ctx.suggestionPreviewDismissed,false);assert.equal(ctx.pendingMove,null);
ctx.state.hint={move:changedSuggestion.move};vm.runInContext('syncAutomaticPreview()',ctx);assert(ctx.pendingMove?.suggestion,'new result appears after Analyze even if no cached result was available');
const beforeAnalyzeMoves=sent.length;vm.runInContext('toggleAnalysis()',ctx);assert.equal(sent.length,beforeAnalyzeMoves,'Analyze never plays a suggested move');
ctx.busy=true;const beforeBusy=analysisRequests.length;vm.runInContext('cancelPendingMove();toggleAnalysis()',ctx);assert.equal(analysisRequests.length,beforeBusy);assert.equal(ctx.pendingMove,null);ctx.busy=false;
console.log('PASS: Analyze restores dismissed/overridden suggestions, waits for missing results, preserves stop behavior, and never commits a move.');

ctx.state.mode='play';ctx.state.game_review=null;ctx.state.insight_job=null;
ctx.state.hints=true;ctx.state.hint={move:changedSuggestion.move};
vm.runInContext('cancelPendingMove();toggleAnalysis()',ctx);
assert(ctx.pendingMove?.suggestion,'Play Analyze restores a dismissed suggestion');
assert.equal(ctx.pendingMove.move,changedSuggestion.move);assert.equal(analysisRequests.at(-1).action,'analyze');
vm.runInContext('cancelPendingMove();syncAutomaticPreview()',ctx);assert.equal(ctx.pendingMove,null,'Play polling still respects dismissal');
ctx.selected='wA1';vm.runInContext('toggleAnalysis()',ctx);assert.equal(ctx.selected,null);assert(ctx.pendingMove?.suggestion);
ctx.state.hint=null;vm.runInContext('cancelPendingMove();toggleAnalysis()',ctx);assert.equal(ctx.suggestionPreviewDismissed,false);assert.equal(ctx.pendingMove,null);
ctx.state.hint={move:changedSuggestion.move};vm.runInContext('syncAutomaticPreview()',ctx);assert(ctx.pendingMove?.suggestion);
const beforePlayAnalyze=sent.length;vm.runInContext('toggleAnalysis()',ctx);assert.equal(sent.length,beforePlayAnalyze,'Play Analyze never commits a move');
console.log('PASS: Play Analyze restores dismissed suggestions and waits for fresh results without playing a move.');

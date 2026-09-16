const fs=require('fs'),vm=require('vm'),assert=require('assert');
const engineCode=fs.readFileSync(__dirname+'/engines.js','utf8'),appCode=fs.readFileSync(__dirname+'/app.js','utf8');
const calls=[],ctx=vm.createContext({notationFollowsBoard:()=>true,insightMoveText:(game,move,follow)=>{calls.push({game,move,follow});return 'oriented '+move},renderOpponentInsight:(board,s)=>calls.push(s)});
vm.runInContext(engineCode.slice(engineCode.indexOf('function insightSideData('),engineCode.indexOf('function reviewMoveDifference(')),ctx);
vm.runInContext(appCode.slice(appCode.indexOf('function renderRecordedInsight('),appCode.indexOf('function hintColor(')),ctx);
for(const side of [0,1]){
 const record={side,ply:side,game:'captured-position',engine:{name:'Recorded engine',adapter:'mzinga'},evaluation:{move:side?'bS1 wS1-':'wS1',seconds:7,depth:5,source:'external',engine_score:1200}};
 const s={mode:'analysis',game_review:{source:'in_game'},use_recorded_analysis:true,ply:side,recorded_analysis:side?[null,record]:[record,null]};
 const data=ctx.insightSideData(s,side,[]);assert.equal(data.engine.name,'Recorded engine');assert.equal(data.engine.score_adapter,'mzinga');assert.equal(data.seconds,7);assert.equal(data.thinking,false);assert.equal(data.preview,false);assert.equal(data.caption,`Before move ${side+1}`);
 assert.equal(calls.at(-1).game,'captured-position');assert.equal(calls.at(-1).follow,true,'recorded notation follows current board view');
 ctx.renderRecordedInsight({},s);assert.equal(calls.at(-1).engine_thoughts[side].evaluation.move,record.evaluation.move);
 assert.equal(calls.at(-1).ply,side);assert.equal(calls.at(-1).game_review.source,'in_game');
 const before=calls.length;ctx.renderRecordedInsight({},{...s,ply:side+1});assert.equal(calls.length,before,'old opposite-side suggestion must not draw on another position');
 assert.equal(ctx.insightSideData(s,1-side,[]).caption,'No recorded analysis');
}
console.log('PASS: recorded insights use original engines, position and timing; notation follows the board, preview is view-only and missing positions remain blank.');

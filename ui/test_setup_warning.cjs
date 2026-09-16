const fs=require('fs'),vm=require('vm'),assert=require('assert');
const app=fs.readFileSync(__dirname+'/app.js','utf8');
const confirmations=[],actions=[],toasts=[];
const ctx=vm.createContext({editorDraft:null,editorTool:null,serverState:null,confirmViewerAction:(...args)=>confirmations.push(args),action:async p=>actions.push(p),toast:m=>toasts.push(m),$:()=>({}),render(){}});
vm.runInContext(app.slice(app.indexOf('async function applySetupPosition('),app.indexOf("$('applySetup').onclick=")),ctx);
async function check(engines,history=0){
 confirmations.length=actions.length=toasts.length=0;
 ctx.serverState={game:'Base+MLP;NotStarted;White[1]',engines,review_total:history,analysis_engine:'other'};
 ctx.editorDraft={pieces:[{id:'wQ',q:0,r:0,level:0},{id:'bQ',q:1,r:0,level:0}],side:0,turn:5,last:null};
 await ctx.applySetupPosition();
}
(async()=>{
 for(const engines of [[],[{id:'other',connected:true,review_supported:true}],[{id:'Computer',connected:false}]]){
  await check(engines);assert.equal(actions.length,0);assert.equal(confirmations.length,1);assert(confirmations[0][1].includes('No connected engine'));assert.equal(confirmations[0][2],'Use position');assert.equal(confirmations[0][3].action,'setup_position');
 }
 await check([{id:'Computer',connected:true},{id:'other',connected:true}]);assert.equal(confirmations.length,0);assert.equal(actions.length,1,'a capable connected engine prevents warning even if not selected');
 await check([{id:'other',connected:true}],12);assert.equal(confirmations.length,1);assert(confirmations[0][1].includes('erase the current move history'));assert(confirmations[0][1].includes('No connected engine'));
 await check([{id:'Computer',connected:true}],12);assert(confirmations[0][1].includes('erase the current move history'));assert(!confirmations[0][1].includes('No connected engine'));
 ctx.serverState.analysis_review_available=true;confirmations.length=0;await ctx.applySetupPosition();
 assert(confirmations[0][1].includes('game review'));assert.equal(confirmations[0][3].confirm_review_clear,true,'one combined setup confirmation also approves replacing the review');
 confirmations.length=actions.length=0;ctx.editorDraft.last={piece:'wQ',kind:'moved',from:null};await ctx.applySetupPosition();assert.equal(confirmations.length,0);assert.equal(actions.length,0);assert(toasts.at(-1).includes('previous hex'));
 console.log('PASS: Setup warns with no capable connected engine, combines history warning, permits confirmation, respects another available engine and validates last move first.');
})().catch(e=>{console.error(e);process.exitCode=1});

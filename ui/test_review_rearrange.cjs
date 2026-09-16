const fs=require('fs'),vm=require('vm'),assert=require('assert');
const app=fs.readFileSync(__dirname+'/app.js','utf8'),calls=[];
const position={mode:'analysis',game:'Base;InProgress;Black[4]',side:1,pieces:[{id:'wQ',q:0,r:0,level:0}],analysis_review_available:true};
const ctx=vm.createContext({busy:false,serverState:{...position,game_review:{status:'running'}},editorDraft:null,
 action:async p=>{calls.push(p.action);return position},$:()=>({setAttribute(){}}),redrawSetup(){}});
vm.runInContext(app.slice(app.indexOf('async function openPositionSetup('),app.indexOf('async function importSetupPosition(')),ctx);
(async()=>{
 await ctx.openPositionSetup(true);
 assert.deepEqual(calls,['review_exit','stop_analysis'],'retain review before opening the editor');
 assert.equal(ctx.editorDraft.side,1);assert.equal(ctx.editorDraft.turn,4);
 assert.equal(JSON.stringify(ctx.editorDraft.pieces),JSON.stringify(position.pieces));
 ctx.editorDraft.pieces[0].q=5;assert.equal(position.pieces[0].q,0,'editing the draft cannot modify the reviewed board');
 calls.length=0;ctx.serverState=position;await ctx.openPositionSetup(true);
 assert.deepEqual(calls,['stop_analysis'],'Position uses the existing path');
 ctx.serverState={...position,game_review:{}};ctx.editorDraft=null;ctx.action=async()=>undefined;
 await ctx.openPositionSetup(true);assert.equal(ctx.editorDraft,null,'failed review exit must not open setup');
 console.log('PASS: rearrange reviewed position retains review, uses viewed board, and isolates draft edits.');
})().catch(e=>{console.error(e);process.exitCode=1});

const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(__dirname+'/app.js','utf8'),prompts=[],requests=[],errors=[];
const position={game:'Base;InProgress;White[3]',side:0,pieces:[{id:'wQ',q:0,r:0,level:0}],last_move:null};
const ctx=vm.createContext({busy:false,editorDraft:null,pendingMove:null,selected:null,editorTool:null,window:{BOARD_TOKEN:'test'},
 confirmViewerAction:(...args)=>prompts.push(args),redrawSetup(){},toast:m=>errors.push(m),
 fetch:async(url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,json:async()=>({position})}}});
vm.runInContext(source.slice(source.indexOf('async function importSetupPosition('),source.indexOf("$('setupFromAnalysis').onclick=")),ctx);
(async()=>{
 for(const from of ['analysis','play']){
  const original={pieces:[{id:'bQ',q:2,r:0,level:0}],side:1,turn:3,last:null};ctx.editorDraft=original;
  const count=requests.length;await ctx.importSetupPosition(from);
  assert.equal(requests.length,count,'no import before confirmation');assert.equal(ctx.editorDraft,original);
  const prompt=prompts.at(-1);assert(prompt[1].includes('review remain unchanged'));assert.equal(typeof prompt[3],'function');
  await prompt[3]();assert.equal(requests.at(-1).source,from);assert.equal(ctx.editorDraft.pieces[0].id,'wQ');
  ctx.editorDraft.pieces[0].q=5;assert.equal(position.pieces[0].q,0,'source game is not edited');
 }
 ctx.editorDraft={pieces:[]};const count=prompts.length;await ctx.importSetupPosition('analysis');assert.equal(prompts.length,count);
 const original=ctx.editorDraft;ctx.fetch=async()=>({ok:false,json:async()=>({error:'Import failed'})});await ctx.importSetupPosition('play',true);assert.equal(ctx.editorDraft,original);assert.equal(errors.at(-1),'Import failed');
 console.log('PASS: both Setup imports wait before replacing an arrangement, leave source games intact, and preserve drafts on failure.');
})().catch(e=>{console.error(e);process.exitCode=1});

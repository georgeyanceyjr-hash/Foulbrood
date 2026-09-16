const fs=require('fs'),vm=require('vm'),assert=require('assert');
const app=fs.readFileSync(__dirname+'/app.js','utf8'),engines=fs.readFileSync(__dirname+'/engines.js','utf8');
const requests=[],prompts=[],renders=[],elements=new Map();let response;
const get=id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id)};
const ctx=vm.createContext({busy:false,actionEpoch:0,window:{BOARD_TOKEN:'test'},state:{mode:'analysis',revision:2},editorDraft:{},$:get,
 fetch:async(url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,json:async()=>response}},
 confirmViewerAction:(...args)=>prompts.push(args),render:s=>renders.push(s),toast:m=>{throw Error(m)}});
vm.runInContext(app.slice(app.indexOf('async function action('),app.indexOf('function canMove(')),ctx);
vm.runInContext(engines.slice(engines.indexOf('async function engineRequest('),engines.indexOf("$('engineTab').onclick")),ctx);
(async()=>{
 for(const name of ['load','load_link','setup_position','review_start','open_analysis','move','undo']){
  response={review_confirmation:'Existing review will be replaced.'};const payload={action:name,text:'example',milliseconds:2000};
  const before=renders.length;await ctx.action(payload);
  assert.equal(renders.length,before);assert.equal(ctx.busy,false);assert.equal(prompts.at(-1)[3].confirm_review_clear,true);assert.equal(prompts.at(-1)[3].action,name);
  response={mode:'analysis'};await ctx.action(prompts.at(-1)[3]);assert.equal(requests.at(-1).confirm_review_clear,true);assert.equal(renders.length,before+1);
 }
 vm.runInContext(app.slice(app.indexOf("$('loadLink').onclick="),app.indexOf("$('loadLink').onclick=")+app.slice(app.indexOf("$('loadLink').onclick=")).indexOf('\n};')+4),ctx);
 get('gameLink').value='https://hivegame.com/game/test';
 for(const existing of [{review_total:80,pieces:[]},{review_total:0,pieces:[{id:'wQ'}]},{analysis_review_available:true}]){
  ctx.state={mode:'analysis',...existing};const count=requests.length;
  await get('loadLink').onclick();assert.equal(requests.length,count,'no import or download before confirmation');
  const prompt=prompts.at(-1);assert.equal(prompt[0],'Replace game and history?');assert(prompt[1].includes('history'));assert(prompt[1].includes('review results'));
  assert.equal(prompt[3].url,get('gameLink').value);assert.equal(prompt[3].confirm_review_clear,true);
  response={mode:'analysis'};await ctx.action(prompt[3]);assert.equal(requests.length,count+1);assert.equal(requests.at(-1).action,'load_link');
 }
 ctx.state={mode:'analysis',review_total:0,pieces:[]};const promptCount=prompts.length;response={mode:'analysis'};
 await get('loadLink').onclick();assert.equal(prompts.length,promptCount,'empty board needs no replacement warning');assert.equal(get('loadLink').disabled,false);
 console.log('PASS: hivegame link import warns before fetching when history, setup or retained review exists; accepted URL is preserved and empty board imports directly.');
 response={review_confirmation:'Clear retained review?'};await ctx.engineRequest({action:'engine_remove',id:'test'});assert.equal(prompts.at(-1)[3].id,'test');assert.equal(prompts.at(-1)[3].confirm_review_clear,true);
 let onClose;ctx.window.addEventListener=(name,fn)=>{if(name==='beforeunload')onClose=fn};
 const line=app.split('\n').find(l=>l.startsWith("window.addEventListener('beforeunload'"));vm.runInContext(line,ctx);
 for(const available of [false,true]){ctx.serverState={review_work_available:available};let blocked=false;const event={preventDefault(){blocked=true}};onClose(event);assert.equal(blocked,available);if(available)assert.equal(event.returnValue,'')}
 console.log('PASS: review replacement waits for confirmation across actions, acknowledged retries preserve payload, engine removal confirms, closing warns only with review work.');
})().catch(e=>{console.error(e);process.exitCode=1});

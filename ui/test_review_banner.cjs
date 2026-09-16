const fs=require('fs'),vm=require('vm'),assert=require('assert');
const code=fs.readFileSync(__dirname+'/review.js','utf8');
const ctx=vm.createContext({positionAssessment:({score})=>score<0?'Black is better':score>0?'White is better':'Balanced position'});
vm.runInContext(code.slice(code.indexOf('function reviewPoint('),code.indexOf('let reviewGraphKey')),ctx);
const render=s=>{ctx.s=s;return vm.runInContext('reviewBannerText(s)',ctx)};
const review={status:'complete',rows:[{ply:1,score:-350,label:'Mistake',symbol:'?',depth:7},{ply:2,score:120,label:'No clear error',symbol:'',depth:7}],points:[{ply:0,score:0}],working_ply:0};
assert(render({ply:1,game_review:review}).includes('Move 1 · Mistake ? · Black is better'));
assert(render({ply:2,game_review:review}).includes('Move 2 · White is better'));
assert(render({ply:0,game_review:review}).includes('Starting position · Balanced position'));
assert(render({ply:3,game_review:review}).includes('Not reviewed yet'));
assert(render({ply:3,game_review:{...review,status:'running',working_ply:3}}).includes('Reviewing…'));
assert(render({ply:3,game_review:{...review,status:'ready'}}).includes('Start review'));
console.log('PASS: review banner follows cursor, starting position, flags and pending states');

assert(render({ply:1,game_review:{...review,external:true,rows:[{ply:1,score:100000,depth:8}]}}).includes('White has a forced win'));

// Review must preserve the same terminal result rendered by the Position page.
const app=fs.readFileSync(__dirname+'/app.js','utf8'),els=new Map();
const get=id=>{if(!els.has(id))els.set(id,{hidden:false,textContent:'',classList:{toggle(){}},setAttribute(){},querySelector(){return get(id+'child')},closest(){return this}});return els.get(id)};
const resultCtx=vm.createContext({window:{},$:get,editorDraft:null,renderReviewMarks(){},toggleAnalysis(){},action(){},reviewGraphKey:''});
vm.runInContext(app.slice(app.indexOf('function boardResultText('),app.indexOf('function resultText(')),resultCtx);
vm.runInContext(code.slice(code.indexOf('window.renderGameReview=s=>{'),code.indexOf(' const row=review.rows.find',code.indexOf('window.renderGameReview=s=>{')))+'};',resultCtx);
const common=app.slice(app.indexOf(' const resultBanner='),app.indexOf(" $('pass').hidden="));
for(const outcome of ['WhiteWins','BlackWins','Draw','InProgress']){
 resultCtx.s={mode:'analysis',state:outcome,ply:3,timeout_side:null,resigned_side:null,game_review:{status:'complete',total:3,rows:[],points:[],remaining_seconds:0}};
 resultCtx.finished=outcome!=='InProgress';vm.runInContext('{'+common+'}',resultCtx);
 const before={hidden:get('boardResult').hidden,text:get('boardResult').textContent};
 resultCtx.window.renderGameReview(resultCtx.s);
 assert.equal(get('boardResult').hidden,before.hidden);assert.equal(get('boardResult').textContent,before.text);
 assert.equal(get('boardResult').hidden,outcome==='InProgress');
 if(outcome==='Draw')assert.equal(get('boardResult').textContent,'½–½ · Draw');
}
console.log('PASS: Game Review preserves Position results for both winners and draws; earlier positions remain clear.');

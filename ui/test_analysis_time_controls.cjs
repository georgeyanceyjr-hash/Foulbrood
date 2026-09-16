const fs=require('fs'),vm=require('vm'),assert=require('assert');
let writes=0;
function tracked(initial){return new Proxy(initial,{set(o,k,v){writes++;o[k]=v;return true}})}
const matchTiming=tracked({disabled:false}),select=tracked({disabled:false,value:'60000',title:'',querySelector:()=>matchTiming});
const document={activeElement:null};
const ctx=vm.createContext({$:()=>select,document});
const code=fs.readFileSync(__dirname+'/engines.js','utf8');
vm.runInContext(code.slice(code.indexOf('function syncThinkingTimeSelector(')),ctx);
const render=s=>ctx.syncThinkingTimeSelector({mode:'play',analysis_ms:60000,analysis_engine:'external',...s},true,false);
render({insight_job:'hint'});assert(select.disabled);
render({insight_job:null});assert(!select.disabled);
writes=0;for(let i=0;i<10;i++)render({insight_job:null});assert.equal(writes,0,'polls must not rewrite an unchanged native menu');
document.activeElement=select;select.value='5000';writes=0;
render({insight_job:null});assert.equal(select.value,'5000');assert.equal(writes,0,'poll must not replace a pending user selection');
document.activeElement=null;render({analysis_ms:5000});assert.equal(select.value,'5000');
render({game_review:{status:'running'}});assert(select.disabled);
render({game_review:{status:'stopped'}});assert(!select.disabled);
console.log('PASS: stopped menu unlocks, native choice survives polling, review start/stop lock states');
const elements=new Map(),actions=[];
function element(id){if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,value:'2000',textContent:'',setAttribute(){},classList:{toggle(){}},querySelector(){return element(id+' child')},closest(){return element(id+' parent')}});return elements.get(id)}
const reviewContext=vm.createContext({window:{},$:element,editorDraft:null,renderReviewMarks(){},reviewGraphKey:'',state:null,action:p=>actions.push(p)});
const reviewCode=fs.readFileSync(__dirname+'/review.js','utf8');
vm.runInContext(reviewCode.slice(reviewCode.indexOf('window.renderGameReview=s=>{'),reviewCode.indexOf(" $('reviewProgress').textContent"))+'};',reviewContext);
function reviewState(status){return {mode:'analysis',game_review:{status,total:3,rows:[]}}}
reviewContext.state=reviewState('running');reviewContext.window.renderGameReview(reviewContext.state);
assert.equal(element('analyze').textContent,'Stop review');assert.equal(element('analyze').disabled,false);assert.equal(element('stopAnalysis').hidden,true);
element('analyze').onclick();assert.equal(actions.pop().action,'review_stop');
reviewContext.state=reviewState('stopped');reviewContext.window.renderGameReview(reviewContext.state);
assert.equal(element('analyze').textContent,'Start review');assert.equal(element('analyze').disabled,false);
element('analyze').onclick();assert.equal(actions.pop().action,'review_start');
let positionAnalyzeClicks=0;reviewContext.toggleAnalysis=()=>positionAnalyzeClicks++;
reviewContext.state={mode:'analysis'};reviewContext.window.renderGameReview(reviewContext.state);
element('analyze').onclick();assert.equal(positionAnalyzeClicks,1,'Position button uses the preview-restoring analysis handler');
reviewContext.state=reviewState('stopped');reviewContext.state.game_review.can_resume=true;reviewContext.state.game_review.rows=[{ply:1}];reviewContext.window.renderGameReview(reviewContext.state);
assert.equal(element('analyze').textContent,'Resume review');element('analyze').onclick();assert.equal(actions.pop().action,'review_start');
reviewContext.state.game_review.can_resume=false;reviewContext.state.game_review.status='complete';reviewContext.window.renderGameReview(reviewContext.state);assert.equal(element('analyze').textContent,'Review again');
console.log('PASS: same review button remains enabled and switches between start and stop actions');

render({mode:'play',analysis_ms:-1});assert(!matchTiming.disabled);assert.equal(select.value,'-1');
render({mode:'analysis'});assert(matchTiming.disabled);
render({mode:'analysis',game_review:{status:'ready'}});assert(matchTiming.disabled);
for(const ms of [600000,3600000,86400000]){render({analysis_ms:ms});assert.equal(select.value,String(ms))}
const html=fs.readFileSync(__dirname+'/index.html','utf8');
const choices=html.match(/<select id="analysisTime">([\s\S]*?)<\/select>/)[1];
assert(!choices.includes('Until stopped'));
assert(choices.endsWith('<option value="-1">Match timing</option>'));
console.log('PASS: long fixed times and Play-only Match timing; unavailable in Position and Review.');

const fs=require('fs'),vm=require('vm'),assert=require('assert');
const app=fs.readFileSync(__dirname+'/app.js','utf8'),review=fs.readFileSync(__dirname+'/review.js','utf8');
function element(tag){
 const el={tag,children:[],attrs:{},style:{setProperty(k,v){this[k]=v}},append(...nodes){this.children.push(...nodes)},setAttribute(k,v){this.attrs[k]=String(v)},removeAttribute(k){delete this.attrs[k]},querySelector(){return this.children.find(n=>n.className==='insight-stats')||null}};
 el.classList={toggle(name,on){el[name]=on}};return el;
}
const ctx=vm.createContext({document:{createElement:element}});
vm.runInContext(app.slice(app.indexOf('function hintColor('),app.indexOf('function renderSuggestionTrail(')),ctx);
vm.runInContext(app.slice(app.indexOf('function evaluationNumbers('),app.indexOf('function positionAssessment(')),ctx);
const descendants=n=>[n,...n.children.flatMap(descendants)],meters=n=>descendants(n).filter(n=>n.attrs.role==='meter');
const hints=[
 [{source:'external',engine_score:1000000,side:1},{score_adapter:'mzinga'}],
 [{source:'external',engine_score:100,side:1},{score_adapter:'nokamute'}],
 [{score:300,side:0},null],
 [{score:-300,side:1},null]
];
for(const [hint,engine]of hints){
 const container=element('div');ctx.appendEvaluationScale(container,{...hint,depth:7},{engine,side:1});
 const meter=meters(container)[0];assert.equal(meter.attrs['aria-valuenow'],'76');assert.equal(meter.children[0].style.left,'88%');
 assert.equal(container.children[0].style['--score-color'],'#83bde6');
 assert.equal(container.children[1].children[0].children[1].textContent,7,'depth remains visible');
 assert.equal(meters(container).length,1);
}
const fields=ctx.createPositionScore();
for(const score of [undefined,null,NaN,Infinity]){
 ctx.updatePositionScore(fields,{score,side:0});assert.equal(fields.value.textContent,'—');assert(fields.meter.hidden);assert(!('aria-valuenow' in fields.meter.attrs));
}
ctx.updatePositionScore(fields,{score:0,side:0});assert(!fields.meter.hidden);assert.equal(fields.value.textContent,'0');assert.equal(fields.marker.style.left,'50%');assert.equal(fields.box.style['--score-color'],'#d5b675');
for(const [winner,value,left]of [['White','+100','100%'],['Black','-100','0%']]){
 ctx.updatePositionScore(fields,{source:'external',engine_forced_winner:winner});assert.equal(fields.value.textContent,value);assert.equal(fields.marker.style.left,left);
}
// Exercise the actual review comparison: both continuations keep their labels,
// score direction, mover color and depth while using the same accessible scale.
ctx.row={best_score:300,score:-300,best_depth:8,depth:7,side:1,move:'bA1',alternative:'bQ'};ctx.s={side:0};ctx.insight=element('div');
vm.runInContext(review.slice(review.indexOf('  if(row.best_score'),review.indexOf("  if(row.label==='Uncertain'")),ctx);
assert.deepEqual(meters(ctx.insight).map(n=>n.attrs['aria-valuenow']),['76','-76']);
const boxes=descendants(ctx.insight).filter(n=>n.className==='position-score');
assert.deepEqual(boxes.map(n=>n.children[0].textContent),['Preferred','Played']);
assert(boxes.every(n=>n.style['--score-color']==='#83bde6'));
assert.deepEqual(descendants(ctx.insight).filter(n=>n.tag==='small'&&String(n.textContent).startsWith('Depth')).map(n=>n.textContent),['Depth 8','Depth 7']);
console.log('PASS: shared score bars preserve engine/review scaling, side colors, depths, unknown versus zero, forced endpoints, and both review continuations.');

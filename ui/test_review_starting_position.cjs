const fs=require('fs'),vm=require('vm'),assert=require('assert');
const code=fs.readFileSync(__dirname+'/review.js','utf8');
const start=code.indexOf(' const row=review.rows.find(r=>r.ply===s.ply),point=');
const finish=code.indexOf(' if(row){',start);
const elements=[],scales=[];
const ctx=vm.createContext({review:null,s:null,$:()=>({replaceChildren(){elements.length=0},append(e){elements.push(e)}}),document:{createElement(){return {}}},shownMove:x=>x,positionAssessment:({score})=>score===0?'Balanced position':'Evaluated position',appendEvaluationScale:(_,v)=>scales.push(v)});
function render(points,rows=[],ply=0){ctx.review={points,rows};ctx.s={ply};scales.length=0;vm.runInContext('{'+code.slice(start,finish)+'}',ctx)}
render([{ply:0,score:0}]);assert.equal(elements[1].textContent,'Balanced position');assert.equal(scales[0].score,0);
render([{ply:0,score:-20}]);assert.equal(elements[1].textContent,'Evaluated position');assert.equal(scales[0].score,-20);
render([]);assert(elements[1].textContent.includes('not been reviewed'));assert.equal(scales.length,0);
render([{ply:0,score:null}]);assert.equal(scales.length,0);
render([{ply:0,score:0}],[{ply:1,move:'wS1',symbol:'',label:'Best move'}],1);assert.equal(elements[1].textContent,'Best move');
console.log('PASS starting-position insight uses reviewed graph point, including zero, and preserves pending/move states');

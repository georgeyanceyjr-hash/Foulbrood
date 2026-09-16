const fs=require('fs'),vm=require('vm'),assert=require('assert');
let viewBox=null,values={};const board={getBoundingClientRect:()=>({width:800,height:400}),getAttribute:()=>viewBox};
const rect={setAttribute:(key,value)=>{assert(Number.isFinite(value));values[key]=value}};
const context=vm.createContext({boardFrame:{x:0,y:0,w:100,h:100},$:id=>id==='board'?board:rect});
const source=fs.readFileSync(__dirname+'/app.js','utf8');vm.runInContext(source.slice(source.indexOf('function resizeBoardBackground('),source.indexOf('function renderBoard(')),context);
for(const value of [null,'','0 0 0 100','0 0 NaN 100','0 0 100']){viewBox=value;context.resizeBoardBackground();assert.deepEqual(values,{})}
viewBox='0 0 100 100';context.resizeBoardBackground();assert.equal(values.width,202);assert.equal(values.height,102);
console.log('PASS: saved-view startup resize safely waits for initialized coordinates; valid resize covers board');

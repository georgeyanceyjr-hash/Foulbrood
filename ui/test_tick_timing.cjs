const fs=require('fs'),vm=require('vm'),assert=require('assert');const s=fs.readFileSync(__dirname+'/app.js','utf8');
let callback,scheduled=[],spoken=[],buzzers=[];const ctx={enabled:true,volume:1,context:{state:'running',currentTime:0},clockTick:at=>scheduled.push(at),speakNumber:(number,pitch,at)=>spoken.push({number,pitch,at}),timeoutSound:at=>buzzers.push(at),setTimeout:fn=>{callback=fn;return 1},clearTimeout(){callback=null}};vm.createContext(ctx);vm.runInContext(s.slice(s.indexOf(' let tickTimer='),s.indexOf(' // One light cricket chirrup:')),ctx);
const state={mode:'play',running:true,result:null,seconds:58.8,key:'turn1',control:'5+4',eligible:true};ctx.syncClockTicks(state);
for(const time of [.17,.49,.73,1.04,1.39,1.74,2.07,2.75]){ctx.context.currentTime=time;ctx.syncClockTicks({...state,seconds:58.8-time});if(callback)callback()}
assert.equal(scheduled.length,3);assert(Math.abs(scheduled[0]-.8)<1e-8);assert(Math.abs(scheduled[1]-scheduled[0]-1)<1e-8);assert(Math.abs(scheduled[2]-scheduled[1]-1)<1e-8);
ctx.syncClockTicks({...state,running:false});assert.equal(callback,null);
ctx.context.currentTime=10;ctx.syncClockTicks({...state,key:'turn2',seconds:31});ctx.context.currentTime=10.95;callback();assert.equal(scheduled.length,3); // 30 is spoken, not ticked
console.log('PASS: irregular polling still schedules exact one-second ticks; pause stops timer; spoken threshold skips tick');

ctx.context.currentTime=20;ctx.syncClockTicks({...state,key:'countdown',seconds:3.8});
for(const time of [20.74,21.73,22.71]){ctx.context.currentTime=time;callback()}
assert.deepEqual(spoken.map(x=>x.number),[3,2,1]);assert(Math.abs(spoken[0].at-20.8)<1e-8);assert.equal(spoken[1].at-spoken[0].at,1);assert.equal(spoken[2].at-spoken[1].at,1);
const beforeBotTicks=scheduled.length;spoken=[];ctx.context.currentTime=30;ctx.syncClockTicks({...state,key:'bot',seconds:3.8,eligible:false});for(const time of [30.74,31.73,32.71]){ctx.context.currentTime=time;callback()}assert.equal(spoken.length,0);assert.equal(scheduled.length-beforeBotTicks,3);
ctx.context.currentTime=40;ctx.syncClockTicks({...state,key:'pause-check',seconds:3.8});ctx.syncClockTicks({...state,running:false});assert.equal(callback,null);
console.log('PASS: 3-2-1 onsets exactly one second apart; computer countdown silent; pause cancels');

ctx.context.currentTime=50;ctx.syncClockTicks({...state,key:'timeout',seconds:3.8});
for(const time of [50.74,51.73,52.71,53.72]){ctx.context.currentTime=time;callback()}
assert.equal(buzzers.length,1);assert(Math.abs(buzzers[0]-53.8)<1e-8);
ctx.context.currentTime=54.8;callback();assert.equal(buzzers.length,1);
console.log('PASS: timeout buzzer scheduled exactly at zero, once');

spoken=[];ctx.context.currentTime=60;ctx.syncClockTicks({...state,key:'black-human',seconds:3.8,speechPitch:.85});
for(const time of [60.74,61.73,62.71]){ctx.context.currentTime=time;callback()}
assert.deepEqual(spoken.map(x=>x.pitch),[.85,.85,.85]);assert.equal(spoken[1].at-spoken[0].at,1);assert.equal(spoken[2].at-spoken[1].at,1);
console.log('PASS: Black uses lower pitch without shifting countdown onsets');

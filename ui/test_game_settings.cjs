const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(__dirname+'/app.js','utf8');
const part=source.slice(source.indexOf('function gameSettingsLocked('),source.indexOf('function render(s)'));
const controls=Object.fromEntries(['whitePlayer','blackPlayer','time','variant'].map(id=>[id,{}]));controls.time.onchange=()=>{};
const ctx={$:id=>controls[id],seatPreviewPlayers:['Human','Human']};vm.createContext(ctx);vm.runInContext(part,ctx);
const base={mode:'play',game:'Base+MLP;InProgress;White[5]',players:['Human','Computer'],time_control:'1+2',running:true,review_total:8};
ctx.syncGameSettings(base);assert(controls.time.disabled);assert.equal(controls.time.value,'1+2');assert.equal(controls.blackPlayer.value,'Computer');assert.equal(ctx.seatPreviewPlayers,null);
assert(ctx.gameSettingsLocked({...base,running:false}));
assert(ctx.gameSettingsLocked({...base,running:false,ply:0,game:'Base+MLP;NotStarted;White[1]',live_game:base.game}));
for(const s of [{...base,play_finished:true},{...base,resigned_side:0},{...base,timeout_side:1},{...base,mode:'analysis'},{...base,running:false,review_total:0,game:'Base+MLP;NotStarted;White[1]'}]){ctx.syncGameSettings(s);assert(!controls.time.disabled)}
console.log('PASS: live/paused/review settings locked; finished/reset/analysis unlocked; current game settings synchronized');

controls.countdownHelp={};
const countdown=source.match(/\$\('countdownHelp'\)\.hidden=[^;]+;/)[0];
for(const players of [['engine-a','engine-b'],['Human','engine-b'],['engine-a','Human'],['Human','Human']]){
 ctx.s={mode:'play'};ctx.shownPlayers=players;vm.runInContext(countdown,ctx);
 assert.equal(controls.countdownHelp.hidden,players.every(p=>p!=='Human'));
}
console.log('PASS: spoken countdown help is hidden for two engines and restored with either human player.');

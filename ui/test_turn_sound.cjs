const assert=require('assert'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(__dirname+'/app.js','utf8').split('// Local, optional two-note chime.')[1].split('\n').slice(1).join('\n');
(async()=>{
let timerCallback,audio;let chirps=0,spoken=[],rates=[],stops=0,decoded=0,levels=[];const numbers=[1,2,3,5,10,20,30];
const extra=Object.fromEntries(['soundGameVolume','soundTickVolume','soundSpeechVolume'].map(id=>[id,{value:100,setAttribute(){}}]));
const slider={value:100,setAttribute(){}},button={setAttribute(){}};
class Audio{
 constructor(){audio=this;this.state='running';this.currentTime=0;this.destination={}}
 resume(){return Promise.resolve()}
 decodeAudioData(){return Promise.resolve({number:numbers[decoded++%7]})}
 createOscillator(){return {frequency:{setValueAtTime(){},linearRampToValueAtTime(){}},connect(){},disconnect(){},start(){chirps++},stop(){stops++}}}
 createBufferSource(){return {playbackRate:{},connect(){},disconnect(){},start(){spoken.push(this.buffer.number);rates.push(this.playbackRate.value)},stop(){stops++}}}
 createGain(){return {gain:{setValueAtTime(v){levels.push(v)},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}}}
}
const document={cookie:'',getElementById:id=>id==='soundToggle'?button:id==='soundVolume'?slider:extra[id]||null,addEventListener(){}};
const window={AudioContext:Audio};vm.runInNewContext(source,{window,document,setTimeout:fn=>{timerCallback=fn;return 1},clearTimeout(){timerCallback=null},atob:s=>Buffer.from(s,'base64').toString('binary')});
const base={mode:'play',running:true,players:['Human','Human'],side:0,state:'InProgress',game:'a',clocks:[60,60],time_control:'5+4',timeout_side:null,resigned_side:null};
const observe=(seconds,control='5+4',extra={})=>window.observeHumanTurn({...base,time_control:control,clocks:[seconds,seconds],...extra});
observe(31);observe(30);assert.equal(spoken.length,0);
button.onclick();await Promise.resolve();await Promise.resolve();assert.equal(chirps,1);
observe(31);for(const t of [30,20,10,3,2,1]){observe(t);observe(t)}assert.deepEqual(spoken,[30,20,10]);
spoken=[];observe(31,'1+2');for(const t of [30,20,10,5,3,2,1])observe(t,'1+2');assert.deepEqual(spoken,[10]);
spoken=[];observe(11);observe(9);observe(12);observe(10);assert.deepEqual(spoken,[10,10]);
spoken=[];observe(31);observe(2);assert.deepEqual(spoken,[]);
button.onclick();observe(31);observe(10);assert.deepEqual(spoken,[]);
button.onclick();await Promise.resolve();spoken=[];observe(31,'5+4',{players:['Computer','Computer']});observe(1,'5+4',{players:['Computer','Computer']});assert.equal(spoken.length,0);
observe(31,'5+4',{mode:'analysis'});observe(1,'5+4',{mode:'analysis'});assert.equal(spoken.length,0);
observe(31);let count=chirps;observe(30);assert.equal(chirps,count);assert.equal(spoken.at(-1),30);
let stopCount=stops;observe(29,'5+4',{running:false});assert(stops>stopCount);
observe(31);count=chirps;observe(0,'5+4',{running:false,timeout_side:0});assert.equal(chirps,count+2);count=chirps;stopCount=stops;observe(0,'5+4',{running:false,timeout_side:0});assert.equal(chirps,count);assert.equal(stops,stopCount);

// The result update must neither repeat nor cut off an already scheduled buzzer.
audio.currentTime=100;observe(3.8,'5+4',{game:'zero'});
for(const time of [100.75,101.75,102.75]){audio.currentTime=time;timerCallback()}
count=chirps;audio.currentTime=103.75;timerCallback();assert.equal(chirps,count+2);
count=chirps;stopCount=stops;observe(0,'5+4',{game:'zero',running:false,timeout_side:0});assert.equal(chirps,count);assert.equal(stops,stopCount);
// Moving before a queued zero cue must cancel it.
audio.currentTime=200;observe(.05,'5+4',{game:'before-zero'});stopCount=stops;
observe(20,'5+4',{game:'after-move',side:1});assert(stops>stopCount);

rates=[];observe(31,'5+4',{game:'white-voice',side:0});observe(30,'5+4',{game:'white-voice',side:0});assert.equal(rates.at(-1),1);
observe(31,'5+4',{game:'black-voice',side:1});observe(30,'5+4',{game:'black-voice',side:1});assert.equal(rates.at(-1),.85);
observe(31,'5+4',{game:'solo-black',side:1,players:['Computer','Human']});observe(30,'5+4',{game:'solo-black',side:1,players:['Computer','Human']});assert.equal(rates.at(-1),1);
slider.value=25;slider.oninput();assert.deepEqual(levels.slice(-4),[.25,1,1,1]);assert(document.cookie.includes('foulbrood_volume=0.25'));
extra.soundGameVolume.value=40;extra.soundGameVolume.oninput();assert.deepEqual(levels.slice(-4),[.25,.4,1,1]);
extra.soundTickVolume.value=0;extra.soundTickVolume.oninput();assert.deepEqual(levels.slice(-4),[.25,.4,0,1]);
extra.soundSpeechVolume.value=70;extra.soundSpeechVolume.oninput();assert.deepEqual(levels.slice(-4),[.25,.4,0,.7]);assert(document.cookie.includes('foulbrood_volume_speech=0.7'));
let botChirps=chirps;spoken=[];
observe(20,'5+4',{game:'bot-move-a',players:['Computer','Computer']});
observe(19,'5+4',{game:'bot-move-b',side:1,players:['Computer','Computer']});
assert.equal(chirps,botChirps+2);assert.equal(spoken.length,0);
slider.value=0;slider.oninput();spoken=[];observe(31);observe(30);assert.equal(spoken.length,0);
console.log('PASS: spoken thresholds, 1+2 timing, repeat after increment, skipped thresholds, mute/volume, no warning beeps, turn and ending behavior');
})().catch(e=>{console.error(e);process.exit(1)});

const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(__dirname+'/review.js','utf8'),elements=new Map(),actions=[],downloads=[],toasts=[];
const get=id=>{if(!elements.has(id))elements.set(id,{files:[],value:'',click(){this.clicked=true}});return elements.get(id)};
const context=vm.createContext({busy:false,actionEpoch:0,window:{BOARD_TOKEN:'test'},$:get,
 action:async p=>actions.push(p),toast:e=>toasts.push(e),Blob,
 URL:{createObjectURL:blob=>{downloads.push(blob);return 'blob:test'},revokeObjectURL(){}},setTimeout(){},
 document:{createElement:()=>({click(){downloads.push(this.download)},remove(){}}),body:{append(){}}},
 fetch:async(url,options)=>{actions.push(JSON.parse(options.body));return {ok:true,json:async()=>({filename:'Reviewed-game.pgn',mime:'application/x-chess-pgn',text:'PGN with review'})}}
});
vm.runInContext(source.slice(source.indexOf('async function saveReviewedGame(')),context);
(async()=>{
 await get('saveReviewedGame').onclick();assert.equal(actions[0].action,'review_save');assert.equal(downloads[1],'Reviewed-game.pgn');assert.equal(await downloads[0].text(),'PGN with review');assert.equal(context.busy,false);
 get('loadReviewedGame').onclick();assert(get('reviewedGameFile').clicked);
 get('reviewedGameFile').files=[{size:25,name:'sample.pgn',text:async()=>'saved review'}];await get('reviewedGameFile').onchange();assert.deepEqual(JSON.parse(JSON.stringify(actions.at(-1))),{action:'review_load',text:'saved review',filename:'sample.pgn'});assert.equal(get('reviewedGameFile').value,'');
 const count=actions.length;get('reviewedGameFile').files=[{size:8000001}];await get('reviewedGameFile').onchange();assert.equal(actions.length,count);assert(toasts.at(-1).includes('8 MB'));
 context.fetch=async()=>({ok:false,json:async()=>({error:'No review'})});await get('saveReviewedGame').onclick();assert.equal(toasts.at(-1),'No review');assert.equal(context.busy,false);
 console.log('PASS: review save downloads PGN, load uses protected action, oversized files and save errors leave the viewer intact.');
})().catch(e=>{console.error(e);process.exitCode=1});

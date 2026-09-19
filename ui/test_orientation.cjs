const fs=require('fs'),vm=require('vm'),cp=require('child_process'),assert=require('assert');
const src=fs.readFileSync(__dirname+'/app.js','utf8');const code=src.slice(src.indexOf('let boardRotation='),src.indexOf('function xy('));
const ctx=vm.createContext({notationMode:'traditional',state:{mode:'play'}});vm.runInContext(code,ctx);
const call=(name,...args)=>{ctx.args=args;return vm.runInContext(name+'(...args)',ctx)};
const snapshot=game=>JSON.parse(cp.execFileSync(__dirname+'/../target/release/board_view'+(process.platform==='win32'?'.exe':''),['snapshot',game],{encoding:'utf8'}));
const game=JSON.parse(cp.execFileSync(process.env.FOULBROOD_TEST_PYTHON||'python3',['-c',"import sys,json;sys.path.insert(0,'ui');from import_game import read_export;v,m,_=read_export(open('ui/fixtures/hivegame.pgn').read());print(json.dumps(v+';InProgress;White[38];'+';'.join(m)))"],{cwd:__dirname+'/..',encoding:'utf8'}));
const base=snapshot(game),prefix=game.split(';').slice(0,3),moves=game.split(';').slice(3);
const sort=pieces=>pieces.map(p=>[p.id,p.q||0,p.r||0,p.level]).sort((a,b)=>a[0].localeCompare(b[0]));
for(let t=0;t<6;t++)for(const mirror of [false,true]){
 const transformed=prefix.concat(moves.map(m=>call('orientMove',m,t,mirror))).join(';');const got=snapshot(transformed);
 const want=base.pieces.map(p=>{const[q,r]=call('orientHex',p.q,p.r,t,mirror);return {...p,q,r}});
 assert.deepStrictEqual(sort(got.pieces),sort(want));assert.equal(got.state,base.state);assert.equal(got.side,base.side);
 for(const m of ['wS1','pass','wB1 bQ'])assert.equal(call('orientMove',m,t,mirror),m);
}
assert.equal(call('orientMove','bS1 wS1-',0,true),'bS1 -wS1');
assert.equal(call('orientMove','bS1 wS1-',1,false),'bS1 wS1\\');
console.log('PASS: all 12 perspectives replay the 74-move fixture to equivalent piece/stack positions and game state.');
vm.runInContext('boardRotation=1;boardMirrored=true;',ctx);
const pgn='[White "Alice"]\n1. wS1\n2. bS1 wS1-\n';
assert.equal(call('orientExport',pgn,'pgn'),'[White "Alice"]\n1. wS1\n2. '+call('orientMove','bS1 wS1-')+'\n');
const json=JSON.stringify({nodes:[{id:0,position_hash:42,move_delta:null},{id:1,position_hash:7,move_delta:{piece:'bS1',position:'wS1-'}}]});
const exported=JSON.parse(call('orientExport',json,'json'));assert.equal(exported.nodes[1].move_delta.position,call('orientMove','bS1 wS1-').split(' ')[1]);assert.equal(exported.nodes[1].position_hash,null);
vm.runInContext("state.mode='analysis';analysisFollowsBoard=false",ctx);assert.equal(call('orientExport',pgn,'pgn'),pgn);
console.log('PASS: PGN/JSON perspective export and default Analysis preservation.');
const root='Base+MLP~0~5~wQ:0:0:0,bQ:1:0:0,wB1:1:0:1~wB1:0:1';
const setup=snapshot(root),setupGame=snapshot(root).game;
vm.runInContext("state.mode='play'",ctx);
for(let t=0;t<6;t++)for(const mirror of [false,true]){
 vm.runInContext(`boardRotation=${t};boardMirrored=${mirror}`,ctx);
 const rotated=call('orientSetupRoot',root),got=snapshot(rotated);
 const want=setup.pieces.map(p=>{const[q,r]=call('orientHex',p.q,p.r);return {...p,q,r}});
 assert.deepStrictEqual(sort(got.pieces),sort(want));
 assert.deepStrictEqual(got.last_move.from,Array.from(call('orientHex',0,1),n=>n||0));
 const exported=JSON.parse(call('orientExport',JSON.stringify({format:'foulbrood-position',version:1,root,moves:[]}), 'json'));
 assert.equal(exported.root,rotated);
 assert(call('orientExport',`[FoulBroodRoot "${root}"]\n`,'pgn').includes(rotated));
 assert.equal(call('shownGame',setupGame).split(';')[0],rotated);
}
console.log('PASS: custom setup stacks and last-move origins preserved across all 12 perspectives and exports.');

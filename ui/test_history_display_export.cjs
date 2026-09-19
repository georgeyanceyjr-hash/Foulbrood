const fs=require('fs'),vm=require('vm'),assert=require('assert'),cp=require('child_process');
const s=fs.readFileSync(__dirname+'/app.js','utf8');
const game='Base;InProgress;White[2];wS1;bS1 wS1-';
const context=vm.createContext({editorDraft:null,notationMode:'traditional',state:{mode:'analysis',game:'Base;InProgress;Black[1];wS1',review_game:game,timeout_side:null,resigned_side:null,player_names:['Alice','Bob']},notationCache:new Map([[game,[{analytic:'wS'},{analytic:'bS @ wS'}]]]),btoa:x=>Buffer.from(x).toString('base64')});
vm.runInContext(s.slice(s.indexOf('let boardRotation='),s.indexOf('function xy(')),context);
vm.runInContext(s.slice(s.indexOf('function resultText('),s.indexOf('function renderHistory(')),context);
vm.runInContext(s.slice(s.indexOf('function visibleHistory('),s.indexOf("$('copyHistory').onclick=")),context);
vm.runInContext(s.slice(s.indexOf('function historyFile('),s.indexOf('async function exportHistory(')),context);
const run=x=>vm.runInContext(x,context);
for(const analytic of [false,true])for(const follow of [false,true])for(let t=0;t<6;t++)for(const mirror of [false,true]){
 run(`notationMode='${analytic?'analytic':'traditional'}';analysisFollowsBoard=${follow};boardRotation=${t};boardMirrored=${mirror}`);
 const h=run('visibleHistory()');assert.equal(h.moves.length,2);
 assert.equal(h.moves[1],analytic?'bS @ wS':run("shownMove('bS1 wS1-')"));
 for(const kind of ['pgn','json']){
  const out=run(`historyFile(visibleHistory(),'${kind}')`);
  if(kind==='pgn')assert(out.includes('2. '+h.moves[1]));
  else {const j=JSON.parse(out);assert.equal(analytic?j.moves[1]:(j.nodes[2].move_delta.piece+' '+j.nodes[2].move_delta.position),h.moves[1])}
  if(t===1&&mirror&&follow){const imported=JSON.parse(cp.execFileSync(process.env.FOULBROOD_TEST_PYTHON||'python3',['-B','-c',"import sys,json;sys.path.insert(0,'ui');from import_game import read_export;print(json.dumps(read_export(sys.stdin.read())))"],{cwd:__dirname+'/..',input:out,encoding:'utf8'}));assert.equal(imported[1].length,2);assert.equal(imported[1][1],analytic?'bS1 wS1-':h.moves[1]);}
 }
}
console.log('PASS: full history while reviewing earlier move; both notations; all12 orientations; follow toggle; PGN/JSON display and reimport.');

// Recorded results are independent of the cursor and board's terminal state.
for(const result of ['WhiteWins','BlackWins','Draw']){
 run(`state.reported_result='${result}'`);
 const h=run('visibleHistory()');assert(h.result);
 for(const kind of ['pgn','json']){
  const out=run(`historyFile(visibleHistory(),'${kind}')`);
  const parsed=JSON.parse(cp.execFileSync(process.env.FOULBROOD_TEST_PYTHON||'python3',['-B','-c',"import sys,json;sys.path.insert(0,'ui');from import_game import reported_result;print(json.dumps(reported_result(sys.stdin.read())))"],{cwd:__dirname+'/..',input:out,encoding:'utf8'}));
  assert.equal(parsed,result);
 }
 assert(run('historyClipboardText(visibleHistory())').includes(h.result));
}
run("state.reported_result=null;state.game=state.review_game='Base~0~5~wQ:0:0:0,bQ:1:0:0,wA1:-1:0:0~wA1:-2:1;InProgress;White[5]'");
for(const mode of ['traditional','analytic'])for(const follow of [false,true])for(let t=0;t<6;t++)for(const mirror of [false,true]){
 run(`notationMode='${mode}';analysisFollowsBoard=${follow};boardRotation=${t};boardMirrored=${mirror}`);
 const root=run('visibleHistory().shown').split(';')[0].split('~');
 const from=root[4].split(':').slice(1).join(', '),to=root[3].split(',').find(x=>x.startsWith('wA1:')).split(':').slice(1,3).join(', ');
 assert.equal(run('setupLastMoveLabel()'),`Last move · wA1 (${from}) → (${to})`);
 assert.equal(run('historyClipboardText(visibleHistory())'),run('setupLastMoveLabel()'));
}
run("state.game=state.review_game='Base~0~5~wQ:0:0:0,bQ:1:0:0,wA1:-1:0:0~;InProgress;White[5]';state.setup_placed='wA1'");
assert.equal(run('historyClipboardText(visibleHistory())'),'Last move · wA1 placed');
console.log('PASS: recorded outcomes survive PGN/JSON reimport and copy; setup copy includes last move; setup coordinates match all 12 export perspectives.');

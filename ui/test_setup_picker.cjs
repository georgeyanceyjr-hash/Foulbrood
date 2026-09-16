const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(__dirname+'/app.js','utf8');
const ctx={busy:false,editorDraft:{pieces:[],last:null},editorTool:'last-piece',pieceDrag:null,state:{game:'setup'},ignoreDropClick:false,redrawSetup(){},hideStack(){}};vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('function setupPointerDown('),source.indexOf('function setupDrop(')),ctx);
function event(matches){return {button:0,target:{closest:s=>matches[s]||null},preventDefault(){this.prevented=true},stopImmediatePropagation(){this.stopped=true},stopPropagation(){}}}
// Controls remain clickable even if an empty board entered selection mode.
let e=event({});ctx.setupPointerDown(e);assert(!e.prevented);assert(!e.stopped);
// Reserve dragging exits selection instead of trapping the user.
e=event({'.reserve':{},'.stack-piece,.tile,.reserve button':{dataset:{piece:'wA1'}}});ctx.setupPointerDown(e);assert.equal(ctx.editorTool,null);assert.equal(ctx.pieceDrag.id,'wA1');
// Selecting a board bug still advances to selecting its previous hex.
ctx.editorDraft.pieces=[{id:'wA1',q:0,r:0,level:0}];ctx.editorTool='last-piece';
e=event({'#board':{},'.tile':{dataset:{piece:'wA1'}}});ctx.setupPointerDown(e);assert.equal(ctx.editorDraft.last.piece,'wA1');assert.equal(ctx.editorTool,'origin');
console.log('PASS: picker leaves sidebar controls usable, permits reserve drag, and selects board bug');

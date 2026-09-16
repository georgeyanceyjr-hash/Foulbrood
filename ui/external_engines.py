"""Local UHP engines: bounded protocol IO and an atomic saved engine list."""
from platform_support import executable, process_options
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time
import uuid
import math
import re
from collections import deque

class UHP:
    def __init__(self,path):
        env=os.environ.copy()
        cache=Path(os.environ.get('FOULBROOD_ENGINE_CACHE',str(Path.home()/'Documents/FoulBroodData/engine-cache')))
        cache.mkdir(parents=True,exist_ok=True);env['DOTNET_BUNDLE_EXTRACT_BASE_DIR']=str(cache)
        self.on_line=None;self.on_diagnostic=None;self.deadline=None
        self.proc=subprocess.Popen([path],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',**process_options(),bufsize=1,env=env,cwd=str(Path(path).parent))
        self.lines=queue.Queue(maxsize=2048)
        self.diagnostics=deque(maxlen=2048)
        def read_errors():
            for line in iter(lambda:self.proc.stderr.readline(16385),''):
                if len(line)>16384:break
                self.diagnostics.append(line.strip())
                if self.on_diagnostic:self.on_diagnostic(line.strip())
        self.error_thread=threading.Thread(target=read_errors,daemon=True);self.error_thread.start()
        def read():
            try:
                while True:
                    line=self.proc.stdout.readline(16385)
                    if not line:break
                    if len(line)>16384:break
                    try:self.lines.put_nowait(line.strip())
                    except queue.Full:break
            finally:
                try:self.lines.put_nowait(None)
                except queue.Full:pass
        threading.Thread(target=read,daemon=True).start()
    def reply(self,seconds=8):
        end=min(time.monotonic()+seconds,self.deadline) if self.deadline is not None else time.monotonic()+seconds;out=[]
        while True:
            try:line=self.lines.get(timeout=max(.001,end-time.monotonic()))
            except queue.Empty:raise ValueError('Engine did not respond in time.')
            if line is None:raise ValueError('Engine closed unexpectedly.')
            if line=='ok':
                errors=[v for v in out if v.startswith(('err','invalidmove'))]
                if errors:raise ValueError(errors[0][:250])
                return out
            if line:
                out.append(line)
                if self.on_line:self.on_line(line)
            if len(out)>2048 or time.monotonic()>end:raise ValueError('Engine response exceeded its limit.')
    def command(self,text,seconds=8):
        if '\n' in text or '\r' in text:raise ValueError('Invalid engine command.')
        self.proc.stdin.write(text+'\n');self.proc.stdin.flush();return self.reply(seconds)
    def close(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:self.proc.wait(timeout=.5)
            except subprocess.TimeoutExpired:self.proc.kill();self.proc.wait()
        self.error_thread.join(timeout=1)
        self.proc.stdin.close();self.proc.stdout.close();self.proc.stderr.close()

def inspect_engine(path):
    path=str(Path(path).expanduser().resolve())
    if not Path(path).is_file() or not os.access(path,os.X_OK):raise ValueError('Choose an executable UHP engine program.')
    engine=UHP(path)
    try:
        info=engine.reply();name=next((v[3:].strip() for v in info if v.startswith('id ')),None)
        if not name:raise ValueError('This program did not identify itself as a UHP engine.')
        engine.command('newgame Base');moves=engine.command('validmoves')
        if not moves:raise ValueError('This engine did not return legal moves.')
        flags=set(';'.join(v for v in info if not v.startswith('id ')).split(';'))
        entry=dict(id='uhp:'+uuid.uuid4().hex,name=name[:100],path=path,capabilities=[v for v in ['Mosquito','Ladybug','Pillbug'] if v in flags])
    finally:engine.close()
    if path!=foulbrood_entry()['path']:
        entry.update(detect_score_format(path))
    return entry

def foulbrood_entry():
    return dict(id='Computer',name='FoulBrood',path=executable(Path(__file__).resolve().parents[1], 'foulbrood'),connected=True,score_adapter='foulbrood',review_supported=True,capabilities=['Mosquito','Ladybug','Pillbug'])

class EngineLibrary:
    def __init__(self,path=None):
        self.path=Path(path or os.environ.get('FOULBROOD_ENGINES_FILE',str(Path.home()/'Documents/FoulBroodData/engines.json')))
        try:data=json.loads(self.path.read_text())
        except (OSError,ValueError):data={}
        self.entries=data if isinstance(data,list) else data.get('entries',[])
        # Migrate the earlier separate bundled-engine preference to an ordinary entry.
        if not isinstance(data,dict) or data.get('version',1)<2:
            if (not isinstance(data,dict) or data.get('builtin_present',True)) and not self.get('Computer') and Path(foulbrood_entry()['path']).is_file():
                entry=foulbrood_entry();entry['connected']=True if isinstance(data,list) else data.get('builtin_connected',True);self.entries.insert(0,entry)
        for entry in self.entries:
            entry.setdefault('connected',True);entry['review_supported']=entry['id']=='Computer' or entry.get('score_adapter') in ('foulbrood','mzinga','nokamute')
        self.analysis_engine='Computer' if isinstance(data,list) else data.get('analysis_engine','Computer')
        if not self.connected(self.analysis_engine):self.analysis_engine=next((e['id'] for e in self.entries if e['connected']),None)
    @property
    def builtin_present(self):return self.get('Computer') is not None
    @property
    def builtin_connected(self):return self.connected('Computer')
    def save(self):
        self.path.parent.mkdir(parents=True,exist_ok=True);temp=self.path.with_suffix('.tmp');temp.write_text(json.dumps(dict(version=2,entries=self.entries,analysis_engine=self.analysis_engine),indent=2));os.replace(temp,self.path)
    def connected(self,key):return bool(self.get(key) and self.get(key).get('connected'))
    def get(self,key):return next((e for e in self.entries if e['id']==key),None)
    def add(self,entry):
        # The shipped FoulBrood executable can be re-added with the same file picker.
        if Path(entry['path']).resolve()==Path(foulbrood_entry()['path']).resolve():
            entry.update(id='Computer',review_supported=True,score_adapter='foulbrood',name='FoulBrood')
        entry['review_supported']=entry.get('score_adapter') in ('foulbrood','mzinga','nokamute')
        previous=next((e for e in self.entries if e['path']==entry['path'] or e['id']==entry['id']),None)
        if previous:entry['id']=previous['id'];self.entries.remove(previous)
        entry['connected']=True;self.entries.append(entry);self.save();return entry
    def remove(self,key):self.entries=[e for e in self.entries if e['id']!=key];self.save()
    def check_variant(self,key,variant):
        e=self.get(key)
        if not e:raise ValueError('That engine is no longer available.')
        for code,name in [('M','Mosquito'),('L','Ladybug'),('P','Pillbug')]:
            if '+' in variant and code in variant.split('+')[1] and name not in e['capabilities']:raise ValueError(e['name']+' does not support '+name+'. Choose compatible pieces.')


def score_adapter(name):
    if name.startswith('MzingaEngine '):return 'mzinga'
    if name.lower().startswith('nokamute '):return 'nokamute'
    return None


def configure_reporting(engine,entry,scoring=False,preserve_opening=False):
    adapter=entry.get('score_adapter') if 'score_adapter' in entry else score_adapter(entry['name'])
    if adapter=='foulbrood':
        if scoring:engine.command('options set ReportFoulBroodScores True')
    elif adapter=='mzinga':
        engine.command('options set PonderDuringIdle Disabled')
        engine.command('options set MaxHelperThreads None')
        if scoring:engine.command('options set ReportIntermediateBestMoves True')
    elif adapter=='nokamute':
        engine.command('options set BackgroundPondering False')
        engine.command('options set NumThreads 1')
        if scoring:
            if not preserve_opening:engine.command('options set RandomOpening False')
            engine.command('options set Verbose True')
    return adapter


def parse_score(adapter,lines,diagnostics,side,final_move):
    """Return native units from White's perspective; never reuse FoulBrood's scale."""
    candidate=None
    if adapter=='foulbrood':
        for line in diagnostics:
            if not exact_score_lines(adapter,[],[line],final_move):continue
            match=re.fullmatch(r'FoulBroodScore v1;depth=([1-9]\d*);score=(-?\d+);move=(.+)',line)
            depth,value=int(match[1]),int(match[2])
            if depth>64 or abs(value)>100000:continue
            candidate=dict(depth=depth,score=value,source='foulbrood',engine_score=value*(1 if side==0 else -1),engine_forced_winner=None)
        return candidate or {}
    if adapter=='mzinga':
        for line in lines:
            if not exact_score_lines(adapter,[line],[],final_move):continue
            fields=line.split(';')
            if len(fields)<3 or fields[0]!=final_move:continue
            try:depth=int(fields[1]);value=float(fields[2].replace('∞','Infinity'))
            except ValueError:continue
            if depth<1 or math.isnan(value):continue
            candidate=(depth,value)
    elif adapter=='nokamute':
        for line in diagnostics:
            if not exact_score_lines(adapter,[],[line],final_move):continue
            match=re.search(r'Iterative fullsearch depth\s*(\d+).*?; value\s*([^;]+);',line)
            if not match:match=re.search(r'Parallel .*?depth=\s*(\d+).*?; returned\s*([^;]+);',line)
            if not match:continue
            reported=re.search(r'bestmove[= ]+([^;]+)',line)
            if not reported or reported[1].strip()!=final_move:continue
            try:depth=int(match[1]);value=float(match[2].strip().replace('∞','Infinity'))
            except ValueError:continue
            if depth<1 or math.isnan(value):continue
            candidate=(depth,value)
    if candidate is None:return {}
    depth,value=candidate;white=value*(1 if side==0 else -1)
    return dict(depth=depth,engine_score=white if math.isfinite(white) else None,
                engine_forced_winner=('White' if white>0 else 'Black') if math.isinf(white) else None)


def discover_engines(roots=None, seconds=8, max_files=60000):
    """Find likely programs by name; never execute a discovered file automatically."""
    if roots is None:
        home=Path.home()
        # Check dedicated engine folders before broad trees can exhaust the budget.
        roots=list(dict.fromkeys([
            Path(os.environ.get('FOULBROOD_DATA_DIR',str(home/'Documents/FoulBroodData')))/'Engines',
            home/'Documents/FoulBroodData/Engines',
            home/'Library/Application Support/FoulBrood GUI Beta/Engines',
            home/'Documents/Engines',home/'Downloads',home/'Desktop',home/'Applications',Path('/Applications'),
            home/'Documents',Path('/usr/local/bin'),Path('/opt/homebrew/bin')]))
        if os.name == 'nt':
            roots = list(dict.fromkeys([
                Path(os.environ.get('FOULBROOD_DATA_DIR', str(home/'AppData/Local/FoulBrood GUI Beta')))/'Engines',
                home/'Documents/Engines', home/'Downloads', home/'Desktop', home/'Documents',
                Path(os.environ.get('ProgramFiles', 'C:/Program Files')),
                Path(os.environ.get('ProgramFiles(x86)', 'C:/Program Files (x86)'))]))
    names={'foulbrood':'FoulBrood','mzingaengine':'Mzinga','mzingacpp':'MzingaCpp',
           'nokamute':'Nokamute','hivemind':'Hivemind'}
    found={};skipped=0;count=0;limited=False;deadline=time.monotonic()+seconds
    def inaccessible(error):
        nonlocal skipped
        skipped+=1
    for root in roots:
        if not Path(root).exists():continue
        for folder, dirs, files in os.walk(root,onerror=inaccessible,followlinks=False):
            if time.monotonic()>deadline:
                limited=True;break
            relative=Path(folder).relative_to(root)
            dirs[:]=sorted(d for d in dirs if not d.startswith('.') and d not in
                           {'node_modules','vendor','engine-cache','Library','__pycache__'}) if len(relative.parts)<9 else []
            for filename in sorted(files):
                count+=1
                if count>max_files or time.monotonic()>deadline:
                    limited=True;break
                if filename=='FoulBrood' and Path(folder).name=='MacOS':continue
                name=names.get(filename.lower().removesuffix('.exe') if os.name=='nt' else filename.lower())
                if not name:continue
                path=Path(folder)/filename
                if not path.is_file() or not os.access(path,os.X_OK):continue
                resolved=str(path.resolve())
                found[resolved]=dict(name=name,path=resolved)
            if limited:break
        if limited:break
    return dict(candidates=sorted(found.values(),key=lambda e:(e['name'],e['path'])),
                limited=limited,skipped=skipped)


# Display/annotation heuristics in each engine's own units, not fitted win odds.
# Inaccuracy/mistake/blunder losses: Mzinga 200k/500k/1M; Nokamute 20/50/100.
REVIEW_SCALE={'mzinga':1000000.0,'nokamute':100.0}

def review_score(report,adapter):
    if adapter=='foulbrood':return report.get('engine_score')
    winner=report.get('engine_forced_winner')
    if winner:return 100000 if winner=='White' else -100000
    value=report.get('engine_score')
    if value is None:return None
    return max(-99000,min(99000,300*value/REVIEW_SCALE[adapter]))


def canonical_move(snapshot,data,move):
    if move in {m['move'] for m in data['legal']}:return move
    following=snapshot('play',data['game'],move)
    mark=following.get('last_move')
    if mark:
        for candidate in data['legal']:
            if candidate['piece']==mark['piece'] and candidate.get('to')==mark['to']:return candidate['move']
    raise ValueError('Engine returned an unavailable move.')


# Exact formats emitted by the supported Mzinga and Nokamute adapters.
_PIECE=r'[wb](?:[QMLP]|[BS][12]|[AG][123])'
_MOVE=rf'(?:pass|{_PIECE}(?: (?:[-/\\]{_PIECE}|{_PIECE}[-/\\]?))?)'
_MZ_SCORE=r'(?:-?\d+\.\d{2}|-?Infinity|-?∞)'
_NK_SCORE=r'(?:-?\d+|-?∞)'

def exact_score_lines(adapter,lines,diagnostics,move):
    if not re.fullmatch(_MOVE,move):return False
    if adapter=='foulbrood':
        return any(re.fullmatch(rf'FoulBroodScore v1;depth=[1-9]\d*;score=-?\d+;move={re.escape(move)}',line) for line in diagnostics)
    if adapter=='mzinga':
        pattern=rf'{re.escape(move)};[1-9]\d*;{_MZ_SCORE}(?:;{_MOVE})*'
        return any(re.fullmatch(pattern,line) for line in lines)
    if adapter=='nokamute':
        sequential=rf'Iterative fullsearch depth\s+[1-9]\d* took\s+\d+ms; value\s+{_NK_SCORE}; bestmove={re.escape(move)}'
        parallel=rf'Parallel \(threads=\d+\) depth=\s*[1-9]\d*, took=\s*\d+ms; returned\s+{_NK_SCORE}; bestmove {re.escape(move)}; MBF=\d+(?:\.\d+)?'
        return any(re.fullmatch(sequential,line) or re.fullmatch(parallel,line) for line in diagnostics)
    return False

def probe_score_format(path,adapter):
    """Probe known options and exact score output for both colors in isolated games."""
    engine=None
    try:
        engine=UHP(path);engine.deadline=time.monotonic()+6
        engine.reply();configure_reporting(engine,dict(score_adapter=adapter),True)
        for game,side in [('Base',0),('Base;InProgress;Black[1];wS1',1)]:
            engine.command('newgame '+game)
            legal=set(';'.join(engine.command('validmoves')).split(';'))
            engine.diagnostics.clear()
            lines=engine.command('bestmove time 00:00:01',3)
            if not lines:return False
            move=lines[-1].split(';')[0]
            # Synchronize with stderr without terminating the engine between sides.
            # Diagnostic writes precede bestmove's stdout; briefly allow the reader to drain.
            deadline=min(engine.deadline,time.monotonic()+.25)
            while True:
                diagnostics=list(engine.diagnostics)
                exact=exact_score_lines(adapter,lines,diagnostics,move)
                if exact or adapter not in ('nokamute','foulbrood') or time.monotonic()>=deadline:break
                time.sleep(.01)
            if move not in legal or not exact:return False
            if not parse_score(adapter,lines,diagnostics,side,move):return False
        return True
    except (OSError,ValueError,subprocess.SubprocessError):return False
    finally:
        if engine:engine.close()

def detect_score_format(path):
    matches=[adapter for adapter in ('foulbrood','mzinga','nokamute') if probe_score_format(path,adapter)]
    return dict(score_adapter=matches[0] if len(matches)==1 else None,
                score_format_check='matched' if len(matches)==1 else 'ambiguous' if matches else 'unsupported')

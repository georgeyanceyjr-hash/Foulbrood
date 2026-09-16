from platform_support import executable, process_options, choose_engine
from external_engines import EngineLibrary, UHP, inspect_engine, configure_reporting, parse_score, discover_engines, canonical_move
from opening_book import OpeningBook
from game_review import Review
#!/usr/bin/env python3
"""Loopback-only local board. Python standard library; no accounts or services."""
from import_game import read_export, reported_result, player_names
from hivegame import fetch_game
from export_game import export_game
from review_file import save_review, read_review, engine_matches, engine_identity, MAX_REVIEW_BYTES
from live_analysis import capture, visible_history
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import threading
import time
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
TIMES = {'1+2': (60,2), '3+3': (180,3), '5+4': (300,4), '10+10': (600,10), '20+20': (1200,20)}
TERMINAL = ('WhiteWins','BlackWins','Draw')


class Clock:
    def __init__(self, initial, increment, now=time.monotonic):
        self.remaining = [float(initial),float(initial)]
        self.increment = increment
        self.started = None
        self.side = 0
        self.now = now

    def values(self):
        out = self.remaining.copy()
        if self.started is not None:
            out[self.side] = max(0, out[self.side] - (self.now()-self.started))
        return out

    def pause(self):
        self.remaining = self.values()
        self.started = None

    def start(self, side):
        self.side = side
        self.started = self.now()

    def commit(self):
        values = self.values()
        if values[self.side] <= 0:
            self.remaining = values
            self.started = None
            return False
        values[self.side] += self.increment
        self.remaining = values
        self.started = None
        return True


def budget_ms(remaining, increment):
    # Conservative first policy: spend a share of the reserve plus most of the
    # increment. Never consume the completion margin. This is not strength-tuned.
    margin = min(.25, max(.02, remaining*.05))
    available = max(0, remaining-margin)
    return max(0, int(1000*min(available, remaining/25 + .8*increment)))


def snapshot(command, game, move=None):
    args = [executable(ROOT, 'board_view'),command,game]
    if move is not None: args.append(move)
    p = subprocess.run(args, capture_output=True, text=True,encoding='utf-8',**process_options(), timeout=15)
    if p.returncode: raise ValueError(p.stderr.strip() or 'Engine could not read this position.')
    return json.loads(p.stdout)


@lru_cache(maxsize=32)
def notation(game):
    p=subprocess.run([sys.executable,'-X','utf8','-E','-s','-B',str(ROOT/'ui/notation.py')],input=game,
                     capture_output=True,text=True,encoding='utf-8',**process_options(),timeout=45)
    if p.returncode:raise ValueError('The analytic translator could not read this history.')
    return json.loads(p.stdout)


@lru_cache(maxsize=256)
def notation_move(game,move):
    p=subprocess.run([sys.executable,'-X','utf8','-E','-s','-B',str(ROOT/'ui/notation.py'),'--move'],input=json.dumps(dict(game=game,move=move)),capture_output=True,text=True,encoding='utf-8',**process_options(),timeout=15)
    if p.returncode:raise ValueError('This move needs more notation detail.')
    return json.loads(p.stdout)


class Session:
    def __init__(self, data, time_control='5+4', players=None):
        self.data = data
        self.time_control = time_control
        self.players = players or ['Human','Computer']
        self.clock = Clock(*TIMES[time_control])
        self.move_sources = {}
        self.setup_placed = None
        self.past_clocks = []
        self.thoughts = [None,None]
        self.analysis_history = {}
        self.import_info = ''
        self.reported_result = None
        self.player_names = [None, None]
        self.review_data = None
        self.review_game = data['game']
        self.review_cache = {data['ply']:data}
        self.running = False
        self.timeout_side = None
        self.resigned_side = None

    def start_turn_clock(self):
        self.clock.side = self.data['side']
        if self.data['ply'] >= 2: self.clock.start(self.data['side'])
        else: self.clock.started = None

    @property
    def finished(self):
        return self.timeout_side is not None or self.resigned_side is not None or self.review_game.split(';')[1] in TERMINAL


class App:
    def __init__(self, engines=None, position=None):
        self.engines = engines or EngineLibrary()
        self.lock = threading.RLock()
        self.play = Session(position if position is not None else snapshot('snapshot','Base+MLP'))
        if not self.engines.builtin_connected:self.play.players=['Human','Human']
        self.analysis = None
        self.review = None
        self.saved_reviews = {}
        self.mode = 'play'
        self.revision = 0
        self.book = OpeningBook(ROOT)
        self.book_enabled = False
        self.book_bypass_game = None
        self.hints = False
        self.hint_paused = False
        self.continuous_hints = False
        self.analysis_times = {'play': -1, 'analysis': 60000}
        self.hint = None
        self.job = None
        self.search_started = None
        self.search_finished = False
        self.process = None
        self.error = ''
        self.last_seen = time.monotonic()
        self.insight_worker = None

    @property
    def session(self): return self.play if self.mode=='play' else self.analysis

    @property
    def analysis_ms(self): return self.analysis_times[self.mode]

    @analysis_ms.setter
    def analysis_ms(self, value): self.analysis_times[self.mode] = value

    def analysis_budget_ms(self):
        if self.analysis_ms != -1:return self.analysis_ms
        s=self.play
        # Use the same clock allocation as a player, with UHP's one-second floor.
        return max(1000,budget_ms(s.clock.values()[s.data['side']],s.clock.increment))

    def leave_review(self):
        if self.review:
            self.review.stop()
            self.hints=self.review.saved_hints
            key=(self.review.game,self.review.engine.get('id'),self.review.engine.get('path'))
            self.saved_reviews[key]=self.review
            self.review=None

    def reviews_with_work(self):
        reviews=list(self.saved_reviews.values())+([self.review] if self.review else [])
        return [r for r in reviews if r.has_work()]

    def analysis_review_available(self):
        return bool(self.analysis and (self.analysis.analysis_history or any(r.game==self.analysis.review_game for r in self.reviews_with_work())))

    def discard_analysis_reviews(self):
        game=self.analysis.review_game if self.analysis else None
        self.leave_review()
        self.saved_reviews={k:r for k,r in self.saved_reviews.items() if r.game!=game}

    def review_clear_warning(self,payload):
        action=payload['action']
        if action=='review_start' and self.review and (self.review.rows or self.review.points) and not self.review.can_resume():
            return 'Starting this review again will clear its existing results and repeat the analysis.'
        replacing=action in ('load','review_load','setup_position','open_analysis') or self.mode=='analysis' and action in ('move','undo')
        if replacing and self.analysis_review_available():
            return 'This will replace the game or position associated with your review. The existing review results will no longer be shown. Continue?'
        if action in ('load','review_load','open_analysis') and self.analysis and (self.analysis.data['pieces'] or len(self.analysis.review_game.split(';'))>3):
            return 'This will replace the current Analysis position and game history. Continue?'
        if action=='engine_remove' and any(r.engine.get('id')==payload.get('id') for r in self.reviews_with_work()):
            return 'Removing this engine will clear its retained game review results. Continue?'
        return None

    def parallel_insight_allowed(self):
        s=self.session
        if self.mode!='play' or not s.running or s.finished or s.review_data is not None or 'Human' not in s.players:return False
        playing=s.players[s.data['side']];chosen=self.engines.analysis_engine
        if playing=='Human' or chosen==playing or not self.engines.connected(chosen):return False
        a=self.engines.get(playing);b=self.engines.get(chosen)
        return bool(a and b and Path(a['path']).resolve()!=Path(b['path']).resolve())

    def stop_insight_worker(self):
        worker=self.insight_worker
        if worker:
            with worker.lock:
                self.hint=worker.hint
                worker.invalidate()
            self.insight_worker=None

    def launch_parallel_insight(self, milliseconds):
        if milliseconds==-1:milliseconds=self.analysis_budget_ms()
        if not self.parallel_insight_allowed() or self.insight_worker:return
        # A separate analysis session reuses the adapters without sharing the
        # player's process, revision, clock, or move-completion callbacks.
        worker=App(engines=self.engines,position=self.session.data)
        worker.mode='analysis';worker.analysis=worker.play
        worker.book_enabled=False;worker.analysis_ms=milliseconds
        self.insight_worker=worker
        worker.launch_search('hint',milliseconds)

    def capture_live_insights(self):
        if self.mode!='play':return
        s=self.session;side=s.data['side'];thought=s.thoughts[side]
        player=s.players[side];chosen=self.engines.analysis_engine
        playing=self.engines.get(player);selected=self.engines.get(chosen)
        worker=self.insight_worker or self
        same=playing and selected and (player==chosen or playing.get('path')==selected.get('path'))
        duel=all(p!='Human' for p in s.players)
        if thought and thought['ply']==s.data['ply']+1 and (duel or same or not worker.hint):
            if playing:capture(s,engine_identity(playing),thought.get('evaluation'),thought.get('milliseconds',0))
        elif worker.hint and selected:
            capture(s,engine_identity(selected),worker.hint,getattr(worker,'search_milliseconds',self.analysis_budget_ms()))

    def invalidate(self, capture_analysis=True):
        if capture_analysis:self.capture_live_insights()
        self.stop_insight_worker()
        for thought in self.session.thoughts:
            if thought and thought['status']=='thinking':thought['status']='stopped'
        self.revision += 1
        self.search_started = None
        self.search_finished = False
        self.hint = None
        self.job = None
        if self.process and self.process.poll() is None: self.process.terminate()
        self.process = None

    def pause(self):
        self.session.clock.pause()
        self.session.running = False
        self.invalidate()

    def expired(self):
        s = self.session
        if self.mode=='play' and s.running and s.data['ply'] >= 2 and s.clock.values()[s.data['side']] <= 0:
            s.timeout_side = s.data['side']
            self.pause()
            return True
        return False

    def move(self, text, source=None):
        s = self.session
        following = snapshot('play',s.data['game'],text)
        if self.mode=='play':
            if self.expired(): return
            before = s.clock.remaining.copy()
            if s.data['ply'] >= 2 and not s.clock.commit():
                s.timeout_side = s.data['side']; self.pause(); return
            s.past_clocks.append(before)
            self.capture_live_insights()
        s.data = following
        if source:s.move_sources[following['game']]=source
        if self.mode=='analysis':
            self.discard_analysis_reviews()
            s.analysis_history={}
            s.reported_result=None
        s.review_game=following['game'];s.review_cache={following['ply']:following}
        self.invalidate(capture_analysis=False)
        if self.mode=='play':
            s.running = following['state'] not in TERMINAL
            if s.running: s.start_turn_clock()

    def launch_search(self, kind, milliseconds):
        if kind=='hint' and milliseconds==-1:milliseconds=self.analysis_budget_ms()
        if kind=='hint' and self.parallel_insight_allowed():return self.launch_parallel_insight(milliseconds)
        if self.job is not None: return
        key=self.engines.analysis_engine if kind=='hint' else self.session.players[self.session.data['side']]
        if not self.engines.connected(key):return
        self.search_milliseconds=milliseconds
        if kind=='hint' and key!='Computer' and '~' in self.session.data.get('game','').split(';',1)[0]:
            self.hint_paused=True
            self.error="Arbitrary board positions can't be analyzed with this engine."
            return
        if kind=='computer':
            self.session.thoughts[self.session.data['side']]=dict(engine=self.engines.get(key)['name'],milliseconds=milliseconds,ply=self.session.data['ply']+1,status='thinking',started=time.monotonic(),evaluation=None)
        if key!='Computer':return self.launch_external(milliseconds,kind,key)
        revision = self.revision
        game = self.session.data['game']
        side = self.session.data['side']
        if self.book_enabled and game!=self.book_bypass_game:
            entry=self.book.lookup(game,[m['move'] for m in self.session.data['legal']])
            if entry:
                result=dict(move=entry['move'],depth=entry['depth'],nodes=0,score=entry['score'],seconds=0,side=side,source='book')
                if kind=='computer':
                    self.session.thoughts[side].update(status='played',evaluation=result)
                    self.move(entry['move'],source='book')
                else:self.hint=result
                return
        self.job = kind
        self.search_started = time.monotonic()
        self.search_finished = False
        proc = subprocess.Popen([executable(ROOT, 'bench_search'),game,'infinite' if milliseconds==0 else str(milliseconds),'--progress'],
                                stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',**process_options())
        self.process = proc
        def work():
            result = None; error = None
            try:
                def parse(line):
                    depth,nodes,score,seconds,move=line.rstrip('\n').split('\t')
                    return dict(move=move,depth=int(depth),nodes=int(nodes),score=int(score) if score else None,
                                seconds=float(seconds),side=side,source='search')
                watchdog=None
                if milliseconds:
                    def timeout():
                        if proc.poll() is None:proc.kill()
                    watchdog=threading.Timer(milliseconds/1000+5,timeout);watchdog.daemon=True;watchdog.start()
                try:
                    for line in proc.stdout:
                        result=parse(line)
                        with self.lock:
                            if revision!=self.revision or self.process is not proc:return
                            if kind=='computer':self.session.thoughts[side]['evaluation']=result
                            else:self.hint=result
                    proc.wait()
                    stderr=proc.stderr.read()
                finally:
                    if watchdog:watchdog.cancel()
                if proc.returncode:raise ValueError(stderr.strip() or 'Analysis was interrupted.')
            except Exception as exc:
                proc.kill(); proc.wait(); error=str(exc)
            finally:
                proc.stdout.close();proc.stderr.close();proc.wait()
            with self.lock:
                if revision != self.revision: return
                self.job = None; self.process = None
                if error:
                    self.error=error
                    if kind=='computer': self.pause()
                    return
                if self.expired(): return
                if kind=='computer':
                    self.session.thoughts[side].update(status='played',evaluation=result)
                    try: self.move(result['move'],source='search')
                    except Exception as exc: self.error=str(exc); self.pause()
                else: self.hint=result; self.search_finished=True
        threading.Thread(target=work,daemon=True).start()

    def launch_external(self,milliseconds,kind,key):
        session=self.session;entry=self.engines.get(key)
        if not entry:self.error='Selected engine is unavailable.';self.pause();return
        revision=self.revision;game=session.data['game'];side=session.data['side'];self.job=kind;self.search_started=time.monotonic();started=time.monotonic()
        def work():
            engine=None;error=None;move=None;reported_move=None;lines=[];adapter=None
            try:
                engine=UHP(entry['path'])
                with self.lock:
                    if revision!=self.revision:return
                    self.process=engine.proc
                engine.reply();adapter=configure_reporting(engine,entry,True,preserve_opening=kind=='computer');engine.command('newgame '+game)
                def progress(line,diagnostic=False):
                    candidate=None
                    if adapter=='mzinga' and not diagnostic and len(line.split(';'))>=3:candidate=line.split(';')[0]
                    elif adapter=='foulbrood' and diagnostic:
                        match=re.fullmatch(r'FoulBroodScore v1;depth=\d+;score=-?\d+;move=(.+)',line)
                        if match:candidate=match[1]
                    elif adapter=='nokamute' and diagnostic:
                        match=re.search(r'bestmove[= ]+([^;]+)',line)
                        if match:candidate=match[1].strip()
                    if not candidate:return
                    report=parse_score(adapter,[] if diagnostic else [line],[line] if diagnostic else [],side,candidate)
                    if not report:return
                    # UHP engines may report an equivalent move with a
                    # different reference string while they are thinking.
                    # Convert it to our legal move spelling before publishing
                    # it so the live board can always draw the preview.
                    canonical=candidate
                    with self.lock:
                        if revision!=self.revision:return
                        try:canonical=canonical_move(snapshot,session.data,candidate)
                        except (KeyError,ValueError,IndexError):pass
                        result=dict(move=canonical,nodes=0,score=None,seconds=time.monotonic()-started,side=side,source='external',engine=entry['name']);result.update(report)
                        if kind=='computer':session.thoughts[side]['evaluation']=result
                        else:self.hint=result
                engine.on_line=progress;engine.on_diagnostic=lambda line:progress(line,True)
                seconds=max(1,int(milliseconds/1000));limit=f'{seconds//3600:02}:{seconds//60%60:02}:{seconds%60:02}'
                lines=engine.command('bestmove time '+limit,seconds+3)
                if not lines:raise ValueError('Engine returned no move.')
                reported_move=lines[-1].split(';')[0];move=reported_move
                # Validate with our rules engine; UHP permits equivalent reference strings.
                following=snapshot('play',game,move)
                mark=following.get('last_move')
                if mark:move=next((m['move'] for m in session.data['legal'] if m['piece']==mark['piece'] and m.get('to')==mark['to']),move)
            except Exception as exc:error=str(exc)
            finally:
                if engine:engine.close()
            with self.lock:
                if revision!=self.revision:return
                self.process=None;self.job=None
                if error:
                    self.error=entry['name']+': '+error
                    if kind=='computer':self.pause()
                    return
                if self.expired():return
                result=dict(move=move,depth=None,nodes=0,score=None,seconds=time.monotonic()-started,side=side,source='external',engine=entry['name']);result.update(parse_score(adapter,lines,engine.diagnostics,side,reported_move))
                if kind=='hint':
                    self.hint=result;self.search_finished=True;return
                session.thoughts[side].update(status='played',evaluation=result)
                try:self.move(move,source=entry['name'])
                except Exception as exc:self.error=str(exc);self.pause()
        threading.Thread(target=work,daemon=True).start()

    def tick(self):
        with self.lock:
            s = self.session
            if self.review is not None:return
            if time.monotonic()-self.last_seen>15:
                if s.running:self.pause()
                elif self.job and not (self.job=='hint' and self.analysis_ms==0):self.invalidate()
                return
            if self.expired() or (self.mode=='play' and s.finished) or s.data['state'] in TERMINAL or s.timeout_side is not None or s.resigned_side is not None: return
            if self.mode=='play' and s.running and s.players[s.data['side']]!='Human':
                self.launch_search('computer',budget_ms(s.clock.values()[s.data['side']],s.clock.increment))
                if self.job=='computer' and self.hints and not self.hint_paused and not self.error:
                    self.launch_parallel_insight(self.analysis_ms)
            elif self.hints and not self.hint_paused and self.hint is None and not self.error:
                self.launch_search('hint',self.analysis_ms)

    def view(self):
        with self.lock:
            self.last_seen=time.monotonic()
            self.expired()
            self.capture_live_insights()
            s=self.session
            shown=s.review_data if self.mode=='play' and s.review_data is not None else s.data
            reviewing=self.mode=='play' and shown['ply']<len(s.review_game.split(';')[3:])
            if s.setup_placed and shown['ply']==0:
                shown=dict(shown);piece=next(p for p in shown['pieces'] if p['id']==s.setup_placed)
                shown['last_move']=dict(piece=piece['id'],from_=None,to=[piece['q'],piece['r']]);shown['last_move']['from']=shown['last_move'].pop('from_')
            insight=self.insight_worker or self
            recorded=reviewing or self.mode=='play' and s.finished or self.review and self.review.source=='in_game'
            finished=shown['ply']==len(s.review_game.split(';')[3:]) and (s.finished or s.reported_result in (*TERMINAL,'1-0','0-1','1/2-1/2'))
            return dict(**shown,recorded_analysis=visible_history(s.analysis_history,shown['ply'],finished=finished) if recorded else None,use_recorded_analysis=bool(recorded),review_work_available=bool(self.reviews_with_work()),analysis_review_available=self.analysis_review_available(),parallel_insight_allowed=self.parallel_insight_allowed(),insight_job=insight.job if insight.job=='hint' else None,engine_thoughts=[dict(t,elapsed=max(0,time.monotonic()-t['started']) if t['status']=='thinking' else (t.get('evaluation') or {}).get('seconds',0)) if t else None for t in s.thoughts],engines=self.engines.entries,builtin_connected=self.engines.builtin_connected,builtin_present=self.engines.builtin_present,analysis_engine=self.engines.analysis_engine,game_review=self.review.view() if self.review else None,setup_placed=s.setup_placed,reviewing=reviewing,review_game=s.review_game,live_game=s.data['game'],live_side=s.data['side'],mode=self.mode,players=s.players,time_control=s.time_control,
                        clocks=s.clock.values(),running=s.running,timeout_side=s.timeout_side,resigned_side=s.resigned_side,
                        import_info=s.import_info,player_names=s.player_names,reported_result=s.reported_result,play_finished=self.mode=='play' and s.finished,
                        completed_state=s.review_game.split(';')[1],review_total=len(s.review_game.split(';')[3:]),
                        book_available=self.book.data is not None,book_enabled=self.book_enabled,last_move_source=s.move_sources.get(shown['game']),search_elapsed=max(0,time.monotonic()-insight.search_started) if insight.job and insight.search_started is not None else None,search_finished=insight.search_finished,analysis_ms=self.analysis_ms,hints=self.hints,continuous_hints=self.continuous_hints,hint=None if reviewing else insight.hint,job=self.job,error=self.error or insight.error,revision=self.revision)

    def command(self, payload):
        with self.lock:
            action=payload['action'];s=self.session
            self.last_seen=time.monotonic();self.error=''
            if self.review and action in ('move','undo','analyze','hints','continuous_hints','calculate_instead','book_enabled'):
                raise ValueError('Return to Analysis to change or analyze this position.')
            if action=='review_start':
                selected=self.engines.get(self.engines.analysis_engine)
                if not selected or not selected.get('connected') or not selected.get('review_supported'):raise ValueError('Select an engine that supports game review.')
                self.engines.check_variant(selected['id'],s.data['game'].split(';')[0])
            if action in ('analyze','hints','continuous_hints','calculate_instead') and not self.engines.connected(self.engines.analysis_engine):
                raise ValueError('Connect an engine in Engine to use analysis.')
            if (action in ('analyze','calculate_instead') or action in ('hints','continuous_hints') and bool(payload.get('enabled'))):
                if self.engines.analysis_engine!='Computer' and '~' in s.data.get('game','').split(';',1)[0]:
                    raise ValueError("Arbitrary board positions can't be analyzed with this engine.")
            warning=self.review_clear_warning(payload)
            if warning and payload.get('confirm_review_clear') is not True:
                return dict(review_confirmation=warning)
            if action=='engine_select':
                self.capture_live_insights()
                key=payload.get('id')
                if not self.engines.connected(key):raise ValueError('Connect this engine first.')
                if self.review and not self.engines.get(key).get('review_supported'):raise ValueError('Choose an engine that supports game review.')
                self.stop_insight_worker();self.hint=None
                if self.job!='computer':self.invalidate()
                was_review=self.review is not None
                if was_review:self.leave_review()
                self.engines.analysis_engine=key
                self.hint_paused=False
                if key!='Computer' and self.analysis_ms in (0,500):self.analysis_ms=60000 if self.analysis_ms==0 else 2000
                self.engines.save()
                if was_review:self.command(dict(action='review_enter'))
            elif action=='engine_toggle':
                key=payload.get('id');connected=bool(payload.get('connected'))
                entry=self.engines.get(key)
                if not entry:raise ValueError('Engine not found.')
                if connected and 'checked_entry' in payload:
                    checked=payload['checked_entry']
                    if checked['path']!=entry['path']:raise ValueError('Engine program changed. Connect it again.')
                    for field in ('name','capabilities','score_adapter','score_format_check'):entry[field]=checked.get(field)
                    entry['review_supported']=entry.get('score_adapter') in ('foulbrood','mzinga','nokamute')
                entry['connected']=connected
                if not connected:
                    if key in self.play.players:
                        self.play.clock.pause();self.play.running=False;self.invalidate()
                        self.play.players=['Human' if p==key else p for p in self.play.players]
                    if key=='Computer':
                        self.hints=False;self.continuous_hints=False;self.invalidate()
                        if self.review:self.review.stop()
                if not self.engines.connected(self.engines.analysis_engine):
                    self.engines.analysis_engine='Computer' if self.engines.builtin_connected else next((e['id'] for e in self.engines.entries if e['connected'] and (not self.review or e.get('review_supported'))),None)
                    self.invalidate()
                    if self.review:self.review.stop()
                if self.engines.analysis_engine is None:self.hints=False
                if self.engines.analysis_engine!='Computer' and self.analysis_ms in (0,500):self.analysis_ms=60000 if self.analysis_ms==0 else 2000
                self.engines.save()
                if self.review and self.review.engine.get('id')!=self.engines.analysis_engine:
                    self.leave_review();self.command(dict(action='review_enter'))
            elif action=='engine_add':
                entry=self.engines.add(payload['entry'])
                if self.engines.analysis_engine is None:self.engines.analysis_engine=entry['id'];self.engines.save()
            elif action=='engine_remove':
                key=payload.get('id')
                if key in self.play.players:raise ValueError('Choose different players and reset the board before removing this engine.')
                if self.engines.analysis_engine==key:raise ValueError('Disconnect this engine before removing it.')
                self.engines.remove(key)
                self.saved_reviews={k:r for k,r in self.saved_reviews.items() if r.engine.get('id')!=key}
            elif action=='review_marks':
                if not self.review or self.mode!='analysis':raise ValueError('Open Game review first.')
                ply=payload.get('ply')
                if ply!=s.data['ply']:raise ValueError('The review position changed.')
                row=next((r for r in self.review.rows if r['ply']==ply),None)
                if not row or not row['alternative'] or row['alternative']==row['move']:return dict(mark=None)
                before=snapshot('undo',s.data['game'])
                move=next((m for m in before['legal'] if m['move']==row['alternative']),None)
                if not move or not move.get('to'):return dict(mark=None)
                piece=next((p for p in before['pieces'] if p['id']==move['piece']),None)
                return dict(mark=dict(piece=move['piece'],to=move['to'],origin=[piece['q'],piece['r']] if piece else None))
            elif action=='setup_source':
                source=payload.get('source')
                if source not in ('analysis','play'):raise ValueError('Choose Analysis or Play.')
                session=self.analysis if source=='analysis' else self.play
                data=session.data
                return dict(position=data,setup_placed=session.setup_placed)
            elif action=='review_enter':
                if self.mode!='analysis':raise ValueError('Open Analysis to review a game.')
                if self.review is None:
                    self.pause()
                    if self.analysis_ms==0:self.analysis_ms=60000
                    self.continuous_hints=False
                    selected=self.engines.get(self.engines.analysis_engine) or {}
                    key=(s.review_game,selected.get('id'),selected.get('path'))
                    saved=self.saved_reviews.pop(key,None)
                    if saved is None:
                        portable=next((k for k,r in self.saved_reviews.items() if r.game==s.review_game and r.portable_engine and r.matches_engine(selected)),None)
                        if portable is not None:saved=self.saved_reviews.pop(portable)
                    if saved:
                        self.review=saved
                        self.review.saved_hints=self.hints
                    else:self.review=Review(self,snapshot,ROOT)
                    self.hints=False
            elif action=='review_start':
                if not self.review:raise ValueError('Open Game review first.')
                if not self.review.total:raise ValueError('Load a game with moves to review.')
                self.review.start()
            elif action=='review_source':
                if not self.review:raise ValueError('Open Game review first.')
                source=payload.get('source')
                if source not in ('in_game','review'):raise ValueError('Choose an analysis source.')
                if source=='in_game' and not s.analysis_history:raise ValueError('No in-game analysis was recorded.')
                if self.review.status=='running':raise ValueError('Stop review before changing its source.')
                self.review.source=source;self.revision+=1
            elif action=='review_stop':
                if self.review:self.review.stop()
            elif action=='review_exit':
                if self.review:
                    self.leave_review()
                    self.hint_paused=True
            elif action=='review_save':
                if self.mode!='analysis':raise ValueError('Open Analysis first.')
                selected=self.engines.get(self.engines.analysis_engine) or {}
                saved=[r for r in reversed(list(self.saved_reviews.values())) if r.game==s.review_game]
                review=self.review or next((r for r in saved if r.matches_engine(selected)),None) or next(iter(saved),None)
                if review is None:review=Review(self,snapshot,ROOT)
                return save_review(review,s)
            elif action=='export':
                game=s.review_game
                result=s.reported_result if self.mode=='analysis' else None
                if self.mode=='play':
                    loser=s.resigned_side if s.resigned_side is not None else s.timeout_side
                    if loser is not None:result='BlackWins' if loser==0 else 'WhiteWins'
                exported=export_game(game,payload.get('format'),result)
                if s.setup_placed:
                    if payload.get('format')=='pgn':exported['text']='[FoulBroodPlaced "'+s.setup_placed+'"]\n'+exported['text']
                    else:
                        value=json.loads(exported['text']);value['setup_placed']=s.setup_placed;exported['text']=json.dumps(value,indent=2)
                return exported
            elif action=='new':
                control=payload['time'];players=payload['players']
                if control not in TIMES or len(players)!=2 or any(x!='Human' and not self.engines.connected(x) for x in players):
                    raise ValueError('Choose a valid time control and players.')
                for player in players:
                    if player not in ('Human','Computer'):self.engines.check_variant(player,payload['variant'])
                data=snapshot('snapshot',payload['variant'])
                self.leave_review()
                self.pause();self.mode='play';self.play=Session(data,control,players)
                self.play.running=True;self.play.start_turn_clock();self.hint_paused=False
            elif action=='reset_play':
                if self.mode!='play':raise ValueError('Open Play first.')
                data=snapshot('snapshot',s.data['game'].split(';')[0])
                self.leave_review()
                self.pause();self.play=Session(data,s.time_control,s.players.copy())
                self.hints=False;self.hint_paused=False
            elif action=='mode':
                mode=payload['mode']
                if mode not in ('play','analysis'): raise ValueError('Unknown mode.')
                self.leave_review()
                self.pause()
                if mode=='analysis' and self.analysis is None:
                    self.analysis=Session(snapshot('snapshot',self.play.data['game']),players=['Human','Human'])
                self.mode=mode
            elif action=='toggle':
                if self.mode!='play': raise ValueError('Analysis has no clock.')
                if s.running: self.pause()
                elif not s.finished:
                    self.invalidate();s.running=True;s.start_turn_clock()
            elif action=='move':
                if self.mode=='play' and (s.review_data is not None or not s.running or s.players[s.data['side']]!='Human'):
                    raise ValueError('Resume play on a human turn to make a move.')
                self.move(payload['move'])
            elif action=='book_enabled':
                self.book_enabled=bool(payload['enabled'])
                if self.job!='computer':self.invalidate()
                self.book_bypass_game=None
            elif action=='calculate_instead':
                if self.job=='computer':raise ValueError('FoulBrood is already calculating its turn.')
                self.invalidate();self.book_bypass_game=s.data['game']
                self.hints=True;self.hint_paused=False
                self.launch_search('hint',self.analysis_ms)
            elif action=='open_analysis':
                if self.mode!='play':raise ValueError('Open a Play position in Analysis.')
                target=payload.get('ply',s.review_data['ply'] if s.review_data is not None else s.data['ply'])
                if type(target) is not int or not 0<=target<=len(s.review_game.split(';')[3:]):raise ValueError('Invalid history move.')
                import copy
                self.discard_analysis_reviews()
                self.pause()
                analysis=Session(copy.deepcopy(s.data),players=['Human','Human'])
                analysis.review_game=s.review_game
                analysis.review_cache=copy.deepcopy(s.review_cache)
                analysis.player_names=s.player_names.copy()
                analysis.import_info=s.import_info
                analysis.analysis_history=copy.deepcopy(s.analysis_history)
                loser=s.resigned_side if s.resigned_side is not None else s.timeout_side
                analysis.reported_result=('BlackWins' if loser==0 else 'WhiteWins') if loser is not None else s.reported_result
                self.analysis=analysis;self.mode='analysis'
                self.command(dict(action='navigate',ply=target))
                if s.finished:return self.command(dict(action='review_enter'))
                return self.view()
            elif action=='navigate':
                moves=s.review_game.split(';')[3:];total=len(moves)
                cursor=s.review_data['ply'] if self.mode=='play' and s.review_data is not None else s.data['ply']
                targets={'first':0,'previous':max(0,cursor-1),'next':min(total,cursor+1),'last':total}
                if 'ply' in payload:
                    target=payload['ply']
                    if type(target) is not int or not 0<=target<=total:raise ValueError('Invalid history move.')
                else:
                    if payload.get('direction') not in targets:raise ValueError('Unknown history direction.')
                    target=targets[payload['direction']]
                nearest=min(s.review_cache,key=lambda n:abs(n-target));data=s.review_cache[nearest]
                while data['ply']!=target:
                    data=snapshot('undo',data['game']) if data['ply']>target else snapshot('play',data['game'],moves[data['ply']])
                    s.review_cache[data['ply']]=data
                if self.mode=='play':
                    # The live board, clock and in-flight search remain authoritative.
                    s.review_data=data if target<total else None
                else:
                    self.pause();s.data=data
            elif action=='undo':
                was_running=self.mode=='play' and s.running
                s.review_data=None
                if self.mode=='play' and s.finished:
                    s.data=snapshot('snapshot',s.review_game)
                if s.resigned_side is not None:
                    self.pause();s.resigned_side=None
                    return self.view()
                if not s.data['ply']: raise ValueError('There are no moves to take back.')
                data=snapshot('undo',s.data['game'])
                if self.mode=='analysis':self.discard_analysis_reviews()
                self.pause();s.data=data;s.timeout_side=None;s.thoughts=[None,None]
                s.analysis_history={ply:r for ply,r in s.analysis_history.items() if ply<data['ply']}
                s.review_game=data['game'];s.review_cache={data['ply']:data}
                if s.past_clocks: s.clock.remaining=s.past_clocks.pop()
                if was_running and not s.finished:
                    s.running=True;s.start_turn_clock()
            elif action=='resign':
                side=payload.get('side')
                if self.mode!='play' or side not in (0,1) or s.players[side]!='Human':
                    raise ValueError('Only a human player can resign a game.')
                if self.expired() or s.timeout_side is not None or s.resigned_side is not None or s.data['state'] in TERMINAL:
                    raise ValueError('This game has already ended.')
                self.pause();s.resigned_side=side
            elif action in ('hints','insight_time','continuous_hints','analyze','stop_analysis'):
                if action=='insight_time' and (self.job=='hint' or (self.insight_worker and self.insight_worker.job=='hint') or (self.review and self.review.status=='running')):
                    raise ValueError('Stop analysis before changing the thinking time.')
                milliseconds=int(payload.get('milliseconds',self.analysis_ms))
                if (self.review or self.engines.analysis_engine!='Computer') and milliseconds==0:milliseconds=60000
                if milliseconds==500:milliseconds=2000
                if milliseconds==-1 and (self.mode!='play' or self.review):raise ValueError('Match timing is available only on Play.')
                if milliseconds not in (-1,0,2000,5000,10000,60000,600000,3600000,86400000):raise ValueError('Invalid analysis duration.')
                if self.review and action=='insight_time':self.review.stop();self.review.status='ready'
                if action=='analyze' and self.job=='computer' and not self.parallel_insight_allowed():raise ValueError('The selected engine is choosing its move.')
                self.stop_insight_worker()
                hint=self.hint
                # Insight controls must never cancel a computer's actual turn.
                if self.job!='computer':self.invalidate()
                self.analysis_ms=milliseconds
                if action=='continuous_hints':
                    self.continuous_hints=bool(payload['enabled'])
                    self.analysis_ms=(0 if self.engines.analysis_engine=='Computer' else 60000) if self.continuous_hints else 2000
                    if self.continuous_hints:self.hints=True
                    self.hint_paused=False
                elif action=='hints':
                    self.hints=bool(payload['enabled']);self.hint_paused=False
                    if not self.hints:self.hint=None
                elif action in ('stop_analysis','insight_time'):
                    self.hint=hint;self.hint_paused=True
                elif action=='analyze':
                    self.book_bypass_game=s.data['game']
                    self.hints=True;self.hint_paused=False
                    if s.data['state'] not in TERMINAL:self.launch_search('hint',self.analysis_ms)
                else:self.hint_paused=False
            elif action=='setup_position':
                if self.mode!='analysis':raise ValueError('Open Analysis to set up a position.')
                root=setup_root(payload)
                data=snapshot('snapshot',root)
                placed=payload.get('last',{}).get('piece') if isinstance(payload.get('last'),dict) and payload['last'].get('kind')=='placed' else None
                validate_setup_placed(data,placed)
                self.discard_analysis_reviews()
                self.pause();self.analysis=Session(data,players=['Human','Human']);self.analysis.setup_placed=placed
                self.analysis.import_info='Set-up position. Earlier repetitions are unknown.'
                self.hint_paused=True
            elif action in ('load','review_load'):
                text=payload['text'].strip()
                if not text: raise ValueError('Paste a saved game or enter one move per line.')
                export=read_export(text,payload.get('filename',''))
                info=''
                if export:
                    variant,moves,info=export;data=snapshot('snapshot',variant)
                    for number,move in enumerate(moves,1):
                        try:data=snapshot('play',data['game'],move)
                        except ValueError as exc:raise ValueError(f'Import stopped at move {number} ({move}): {exc}') from exc
                elif ';' in text: data=snapshot('snapshot',text)
                else:
                    lines=[x.strip() for x in text.splitlines() if x.strip()]
                    variant=payload.get('variant','Base+MLP')
                    if lines[0].startswith('Base'):variant=lines.pop(0)
                    data=snapshot('snapshot',variant)
                    for move in lines:data=snapshot('play',data['game'],move)
                placed=None
                if text.startswith('{'):placed=json.loads(text).get('setup_placed')
                else:
                    marker=re.search(r'^\[FoulBroodPlaced "([^"]+)"\]$',text,re.M);placed=marker[1] if marker else None
                if placed:validate_setup_placed(snapshot('snapshot',';'.join(data['game'].split(';')[:1])),placed)
                saved=read_review(text,data['game']) if action=='review_load' else None
                if saved:
                    if saved['setup_placed']!=placed:raise ValueError('Saved setup information does not match the game.')
                    for entry in saved['in_game_history'].values():
                        board=snapshot('snapshot',entry['game'])
                        if board['game']!=entry['game'] or entry['evaluation']['move'] not in {m['move'] for m in board['legal']}:raise ValueError('Saved in-game analysis contains an unavailable move.')
                    # Resolve and validate the saved cursor/checkpoints before discarding work.
                    cursor=data
                    while cursor['ply']>saved['cursor']:cursor=snapshot('undo',cursor['game'])
                    checkpoint=data
                    while checkpoint['ply']>len(saved['rows']):checkpoint=snapshot('undo',checkpoint['game'])
                    for evaluation,board in [(saved['before'],checkpoint)]:
                        if evaluation and evaluation['move'] and evaluation['move'] not in {m['move'] for m in board['legal']}:raise ValueError('Saved review contains an unavailable move.')
                    if saved['pending_played']:
                        after=snapshot('play',checkpoint['game'],data['game'].split(';')[3+len(saved['rows'])])
                        move=saved['pending_played']['move']
                        if move and move not in {m['move'] for m in after['legal']}:raise ValueError('Saved review contains an unavailable reply.')
                stay_in_review=self.review is not None
                self.discard_analysis_reviews()
                self.pause();self.mode='analysis';self.analysis=Session(data,players=['Human','Human']);self.analysis.import_info=info;self.analysis.reported_result=reported_result(text);self.analysis.player_names=player_names(text);self.analysis.setup_placed=placed
                if saved:
                    self.analysis.analysis_history=saved['in_game_history']
                    engine=next((e for e in self.engines.entries if e.get('connected') and e.get('review_supported') and engine_matches(saved['engine'],e)),None)
                    self.engines.analysis_engine=engine['id'] if engine else None
                    self.analysis_ms=saved['milliseconds'];self.continuous_hints=False;self.hint_paused=True
                    self.analysis.player_names=saved['players'];self.analysis.reported_result=saved['result']
                    self.analysis.data=cursor;self.analysis.review_cache[cursor['ply']]=cursor
                    self.review=Review(self,snapshot,ROOT);self.review.restore(saved,engine);self.hints=False
                elif stay_in_review:self.command(dict(action='review_enter'))
            else: raise ValueError('Unknown action.')
            return self.view()


def validate_setup_placed(data,piece):
    if piece is None:return
    if not isinstance(piece,str) or '~' not in data['game'].split(';')[0]:raise ValueError('Invalid placed bug.')
    p=next((p for p in data['pieces'] if p['id']==piece),None)
    if not p or p['level']!=0 or any(x['q']==p['q'] and x['r']==p['r'] and x['level']>0 for x in data['pieces']):raise ValueError('A placed bug must be alone on its hex.')


def setup_root(payload):
    import re
    variant=payload.get('variant','Base+MLP')
    if not isinstance(variant,str) or not re.fullmatch(r'Base(?:\+[MLP]{1,3})?',variant):raise ValueError('Choose a supported piece set.')
    side=payload.get('side');turn=payload.get('turn')
    if type(side) is not int or side not in (0,1) or type(turn) is not int or not 1<=turn<=200:raise ValueError('Choose a side and a turn number from 1 to 200.')
    pieces=payload.get('pieces')
    if not isinstance(pieces,list) or len(pieces)>28:raise ValueError('Invalid piece arrangement.')
    def piece_id(value):
        if not isinstance(value,str) or not re.fullmatch(r'[wb][QABGSLMP][123]?',value):raise ValueError('Invalid piece.')
        return value
    def coord(value):
        if type(value) is not int or not -100<=value<=100:raise ValueError('Keep the position within 100 hexes of the center.')
        return value
    encoded=[]
    for p in pieces:
        if not isinstance(p,dict) or type(p.get('level')) is not int or not 0<=p['level']<=6:raise ValueError('Invalid stack.')
        encoded.append(f"{piece_id(p.get('id'))}:{coord(p.get('q'))}:{coord(p.get('r'))}:{p['level']}")
    last=payload.get('last');tail=''
    if last and not (isinstance(last,dict) and last.get('kind')=='placed'):
        if not isinstance(last,dict) or not isinstance(last.get('from'),list) or len(last['from'])!=2:raise ValueError('Choose the previous hex of the last moved piece.')
        tail=f"{piece_id(last.get('piece'))}:{coord(last['from'][0])}:{coord(last['from'][1])}"
    return f"{variant}~{side}~{turn}~{','.join(encoded)}~{tail}"


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--port',type=int,default=0);ap.add_argument('--state-file',required=True)
    args=ap.parse_args();app=App();token=secrets.token_urlsafe(32)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def send(self,code,body,content='application/json'):
            self.send_response(code);self.send_header('Content-Type',content);self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff');self.send_header('Content-Length',str(len(body)))
            self.end_headers();self.wfile.write(body)
        def do_GET(self):
            if self.headers.get('Host')!=f'127.0.0.1:{self.server.server_port}':
                self.send(403,b'{}');return
            path=urlparse(self.path).path
            if path=='/':
                html=(ROOT/'ui/index.html').read_text().replace('__TOKEN__',token)
                self.send(200,html.encode(),'text/html; charset=utf-8')
            elif path=='/api/state':self.send(200,json.dumps(app.view()).encode())
            elif path=='/health':self.send(200,json.dumps(dict(app='foulbrood-local-board',bundle_path=str(ROOT),build_id=os.environ.get('FOULBROOD_BUILD_ID','development'))).encode())
            elif path=='/foulbrood-hive.png':self.send(200,(ROOT/'ui/foulbrood-hive.png').read_bytes(),'image/png')
            elif path in ('/app.js','/pieces.js','/review.js','/engines.js','/style.css'):
                self.send(200,(ROOT/'ui'/path[1:]).read_bytes(),'text/javascript' if path.endswith('js') else 'text/css')
            else:self.send(404,b'{}')
        def do_POST(self):
            origin=f'http://127.0.0.1:{self.server.server_port}'
            if self.headers.get('Host')!=origin[7:] or self.headers.get('Origin')!=origin or self.headers.get('X-Board-Token')!=token:
                self.send(403,b'{"error":"Open this board locally to use it."}');return
            try:
                if self.path!='/api/action':raise ValueError('Unknown endpoint.')
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=MAX_REVIEW_BYTES+200000:raise ValueError('Position text is too large.')
                payload=json.loads(self.rfile.read(size))
                if payload.get('action')=='engine_discover':
                    self.send(200,json.dumps(discover_engines()).encode());return
                if payload.get('action')=='engine_browse':
                    self.send(200,json.dumps(dict(path=choose_engine())).encode());return
                if payload.get('action')=='engine_toggle' and payload.get('connected') and payload.get('id')!='Computer':
                    with app.lock:entry=app.engines.get(payload.get('id'))
                    if not entry:raise ValueError('Engine not found.')
                    payload['checked_entry']=inspect_engine(entry['path'])
                if payload.get('action')=='engine_add':
                    payload={'action':'engine_add','entry':inspect_engine(payload.get('path',''))}
                if payload.get('action')=='load_link':
                    with app.lock:warning=app.review_clear_warning(dict(payload,action='load'))
                    if warning and payload.get('confirm_review_clear') is not True:
                        self.send(200,json.dumps(dict(review_confirmation=warning)).encode());return
                    payload={'action':'load','text':fetch_game(payload.get('url')),'filename':'hivegame.pgn','confirm_review_clear':payload.get('confirm_review_clear')}
                if payload.get('action')=='notation':
                    with app.lock:game=app.session.review_game
                    result=dict(game=game,rows=notation(game))
                elif payload.get('action')=='notation_move':
                    result=notation_move(payload['game'],payload['move'])
                else:result=app.command(payload)
                self.send(200,json.dumps(result).encode())
            except Exception as exc:self.send(400,json.dumps(dict(error=str(exc))).encode())
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    Path(args.state_file).write_text(json.dumps(dict(url=f'http://127.0.0.1:{server.server_port}',pid=os.getpid())))
    def tick():
        while True:
            time.sleep(.1)
            try:app.tick()
            except Exception as exc:
                with app.lock: app.error=str(exc);app.pause()
    threading.Thread(target=tick,daemon=True).start()
    server.serve_forever()


if __name__=='__main__':main()

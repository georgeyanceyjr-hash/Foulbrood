"""Cancellable full-history review, using equal budgets for compared continuations."""
import subprocess
from pathlib import Path
import math
import threading
import time
from external_engines import UHP, configure_reporting, parse_score, review_score, canonical_move
from review_file import engine_matches
from live_analysis import history_points

TERMINAL=('WhiteWins','BlackWins','Draw')

def classify(best, played, same_move=False, best_depth=None, played_depth=None):
    """Scores are from the mover's perspective. Raw 60/150/300 cut-offs in a close game,
    fading as the position is decided (losses measured on 100*tanh(score/600))."""
    if same_move:return 'Best move',''
    if best is None or played is None:return 'Uncertain',''
    mate=lambda x:abs(x)>99000
    view=lambda x:(100 if x>0 else -100) if mate(x) else max(-99,min(99,100*math.tanh(x/600)))
    if mate(best) and mate(played) and (best>0)==(played>0):return 'No clear error',''
    vb,vp=view(best),view(played);loss=max(0,vb-vp)
    if best>99000 and vp<90:return 'Missed win','∅'
    uneven=best_depth is not None and played_depth is not None and best_depth!=played_depth and not mate(best) and not mate(played)
    if loss>=46:return 'Blunder','??'
    if loss>=24:return 'Mistake','?'
    if loss>=10:return ('Uncertain','') if uneven else ('Inaccuracy','?!')
    return 'No clear error',''

def white_score(result):
    return None if result['score'] is None else result['score']*(1 if result['side']==0 else -1)

class Review:
    def __init__(self, app, snapshot, root):
        self.app=app;self.snapshot=snapshot;self.root=root
        self.game=app.session.review_game;self.rows=[];self.points=[];self.status='ready';self.error='';self.total=len(self.game.split(';')[3:]);self.milliseconds=app.analysis_ms
        self.engine=dict(app.engines.get(app.engines.analysis_engine) or {});self.generation=0;self.process=None;self.stage='';self.working_ply=0;self.phase_started=None;self.remaining_units=2*self.total+1;self.saved_hints=app.hints;self.before=None;self.pending_played=None
        self.portable_engine=None
        self.book_review_supported=None
        self.in_game_history=app.session.analysis_history
        self.source='in_game' if self.in_game_history else 'review'

    def matches_engine(self,selected):
        if self.portable_engine:return engine_matches(self.portable_engine,selected)
        return self.engine.get('id')==selected.get('id') and self.engine.get('path')==selected.get('path')

    def restore(self,saved,engine):
        self.portable_engine=saved['engine']
        self.engine=dict(engine or dict(id=None,name=self.portable_engine['name']))
        for name in ('rows','points','before','pending_played','milliseconds','status','error'):setattr(self,name,saved[name])
        self.working_ply=len(self.rows)
        self.source=saved['analysis_source']
        self.remaining_units=0 if self.status=='complete' else 2*(self.total-len(self.rows))+(0 if self.before else 1)-(1 if self.pending_played else 0)

    def has_work(self):
        return bool(self.rows or self.points or self.in_game_history or self.status=='running')

    def can_resume(self):
        selected=self.app.engines.get(self.app.engines.analysis_engine) or {}
        return bool((self.rows or self.points) and len(self.rows)<self.total
                    and selected.get('connected') and self.matches_engine(selected)
                    and self.milliseconds==self.app.analysis_ms)

    def view(self):
        remaining=max(0,self.remaining_units*self.milliseconds/1000-(time.monotonic()-self.phase_started if self.phase_started is not None else 0))
        selected=self.app.engines.get(self.app.engines.analysis_engine) or {}
        missing=bool(self.portable_engine and not (selected.get('connected') and self.matches_engine(selected)))
        recorded=self.source=='in_game'
        return dict(source=self.source,recorded_count=len(self.in_game_history),restored=bool(self.portable_engine),resume_engine_missing=missing and not recorded,can_resume=self.can_resume(),engine=self.engine.get('name',''),external=not self.portable_engine['builtin'] if self.portable_engine else self.engine.get('id')!='Computer',remaining_seconds=remaining,working_ply=self.working_ply,active=True,status='recorded' if recorded else self.status,error=self.error,total=self.total,rows=[] if recorded else self.rows.copy(),points=history_points(self.in_game_history) if recorded else self.points.copy(),milliseconds=self.milliseconds,stage=self.stage,extras=list(getattr(self,'extras',{}).values()))

    def side(self,kind,ply,move=None):
        """One extra search beside the finished review: the engine's line after its preferred move
        ('line'), or a different move the user wants graded ('try')."""
        if self.status=='running':raise ValueError('Stop the review first.')
        if getattr(self,'side_busy',False):raise ValueError('Still working on the last request.')
        row=next((r for r in self.rows if r['ply']==ply),None)
        if not row:raise ValueError('Review this move first.')
        if not hasattr(self,'extras'):self.extras={}
        key=(kind,ply)
        self.extras[key]=dict(kind=kind,ply=ply,status='running',move=move)
        self.side_busy=True;generation=self.generation;units=self.remaining_units
        def work():
            try:
                data=self.snapshot('snapshot',self.game)
                while data['ply']>ply-1:data=self.snapshot('undo',data['game'])
                if kind=='line':
                    moves=[];steps=[];position=data
                    following=row['alternative'] if row.get('alternative') else row['move']
                    for k in range(4):
                        position=self.snapshot('play',position['game'],following)
                        moves.append(following);steps.append(dict(pieces=position['pieces'],last_move=position.get('last_move')))
                        if position['state'] in TERMINAL or k==3:break
                        if k==0 and row.get('reply'):following=row['reply']
                        else:
                            found=self.evaluate(position,generation,min(self.milliseconds,2000))
                            if not found.get('move'):break
                            following=found['move']
                    result=dict(moves=moves,steps=steps)
                else:
                    if move not in {m['move'] for m in data['legal']}:raise ValueError('That move is not available here.')
                    position=self.snapshot('play',data['game'],move)
                    # The board can show the tried move straight away, while it is still being graded.
                    with self.app.lock:self.extras[key].update(pieces=position['pieces'],last_move=position.get('last_move'),side=data['side'])
                    found=self.evaluate(position,generation)
                    result=dict(score=white_score(found),depth=found['depth'],side=data['side'],pieces=position['pieces'],last_move=position.get('last_move'))
                with self.app.lock:
                    self.extras[key].update(result,status='ready')
            except InterruptedError:
                with self.app.lock:self.extras.pop(key,None)
            except Exception as exc:
                with self.app.lock:self.extras[key].update(status='error',error=str(exc))
            finally:
                with self.app.lock:
                    self.side_busy=False;self.remaining_units=units;self.phase_started=None
                    try:self.app.revision+=1
                    except Exception:pass
        threading.Thread(target=work,daemon=True).start()

    def stop(self):
        self.generation+=1
        if self.process and self.process.poll() is None:self.process.terminate()
        self.process=None
        if self.status=='running':self.status='stopped'
        self.stage='';self.phase_started=None

    def check(self, generation):
        if generation!=self.generation:raise InterruptedError()

    def show_position(self,data,generation):
        with self.app.lock:
            self.check(generation)
            if self.app.mode!='analysis' or self.app.review is not self:return
            session=self.app.analysis
            if session.review_game!=self.game:return
            session.review_cache[data['ply']]=data
            if session.data['game']!=data['game']:
                session.data=data;self.app.revision+=1

    def evaluate(self,data,generation,ms=None):
        with self.app.lock:
            self.check(generation)
            if data['state'] in TERMINAL:
                self.remaining_units=max(0,self.remaining_units-1)
                score=0 if data['state']=='Draw' else (100000 if (data['state']=='WhiteWins')==(data['side']==0) else -100000)
                return dict(score=score,side=data['side'],depth=64,move=None,terminal=True)
            if self.engine.get('id')!='Computer':
                external=True
            else:external=False
        if external:return self.evaluate_external(data,generation,ms)
        with self.app.lock:
            self.check(generation)
            proc=subprocess.Popen([str(self.root/'target/release/bench_search'),data['game'],str(ms or self.milliseconds)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            self.process=proc;self.phase_started=time.monotonic()
        try:
            stdout,stderr=proc.communicate(timeout=(ms or self.milliseconds)/1000+5)
            with self.app.lock:self.check(generation)
            if proc.returncode:raise ValueError(stderr.strip() or 'Review search was interrupted.')
            depth,nodes,score,seconds,move=stdout.rstrip('\n').split('\t')
            if move not in {m['move'] for m in data['legal']}:raise ValueError('Review returned an unavailable move.')
            with self.app.lock:
                self.check(generation);self.remaining_units=max(0,self.remaining_units-1);self.phase_started=None
            return dict(score=int(score) if score else None,side=data['side'],depth=int(depth),move=move,terminal=False)
        finally:
            if proc.poll() is None:proc.kill()
            proc.communicate()
            with self.app.lock:
                if self.process is proc:self.process=None;self.phase_started=None

    def evaluate_external(self,data,generation,ms=None):
        engine=None
        try:
            with self.app.lock:
                self.check(generation)
                engine=UHP(self.engine['path']);self.process=engine.proc;self.phase_started=time.monotonic()
            info=engine.reply();adapter=configure_reporting(engine,self.engine,True)
            flags=set(';'.join(info).split(';'))
            if 'FoulBroodReviewSearch' in flags:engine.command('options set ReviewSearch True')
            # A review needs a searched score for every position: the book only names moves (they are marked separately).
            if adapter=='foulbrood':engine.command('options set UseBook False')
            engine.command('newgame '+data['game'])
            seconds=max(1,int((ms or self.milliseconds)/1000))
            limit=f'{seconds//3600:02}:{seconds//60%60:02}:{seconds%60:02}'
            lines=engine.command('bestmove time '+limit,seconds+3)
            if not lines:raise ValueError('Engine returned no move.')
            reported=lines[-1].split(';')[0]
            move=canonical_move(self.snapshot,data,reported)
            # Drain diagnostic scores before interpreting them (Nokamute uses stderr).
            engine.close()
            report=parse_score(adapter,lines,engine.diagnostics,data['side'],reported,final=True)
            if not report:raise ValueError(self.engine['name']+' did not report a score. Try a longer thinking time.')
            white=review_score(report,adapter)
            if adapter=='foulbrood' and report.get('score_status')=='last_complete':
                # The completed score belongs to evalmove, not a later partial choice.
                evaluated=report.get('evaluated_move')
                move=evaluated if evaluated in {m['move'] for m in data['legal']} else None
                if move is None:white=None
            with self.app.lock:
                self.check(generation);self.remaining_units=max(0,self.remaining_units-1);self.phase_started=None
            return dict(score=white*(1 if data['side']==0 else -1) if white is not None else None,
                        side=data['side'],depth=report['depth'] if report['depth'] is not None and move is not None else 0,move=move,terminal=False)
        finally:
            if engine:engine.close()
            with self.app.lock:
                if engine and self.process is engine.proc:self.process=None;self.phase_started=None

    def book_moves(self,data,generation):
        """Ask this profile for repertoire membership, never for a random choice."""
        if self.engine.get('id')=='Computer' or self.engine.get('score_adapter')!='foulbrood' or self.book_review_supported is False:return []
        engine=None
        try:
            with self.app.lock:
                self.check(generation)
                engine=UHP(self.engine['path']);self.process=engine.proc
            info=engine.reply();flags=set(';'.join(info).split(';'))
            if 'FoulBroodBookMoves' not in flags:
                # No membership command: read the engine's own book file, using its position-key commands.
                moves=self.book_file_moves(engine,data)
                with self.app.lock:self.check(generation)
                return moves
            self.book_review_supported=True
            engine.command('newgame '+data['game'])
            lines=engine.command('bookmoves')
            moves=[m for line in lines for m in line.split(';') if m]
            legal={m['move'] for m in data['legal']}
            if any(m not in legal for m in moves):raise ValueError('Book returned an unavailable move.')
            with self.app.lock:self.check(generation)
            return moves
        finally:
            if engine:engine.close()
            with self.app.lock:
                if engine and self.process is engine.proc:self.process=None

    def book_file_moves(self,engine,data):
        """Book moves for this position from `thoraxrex-book.txt` beside the engine. The book stores one
        orientation of each position, so all 12 turns and mirrors are tried, as the engine itself does."""
        if getattr(self,'book_misses',0)>=6:return []          # well out of book: stop asking
        book=getattr(self,'book_file',None)
        if book is None:
            book={}
            try:
                for line in (Path(self.engine['path']).parent/'thoraxrex-book.txt').read_text().splitlines():
                    parts=line.split(None,2)
                    if len(parts)==3 and len(parts[0])==16 and parts[1].isdigit() and int(parts[1])>0:book.setdefault(parts[0],[]).append(parts[2].strip())
            except OSError:pass
            self.book_file=book
        if not book:self.book_review_supported=False;return []
        engine.command('newgame '+data['game'])
        found=[]
        for turn in range(12):
            reply=engine.command('key' if turn==0 else f'symkey {turn}')
            key=reply[0].strip() if reply else ''
            if len(key)!=16:self.book_review_supported=False;return []   # an engine without these commands
            for stored in book.get(key,[]):
                candidates=[stored]
                if turn and ' ' in stored:
                    # Turn the stored move back: the orientation u that `turn` maps onto the stored move.
                    candidates=[]
                    for u in range(12):
                        back=(engine.command(f'symmove {u} {stored}') or [''])[0].strip()
                        if back and (engine.command(f'symmove {turn} {back}') or [''])[0].strip()==stored:candidates.append(back)
                for candidate in candidates:
                    try:move=canonical_move(self.snapshot,data,candidate)
                    except Exception:continue
                    if move not in found:found.append(move)
            if found:break
        self.book_misses=0 if found else getattr(self,'book_misses',0)+1
        return found

    def start(self):
        resume=self.can_resume()
        self.stop()
        if not resume:self.rows=[];self.points=[];self.before=None;self.pending_played=None
        if not resume:self.extras={}
        self.book_misses=0
        self.engine=dict(self.app.engines.get(self.app.engines.analysis_engine) or {});self.error='';self.status='running';self.milliseconds=self.app.analysis_ms
        self.book_review_supported=None
        def usable(result):
            return result and (result['terminal'] or (type(result['depth']) is int and result['depth']>0 and type(result['score']) in (int,float) and math.isfinite(result['score']) and result['move'] is not None))
        if self.before and not usable(self.before):
            self.before=dict(score=None,side=self.before['side'],depth=0,move=None,terminal=False)
        if self.pending_played and not usable(self.pending_played):self.pending_played=None
        self.portable_engine=None
        self.source='review'
        completed=len(self.rows)
        self.remaining_units=2*(self.total-completed)+(0 if self.before else 1)-(1 if self.pending_played else 0)
        self.working_ply=completed;self.stage='Resuming review' if resume else 'Starting position'
        generation=self.generation
        def work():
            try:
                # Undo preserves custom setup roots and full repetition history.
                data=self.snapshot('snapshot',self.game)
                while data['ply']>completed:
                    with self.app.lock:self.check(generation)
                    data=self.snapshot('undo',data['game'])
                with self.app.lock:self.check(generation);before=self.before
                self.show_position(data,generation)
                for i,move in enumerate(self.game.split(';')[3+completed:],completed+1):
                    after=self.snapshot('play',data['game'],move)
                    with self.app.lock:
                        self.check(generation);self.working_ply=i;self.stage=f'Move {i} of {self.total} · book check'
                    if move in self.book_moves(data,generation):
                        # A repertoire decision has no searched score or depth.
                        checkpoint=dict(score=None,side=after['side'],depth=0,move=None,terminal=False)
                        row=dict(ply=i,move=move,side=data['side'],label='Book move',symbol='',score=None,best_score=None,alternative=None,reply=None,depth=0,best_depth=0)
                        with self.app.lock:
                            self.check(generation)
                            if not self.points:self.points=[dict(ply=0,score=None)]
                            self.rows.append(row);self.points.append(dict(ply=i,score=None));self.before=checkpoint;self.pending_played=None
                            self.remaining_units=2*(self.total-i)+(1 if i<self.total else 0)
                        self.show_position(after,generation)
                        data=after;before=checkpoint
                        continue
                    # Following a skipped book move, search the parent lazily.
                    # Keep its unscored checkpoint unchanged until this row commits.
                    if before is None or (not before['terminal'] and before['move'] is None):
                        with self.app.lock:
                            self.check(generation);self.stage=f'Move {i} of {self.total} · evaluating out-of-book move'
                        before=self.evaluate(data,generation)
                        with self.app.lock:
                            self.check(generation)
                            if not self.rows:self.before=before;self.points=[dict(ply=0,score=white_score(before))]
                    with self.app.lock:
                        self.check(generation);self.working_ply=i;self.stage=f'Move {i} of {self.total} · {move} · played move'
                        self.show_position(after,generation)
                    with self.app.lock:self.check(generation);played=self.pending_played
                    if played is None:
                        played=self.evaluate(after,generation)
                        with self.app.lock:self.check(generation);self.pending_played=played
                    alternative=before['move'];best=played
                    same=alternative==move
                    # The first placements only establish an origin and axis.
                    # Different landing directions for the same bug are equivalent.
                    if data['ply']<2 and len(data['pieces'])<2 and '~' not in data['game'].split(';')[0] and alternative:
                        legal={m['move']:m for m in data['legal']}
                        a=legal.get(alternative);b=legal.get(move)
                        if a and b and a['piece']==b['piece']:same=True;alternative=move
                    if alternative and not same:
                        with self.app.lock:self.check(generation);self.stage=f'Move {i} of {self.total} · {move} · alternative'
                        alternative_board=self.snapshot('play',data['game'],alternative)
                        best=self.evaluate(alternative_board,generation)
                    else:
                        with self.app.lock:self.check(generation);self.remaining_units=max(0,self.remaining_units-1)
                    mover=data['side'];sign=1 if mover==0 else -1
                    best_score=white_score(best);played_score=white_score(played)
                    reliable=all(r['terminal'] or (type(r['depth']) is int and r['depth']>=3) for r in [before,best,played])
                    label,symbol=classify(None if best_score is None else best_score*sign,None if played_score is None else played_score*sign,same,best['depth'],played['depth']) if reliable else ('Uncertain','')
                    row=dict(ply=i,move=move,side=mover,label=label,symbol=symbol,score=played_score,best_score=best_score,alternative=alternative,reply=best['move'],depth=played['depth'],best_depth=best['depth'])
                    with self.app.lock:
                        self.check(generation);self.rows.append(row);self.points.append(dict(ply=i,score=played_score));self.before=played;self.pending_played=None
                    data=after;before=played
                with self.app.lock:
                    self.check(generation);self.show_position(data,generation);self.status='complete';self.stage='';self.remaining_units=0
            except InterruptedError:pass
            except Exception as exc:
                with self.app.lock:
                    if generation==self.generation:self.error=str(exc);self.status='error';self.stage='';self.phase_started=None
        self.thread=threading.Thread(target=work,daemon=True);self.thread.start()

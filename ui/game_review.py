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
        self.single={r['ply']:dict(r,single=True) for r in saved.get('single',[])}
        self.restore_extras(saved.get('extras',[]))
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
        return dict(source=self.source,recorded_count=len(self.in_game_history),restored=bool(self.portable_engine),resume_engine_missing=missing and not recorded,can_resume=self.can_resume(),engine=self.engine.get('name',''),external=not self.portable_engine['builtin'] if self.portable_engine else self.engine.get('id')!='Computer',remaining_seconds=remaining,side_busy=bool(getattr(self,'side_busy',False)),working_ply=self.working_ply,active=True,status='recorded' if recorded else self.status,error=self.error,total=self.total,single_working=getattr(self,'single_working',None),single_queue=list(getattr(self,'single_queue',[]) or []),rows=[] if recorded else self.rows.copy()+[r for p,r in sorted(getattr(self,'single',{}).items()) if p>len(self.rows)],points=history_points(self.in_game_history) if recorded else self.points.copy(),milliseconds=self.milliseconds,stage=self.stage,extras=list(getattr(self,'extras',{}).values()))

    def side(self,kind,ply,move=None,length=4):
        """One extra search beside the finished review: the engine's line after its preferred move
        ('line'), or a different move the user wants graded ('try')."""
        if self.status=='running':raise ValueError('Stop the review first.')
        if getattr(self,'side_busy',False):raise ValueError('Still working on the last request.')
        row=next((r for r in self.rows if r['ply']==ply),None) or getattr(self,'single',{}).get(ply)
        if not row and not (isinstance(ply,int) and 1<=ply<=self.total):raise ValueError('Review this move first.')
        if not hasattr(self,'extras'):self.extras={}
        key=(kind,ply) if kind=='line' else (kind,ply,move) # every tried move is kept (until its x is pressed)
        self.extra_seq=getattr(self,'extra_seq',0)+1
        # A rough time for the countdown: a short search for each move of the line (2 s at most), or one full
        # search for a tried move, plus the move's own review first when the review has not reached it.
        ms=self.milliseconds or 5000;count=max(2,min(int(length or 4),16))
        expected=(count-(1 if row and row.get('reply') else 0))*(min(ms,2000)/1000+.4) if kind=='line' else ms/1000+.4
        if not row:expected+=3*(ms/1000+.4)
        self.extras[key]=dict(kind=kind,ply=ply,status='running',move=move,expected=round(expected),seq=self.extra_seq)
        self.side_busy=True;generation=self.generation;units=self.remaining_units
        def work():
            try:
                data=self.snapshot('snapshot',self.game)
                while data['ply']>ply-1:data=self.snapshot('undo',data['game'])
                nonlocal row
                if row is None:row=self.review_one(data,ply,generation) # a move the review has not reached yet: review it on its own first
                if kind=='line':
                    moves=[];steps=[];position=data;scores=[]
                    following=row['alternative'] if row.get('alternative') else row['move']
                    count=max(2,min(int(length or 4),16))
                    for k in range(count):
                        position=self.snapshot('play',position['game'],following)
                        moves.append(following);steps.append(dict(pieces=position['pieces'],last_move=position.get('last_move')))
                        # The rating after each move of the line (White's view), as in the move list.
                        if position['state'] in TERMINAL:
                            scores.append(0 if position['state']=='Draw' else 100000 if position['state']=='WhiteWins' else -100000);break
                        if k==0 and row.get('reply'):
                            scores.append(row.get('best_score',row.get('score')));following=row['reply'];continue
                        found=self.evaluate(position,generation,min(self.milliseconds,2000))
                        scores.append(white_score(found) if found.get('move') else (scores[-1] if scores else None))
                        if k==count-1 or not found.get('move'):break
                        following=found['move']
                    result=dict(moves=moves,steps=steps,scores=scores)
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
        self.single_queue=[]  # moves queued for review by clicking them stop too
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
            if adapter=='foulbrood':
                engine.command('options set UseBook False')
                try:engine.command('options set AnalysisMode True')  # whole time per position (engines without it: ignored)
                except ValueError:pass
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

    def forget_try(self,ply,move):
        """A tried move cleared with its x: gone from the review (and from the saved copy)."""
        getattr(self,'extras',{}).pop(('try',ply,move),None)

    def saved_extras(self):
        """Engine lines and tried moves, as kept with the review in the Archive."""
        out=[]
        for e in getattr(self,'extras',{}).values():
            if e.get('status')!='ready':continue
            if e['kind']=='line':out.append(dict(kind='line',ply=e['ply'],moves=list(e.get('moves') or []),scores=list(e.get('scores') or [])))
            else:out.append(dict(kind='try',ply=e['ply'],move=e.get('move'),score=e.get('score'),depth=e.get('depth'),side=e.get('side')))
        return out

    def restore_extras(self,saved):
        """Put saved engine lines and tried moves back; the board positions for them are worked out in the background."""
        self.extras={};self.extra_seq=0
        for e in saved or []:
            self.extra_seq+=1
            if e['kind']=='line':self.extras[('line',e['ply'])]=dict(kind='line',ply=e['ply'],status='ready',move=None,moves=e['moves'],scores=e['scores'],steps=[dict(pieces=None,last_move=None) for _ in e['moves']],seq=self.extra_seq)
            else:self.extras[('try',e['ply'],e['move'])]=dict(kind='try',ply=e['ply'],status='ready',move=e['move'],score=e['score'],depth=e['depth'],side=e['side'],pieces=None,last_move=None,seq=self.extra_seq)
        if not self.extras:return
        game=self.game
        def position_before(ply):
            parts=game.split(';');moves=parts[3:3+ply-1]
            if '~' not in parts[0]:
                n=len(moves);text=';'.join([parts[0],'InProgress' if n else 'NotStarted',('White' if n%2==0 else 'Black')+'[%d]'%(n//2+1)]+moves)
                try:
                    data=self.snapshot('snapshot',text)
                    if data['ply']==n:return data
                except Exception:pass
            data=self.snapshot('snapshot',game)
            while data['ply']>ply-1:data=self.snapshot('undo',data['game'])
            return data
        def work():
            for key,e in list(self.extras.items()):
                try:
                    data=position_before(e['ply'])
                    if e['kind']=='line':
                        position=data;steps=[]
                        for m in e['moves']:
                            position=self.snapshot('play',position['game'],m);steps.append(dict(pieces=position['pieces'],last_move=position.get('last_move')))
                        with self.app.lock:e['steps']=steps
                    else:
                        position=self.snapshot('play',data['game'],e['move'])
                        with self.app.lock:e.update(pieces=position['pieces'],last_move=position.get('last_move'))
                except Exception:
                    with self.app.lock:self.extras.pop(key,None)
            with self.app.lock:
                try:self.app.revision+=1
                except Exception:pass
        threading.Thread(target=work,daemon=True).start()

    def review_single(self,ply):
        """Review moves the main review has not reached yet, one at a time, in the order they were clicked."""
        if self.status=='running':return
        if not (1<=ply<=self.total) or ply<=len(self.rows) or ply in getattr(self,'single',{}):return
        queue=getattr(self,'single_queue',None)
        if queue is None:queue=self.single_queue=[]
        if ply in queue or ply==getattr(self,'single_working',None):return
        queue.append(ply)
        if getattr(self,'single_worker',False):return
        self.single_worker=True;generation=self.generation;units=self.remaining_units
        def work():
            try:
                while True:
                    with self.app.lock:
                        if generation!=self.generation or not self.single_queue:break
                        busy=getattr(self,'side_busy',False) # an engine line or a tried move goes first
                        if not busy:ply=self.single_queue.pop(0)
                    if busy:time.sleep(.3);continue
                    with self.app.lock:
                        if ply in getattr(self,'single',{}) or ply<=len(self.rows):continue
                        self.side_busy=True;self.single_working=ply;self.app.revision+=1
                    try:
                        data=self.snapshot('snapshot',self.game)
                        while data['ply']>ply-1:data=self.snapshot('undo',data['game'])
                        self.review_one(data,ply,generation)
                    except InterruptedError:break
                    except Exception:pass
                    finally:
                        with self.app.lock:self.side_busy=False;self.single_working=None
            finally:
                with self.app.lock:
                    self.single_worker=False;self.single_working=None;self.side_busy=False;self.remaining_units=units;self.phase_started=None
                    if generation!=self.generation:self.single_queue=[]
                    try:self.app.revision+=1
                    except Exception:pass
        threading.Thread(target=work,daemon=True).start()

    def review_one(self,data,ply,generation):
        """Review one move on its own (the main review has not reached it yet), the same way the review does.
        Kept apart from the main rows, which stay in order so a stopped review can resume."""
        move=self.game.split(';')[2+ply]
        after=self.snapshot('play',data['game'],move)
        if move in self.book_moves(data,generation):
            row=dict(ply=ply,move=move,side=data['side'],label='Book move',symbol='',score=None,best_score=None,alternative=None,reply=None,depth=0,best_depth=0)
        else:
            before=self.evaluate(data,generation);played=self.evaluate(after,generation)
            alternative=before['move'];same=alternative==move;best=played
            if data['ply']<2 and len(data['pieces'])<2 and '~' not in data['game'].split(';')[0] and alternative:
                legal={m['move']:m for m in data['legal']}
                a=legal.get(alternative);b=legal.get(move)
                if a and b and a['piece']==b['piece']:same=True;alternative=move
            if alternative and not same:best=self.evaluate(self.snapshot('play',data['game'],alternative),generation)
            mover=data['side'];sign=1 if mover==0 else -1
            best_score=white_score(best);played_score=white_score(played)
            reliable=all(r['terminal'] or (type(r['depth']) is int and r['depth']>=3) for r in [before,best,played])
            label,symbol=classify(None if best_score is None else best_score*sign,None if played_score is None else played_score*sign,same,best['depth'],played['depth']) if reliable else ('Uncertain','')
            row=dict(ply=ply,move=move,side=mover,label=label,symbol=symbol,score=played_score,best_score=best_score,alternative=alternative,reply=best['move'],depth=played['depth'],best_depth=best['depth'],single=True)
        with self.app.lock:
            self.check(generation)
            if not hasattr(self,'single'):self.single={}
            self.single[ply]=row;self.app.revision+=1
        return row

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
                    # Already reviewed on its own (clicked earlier): take that result instead of searching again.
                    known=getattr(self,'single',{}).get(i)
                    if known:
                        row={k:v for k,v in known.items() if k!='single'}
                        checkpoint=dict(score=None if row['score'] is None else row['score']*(1 if after['side']==0 else -1),side=after['side'],depth=row['depth'] or 0,move=None,terminal=False)
                        with self.app.lock:
                            self.check(generation)
                            if not self.points:self.points=[dict(ply=0,score=None)]
                            self.rows.append(row);self.points.append(dict(ply=i,score=row['score']));self.before=checkpoint;self.pending_played=None
                            self.single.pop(i,None);self.remaining_units=2*(self.total-i)+(1 if i<self.total else 0)
                        self.show_position(after,generation)
                        data=after;before=checkpoint
                        continue
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

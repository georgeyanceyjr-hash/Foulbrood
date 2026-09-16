"""Immutable, per-position snapshots of the analysis shown during play."""
import copy
import math
from external_engines import review_score

FIELDS=('move','depth','score','seconds','side','source','engine_score','engine_forced_winner')

def capture(session,engine,evaluation,milliseconds):
    if not evaluation or not evaluation.get('move'):return
    if evaluation['move'] not in {m['move'] for m in session.data['legal']}:return
    entry=dict(ply=session.data['ply'],game=session.data['game'],side=session.data['side'],
               engine=engine,milliseconds=milliseconds,
               evaluation={k:evaluation[k] for k in FIELDS if k in evaluation})
    session.analysis_history[entry['ply']]=copy.deepcopy(entry)

def visible_history(history,ply,finished=False):
    result=[None,None]
    for at,entry in sorted(history.items()):
        if at<=ply:result[entry['side']]=entry
    if history and not finished:
        first=next(iter(history.values()));side=(first['side']-first['ply']+ply)%2
        if result[side] and result[side]['ply']!=ply:result[side]=None
    return copy.deepcopy(result)

def history_points(history):
    points=[]
    for ply,entry in sorted(history.items()):
        e=entry['evaluation'];adapter=entry['engine']['adapter']
        if e.get('source')=='external':score=review_score(e,adapter) if adapter in ('foulbrood','mzinga','nokamute') else None
        else:score=None if e.get('score') is None else e['score']*(1 if e['side']==0 else -1)
        points.append(dict(ply=ply,score=score,depth=e.get('depth')))
    return points

def validate_history(history,game):
    if not isinstance(history,list) or len(history)>10001:raise ValueError('Invalid recorded analysis.')
    full=game.split(';');seen=set();result={}
    for entry in history:
        if not isinstance(entry,dict) or set(entry)!={'ply','game','side','engine','milliseconds','evaluation'}:raise ValueError('Invalid recorded position.')
        ply=entry['ply'];parts=entry['game'].split(';')
        if type(ply) is not int or not 0<=ply<=len(full)-3 or ply in seen or parts[0]!=full[0] or len(parts)!=ply+3 or parts[3:]!=full[3:3+ply]:raise ValueError('Recorded analysis does not match the game.')
        seen.add(ply)
        side=entry['side'];root_side=int(full[0].split('~')[1]) if '~' in full[0] else 0
        if type(side) is not int or side!=(root_side+ply)%2:raise ValueError('Invalid recorded side.')
        if type(entry['milliseconds']) is not int or not 0<=entry['milliseconds']<=86400000:raise ValueError('Invalid recorded time.')
        engine=entry['engine'];e=entry['evaluation']
        if not isinstance(engine,dict) or set(engine)!={'name','builtin','adapter'} or not isinstance(engine['name'],str) or len(engine['name'])>500 or type(engine['builtin']) is not bool or engine['adapter'] not in (None,'foulbrood','mzinga','nokamute'):raise ValueError('Invalid recorded engine.')
        if not isinstance(e,dict) or not set(e)<=set(FIELDS) or not isinstance(e.get('move'),str) or len(e['move'])>40 or e.get('side')!=side:raise ValueError('Invalid recorded evaluation.')
        if e.get('source') not in ('search','book','external'):raise ValueError('Invalid evaluation source.')
        for key in ('score','engine_score','seconds','depth'):
            n=e.get(key)
            if n is not None and (type(n) not in (int,float) or abs(n)>1e15 or not math.isfinite(n)):raise ValueError('Invalid evaluation number.')
        if e.get('engine_forced_winner') not in (None,'White','Black'):raise ValueError('Invalid forced result.')
        result[ply]=copy.deepcopy(entry)
    return result

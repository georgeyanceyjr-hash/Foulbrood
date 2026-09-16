"""Portable review checkpoints in a normal Hive PGN brace comment.

No executable paths or engine options are accepted from a review file.
"""
import base64
import copy
import json
import math
import re
import textwrap
from export_game import export_game
from live_analysis import validate_history

MAX_REVIEW_BYTES=8_000_000
MARKER='FoulBroodReview'
TIMES=(500,2000,5000,10000,60000,600000,3600000,86400000)
MOVE=re.compile(r'(?:pass|[wb][QABGSLMP][123]?(?:\s+[-/\\]?[wb][QABGSLMP][123]?[-/\\]?)?)\Z')

def engine_identity(engine):
    return dict(name=engine.get('name',''),builtin=engine.get('id')=='Computer',adapter=engine.get('score_adapter'))

def engine_matches(identity,engine):
    return bool(engine and identity==engine_identity(engine))

def save_review(review,session):
    # Called under the app lock: rows and both resume checkpoints form one snapshot.
    state=dict(format='foulbrood-review',version=1,game=review.game,
               engine=review.portable_engine or engine_identity(review.engine),
               milliseconds=review.milliseconds,rows=review.rows,points=review.points,
               before=review.before,pending_played=review.pending_played,
               status='complete' if len(review.rows)==review.total and review.before else 'stopped',error=review.error,
               cursor=session.data['ply'],players=session.player_names,
               result=session.reported_result,setup_placed=session.setup_placed,
               analysis_source=review.source,in_game_history=list(review.in_game_history.values()))
    encoded=base64.b64encode(json.dumps(state,ensure_ascii=True,allow_nan=False,separators=(',',':')).encode()).decode()
    result={'1-0':'WhiteWins','0-1':'BlackWins','1/2-1/2':'Draw'}.get(session.reported_result,session.reported_result)
    exported=export_game(review.game,'pgn',result)
    # Mzinga reads one move per line and treats a standalone '*' as a move.
    # An unfinished game needs only its Result tag; no movetext result token.
    if exported['text'].endswith('*\n'):exported['text']=exported['text'][:-2]
    headers=''
    for key,value in zip(('White','Black'),session.player_names):
        if value:
            # PGN tag text must not introduce another tag or quoted string.
            safe=re.sub(r'[\x00-\x1f\x7f"\\\[\]{}]',' ',value)
            headers+=f'[{key} "{safe}"]\n'
    if session.setup_placed:headers+=f'[FoulBroodPlaced "{session.setup_placed}"]\n'
    exported['text']=headers+exported['text']+'\n{'+MARKER+' v1\n'+textwrap.fill(encoded,76)+'\n}\n'
    if len(exported['text'].encode())>MAX_REVIEW_BYTES:raise ValueError('This reviewed game is too large to save.')
    exported['filename']='Reviewed-game.pgn'
    return exported

def read_review(text,game):
    """Validate completely before the caller replaces any existing review."""
    if len(text.encode())>MAX_REVIEW_BYTES:raise ValueError('Please use a reviewed game smaller than 8 MB.')
    blocks=re.findall(r'\{'+MARKER+r'\s+([^}]*)\}',text,re.S)
    if len(blocks)!=1:raise ValueError('Choose a PGN saved with Save reviewed game.')
    version,_,encoded=blocks[0].partition('\n')
    if version.strip()!='v1':raise ValueError('This reviewed-game version is not supported.')
    try:
        value=json.loads(base64.b64decode(''.join(encoded.split()),validate=True))
        return validate_review(value,game)
    except (ValueError,TypeError,KeyError,AttributeError,UnicodeError,RecursionError) as exc:
        raise ValueError('The saved review is damaged or does not match the game.') from exc

def validate_review(value,game):
    def require(condition):
        if not condition:raise ValueError('Invalid review data')
    def integer(n,low,high):return type(n) is int and low<=n<=high
    def score(n):return n is None or type(n) in (int,float) and math.isfinite(n) and abs(n)<=1e15
    def move(m):return m is None or isinstance(m,str) and len(m)<=40 and MOVE.fullmatch(m)
    def evaluation(e):
        if e is None:return
        require(isinstance(e,dict) and set(e)=={'score','side','depth','move','terminal'})
        require(score(e['score']) and integer(e['side'],0,1) and integer(e['depth'],0,10000))
        require(move(e['move']) and type(e['terminal']) is bool)
    require(isinstance(value,dict) and value.get('format')=='foulbrood-review' and value.get('version')==1)
    require(value['game']==game)
    moves=game.split(';')[3:];total=len(moves)
    identity=value['engine']
    require(isinstance(identity,dict) and set(identity)=={'name','builtin','adapter'})
    require(isinstance(identity['name'],str) and len(identity['name'])<=500 and type(identity['builtin']) is bool)
    require(identity['adapter'] in (None,'foulbrood','mzinga','nokamute'))
    require(type(value['milliseconds']) is int and value['milliseconds'] in TIMES)
    require(value['status'] in ('stopped','complete'))
    require(isinstance(value['error'],str) and len(value['error'])<=20000)
    require(integer(value['cursor'],0,total))
    require(isinstance(value['players'],list) and len(value['players'])==2 and all(x is None or isinstance(x,str) and len(x)<=1000 for x in value['players']))
    require(value['result'] in (None,'WhiteWins','BlackWins','Draw','1-0','0-1','1/2-1/2','*'))
    require(value['setup_placed'] is None or isinstance(value['setup_placed'],str) and re.fullmatch(r'[wb][QABGSLMP][123]?',value['setup_placed']))
    rows=value['rows'];points=value['points'];before=value['before'];pending=value['pending_played']
    require(isinstance(rows,list) and len(rows)<=total and isinstance(points,list))
    require(len(points)==(len(rows)+1 if before is not None else 0))
    require(before is not None or not rows and pending is None)
    evaluation(before);evaluation(pending)
    first_side=int(game.split(';')[0].split('~')[1]) if '~' in game.split(';')[0] else 0
    for i,row in enumerate(rows,1):
        require(isinstance(row,dict) and set(row)=={'ply','move','side','label','symbol','score','best_score','alternative','reply','depth','best_depth'})
        require(type(row['ply']) is int and row['ply']==i and row['move']==moves[i-1] and row['side']==(first_side+i-1)%2)
        require(row['label'] in ('Best move','Uncertain','Blunder','Missed win','Mistake','Inaccuracy','No clear error') and row['symbol'] in ('','??','∅','?','?!'))
        require(score(row['score']) and score(row['best_score']) and move(row['alternative']) and move(row['reply']))
        require(integer(row['depth'],0,10000) and integer(row['best_depth'],0,10000))
    for i,point in enumerate(points):
        require(isinstance(point,dict) and set(point)<={'ply','score','depth'} and point['ply']==i and score(point['score']))
        if 'depth' in point:require(integer(point['depth'],0,10000))
        if i:require(point['score']==rows[i-1]['score'])
    if before:
        require(before['side']==(first_side+len(rows))%2)
        white=None if before['score'] is None else before['score']*(1 if before['side']==0 else -1)
        require(white==points[-1]['score'])
    if pending:require(len(rows)<total and pending['side']==(first_side+len(rows)+1)%2)
    if value['status']=='complete':require(len(rows)==total and before is not None and pending is None)
    value['in_game_history']=validate_history(value.get('in_game_history',[]),game)
    value['analysis_source']=value.get('analysis_source','review')
    require(value['analysis_source'] in ('in_game','review'))
    require(value['analysis_source']!='in_game' or value['in_game_history'])
    return copy.deepcopy(value)

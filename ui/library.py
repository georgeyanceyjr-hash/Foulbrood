"""Game history: every game played in the viewer, played by the hivegame.com bot, or imported.

One JSON index (FoulBroodData/game-history/index.json) plus one reviewed-PGN file per game that has
review results. A game is identified by its moves, so playing, importing and reviewing the same game
all land on one entry.
"""
import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path

ROOT = Path(os.environ.get('FOULBROOD_HISTORY_DIR', str(Path.home() / 'Documents/Codex/FoulBroodData/game-history')))
INDEX = ROOT / 'index.json'
LOCK = threading.Lock()
MAX_GAMES = 5000
TEXT = ('white', 'black', 'result', 'source', 'time_control', 'played', 'url', 'white_kind', 'black_kind', 'note')
NUMBERS = ('white_rating', 'black_rating', 'white_change', 'black_change')
ID = re.compile(r'^[0-9a-f]{16}$')


def _moves(game):
    parts = [p.strip() for p in str(game or '').split(';')]
    return [m for m in parts[3:] if m]


def game_id(game):
    """The same moves from the same start are the same game, wherever they came from."""
    parts = str(game or '').split(';')
    start = parts[0].strip()
    return hashlib.sha1((start + '|' + ';'.join(_moves(game))).encode('utf-8')).hexdigest()[:16]


def _load():
    try:
        data = json.loads(INDEX.read_text(encoding='utf-8'))
        games = data.get('games') if isinstance(data, dict) else None
        return games if isinstance(games, list) else []
    except (OSError, ValueError):
        return []


def _save(games):
    ROOT.mkdir(parents=True, exist_ok=True)
    temp = INDEX.with_suffix('.tmp')
    temp.write_text(json.dumps(dict(version=1, games=games)), encoding='utf-8')
    os.replace(temp, INDEX)


def _clean(entry):
    out = {}
    for key in TEXT:
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = value.strip()[:200]
    for key in NUMBERS:
        value = entry.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and -10000 < value < 10000:
            out[key] = round(float(value), 1)
    return out


def add(entry):
    """Add a game, or fill in what an existing entry for the same game is missing. Returns its id."""
    game = entry.get('game')
    if not isinstance(game, str) or len(game) > 400000 or len(_moves(game)) < 1:
        return None
    gid = game_id(game)
    fields = _clean(entry)
    with LOCK:
        games = _load()
        old = next((g for g in games if g.get('id') == gid), None)
        if old is None:
            old = dict(id=gid, saved=time.strftime('%Y-%m-%dT%H:%M:%S'), starred=False)
            games.append(old)
            if len(games) > MAX_GAMES:  # oldest unstarred games make room
                for g in list(games):
                    if len(games) <= MAX_GAMES:
                        break
                    if not g.get('starred') and g is not old:
                        games.remove(g)
                        _review_path(g['id']).unlink(missing_ok=True)
        # A finished record of the game replaces an unfinished one; otherwise only gaps are filled.
        finished = lambda text: str(text or '').split(';')[1:2] not in ([], ['InProgress'], ['NotStarted'])
        if 'game' not in old or (finished(game) and not finished(old.get('game'))):
            old['game'] = game
        old['moves'] = len(_moves(old['game']))
        times = entry.get('times')  # seconds each move took, where known
        if isinstance(times, list) and 0 < len(times) <= 2000 and not old.get('times'):
            old['times'] = [round(float(t), 1) if isinstance(t, (int, float)) and not isinstance(t, bool) and 0 <= t < 100000 else None for t in times]
        for key, value in fields.items():
            if key == 'source':
                # Where it was played beats "Imported".
                if old.get('source') in (None, 'Imported'):
                    old['source'] = value
            elif key == 'result':
                if old.get('result') in (None, '', 'In progress') or value not in ('', 'In progress'):
                    old['result'] = value
            elif old.get(key) in (None, ''):
                old[key] = value
        _save(games)
    return gid


def _review_path(gid):
    return ROOT / 'reviews' / (gid + '.pgn')


def set_review(game, text, reviewed, total, engine):
    gid = add(dict(game=game))
    if gid is None or not isinstance(text, str) or not 0 < len(text) <= 8000000:
        return None
    with LOCK:
        games = _load()
        entry = next((g for g in games if g.get('id') == gid), None)
        if entry is None:
            return None
        ROOT.joinpath('reviews').mkdir(parents=True, exist_ok=True)
        _review_path(gid).write_text(text, encoding='utf-8')
        entry['review'] = dict(reviewed=int(reviewed or 0), total=int(total or 0), engine=str(engine or '')[:100],
                               saved=time.strftime('%Y-%m-%dT%H:%M:%S'))
        _save(games)
    return gid


def _opening(game):
    """The first three bugs each side put down, e.g. 'P·A·Q vs G·B·Q' (blank for set-up positions)."""
    parts = str(game or '').split(';')
    if len(parts) < 5 or '~' in parts[0]:
        return ''
    bugs = ([], [])
    for i, move in enumerate(parts[3:9]):
        piece = (move.strip().split(' ') or [''])[0]
        bugs[i % 2].append(''.join(c for c in piece[1:] if not c.isdigit()) or '–')
    return '·'.join(bugs[0]) + ' vs ' + '·'.join(bugs[1])


def listing(query=''):
    words = [w for w in str(query or '').lower().split() if w][:8]
    with LOCK:
        games = _load()
    rows = []
    for g in games:
        row = {k: v for k, v in g.items() if k not in ('game', 'times')}
        row['opening'] = _opening(g.get('game'))
        hay = ' '.join(str(g.get(k) or '') for k in ('white', 'black', 'result', 'source', 'time_control', 'played', 'saved', 'note')).lower()
        if all(w in hay for w in words):
            rows.append(row)
    # Starred games first, then newest.
    rows.sort(key=lambda r: (not r.get('starred'), ), reverse=False)
    rows.sort(key=lambda r: str(r.get('played') or r.get('saved') or ''), reverse=True)
    rows.sort(key=lambda r: 0 if r.get('starred') else 1)
    return rows


def library_action(payload):
    action = payload.get('action')
    if action == 'library_list':
        rows = listing(payload.get('query'))
        return dict(games=rows[:500], total=len(rows))
    if action == 'library_save':
        return dict(id=add(payload))
    if action == 'library_review':
        return dict(id=set_review(payload.get('game'), payload.get('text'), payload.get('reviewed'), payload.get('total'), payload.get('engine')))
    gid = payload.get('id')
    if not isinstance(gid, str) or not ID.match(gid):
        raise ValueError('That game is not in the history.')
    with LOCK:
        games = _load()
        entry = next((g for g in games if g.get('id') == gid), None)
        if entry is None:
            raise ValueError('That game is not in the history.')
        if action == 'library_get':
            review = None
            if entry.get('review'):
                try:
                    review = _review_path(gid).read_text(encoding='utf-8')
                except OSError:
                    review = None
            return dict(entry, review_text=review)
        if action == 'library_star':
            entry['starred'] = payload.get('starred') is True
            _save(games)
            return dict(id=gid, starred=entry['starred'])
        if action == 'library_delete':
            games.remove(entry)
            _save(games)
            _review_path(gid).unlink(missing_ok=True)
            return dict(deleted=gid)
    raise ValueError('Unknown history action.')

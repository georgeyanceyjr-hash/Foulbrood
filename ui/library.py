"""Game history: every game played in the viewer, played by the hivegame.com bot, or imported.

One JSON index (FoulBroodData/game-history/index.json) plus one reviewed-PGN file per game that has
review results. A game is identified by its moves, so playing, importing and reviewing the same game
all land on one entry.
"""
import hashlib
import json
import math
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


# ---- Report: patterns across a set of games, seen from one player's side ----
def _view(score):
    """The viewer's -100..+100 scale."""
    if abs(score) > 99000:
        return 100 if score > 0 else -100
    return max(-99, min(99, round(100 * math.tanh(score / 300))))


def _bot_evals():
    """What the bot itself believed during its games: {hivegame id: (bot name, {turn: (depth, score)})}."""
    out = {}
    try:
        with (ROOT.parent / 'hivegame-bot' / 'games.jsonl').open() as rows:
            for line in rows:
                try:
                    row = json.loads(line)
                    evals = {int(k): (v[0] if isinstance(v[0], int) else 0, v[1]) for k, v in (row.get('evals') or {}).items()
                             if isinstance(v, list) and len(v) > 1 and isinstance(v[1], (int, float))}
                    if evals:
                        out[str(row.get('id'))] = (row.get('bot'), evals)
                except (ValueError, TypeError):
                    continue
    except OSError:
        pass
    return out


def _logged_times(gid, total, side):
    """Seconds each move took, from the bot client's log (older games have no other record): the bot's
    moves from when it started thinking to when it played, the opponent's from then until the bot was
    asked to think again."""
    if not gid or not total:
        return None
    events = []  # ('think' | 'play', time)
    stamp = lambda line: time.mktime(time.strptime(line[:19], '%Y-%m-%dT%H:%M:%S')) + float('0.' + (line[20:23] if line[19:20] == '.' else '0'))
    try:
        for path in sorted((ROOT.parent / 'hivegame-bot' / 'logs').glob('hive-hydra.log.*')):
            with path.open(errors='replace') as lines:
                for line in lines:
                    if 'game_id=' + gid not in line:
                        continue
                    try:
                        if ' thinking ' in line:
                            events.append(('think', stamp(line)))
                        elif ' playing move ' in line:
                            events.append(('play', stamp(line)))
                    except ValueError:
                        continue
    except OSError:
        return None
    times, ply, started, played = [None] * total, side, None, None
    for kind, at in events:
        if kind == 'think':
            if played is not None and 0 <= ply - 1 < total and times[ply - 1] is None:
                times[ply - 1] = round(max(0.0, at - played), 1)   # the opponent's move in between
            started, played = at, None
        elif started is not None:
            if ply < total:
                times[ply] = round(max(0.0, at - started), 1)
            started, played = None, at
            ply += 2
    return times if any(t is not None for t in times) else None


def report(ids, me):
    """Counts and patterns for the listed games from `me`'s side. Every finding carries its numbers."""
    wanted = set(ids or [])
    games = [g for g in listing('') if g.get('id') in wanted and me in (g.get('white'), g.get('black'))]
    evals = _bot_evals()
    def outcome(g):
        r = str(g.get('result') or '')
        side = 'white' if r.startswith('White won') else 'black' if r.startswith('Black won') else 'draw' if r.startswith('Draw') else ''
        return '' if not side else 'draw' if side == 'draw' else 'won' if g.get(side) == me else 'lost'
    def tally(rows):
        return dict(games=len(rows), won=sum(outcome(g) == 'won' for g in rows), lost=sum(outcome(g) == 'lost' for g in rows),
                    drawn=sum(outcome(g) == 'draw' for g in rows))
    def colour(g):
        return 'white' if g.get('white') == me else 'black'
    def groups(key):
        found = {}
        for g in games:
            found.setdefault(key(g), []).append(g)
        return sorted(((k, tally(v)) for k, v in found.items() if k), key=lambda kv: -kv[1]['games'])
    opponents = sorted({g.get('black') if colour(g) == 'white' else g.get('white') for g in games} - {None})
    out = dict(me=me, opponents=opponents, total=tally(games),
               colours=[dict(colour=k, **t) for k, t in groups(colour)],
               clocks=[dict(clock=k, **t) for k, t in groups(lambda g: str(g.get('time_control') or '').split(' ')[0])],
               openings=[dict(colour=k[0], opening=k[1], **t) for k, t in groups(lambda g: (colour(g), g.get('opening')) if g.get('opening') else None)])
    lengths = {k: [g.get('moves') or 0 for g in games if outcome(g) == k and g.get('moves')] for k in ('won', 'lost')}
    out['length'] = {k: (round(sum(v) / len(v)) if v else None) for k, v in lengths.items()}
    endings = {}
    for g in games:
        r = str(g.get('result') or '')
        if outcome(g) in ('won', 'lost'):
            kind = 'resignation' if 'by resignation' in r else 'on time' if 'on time' in r else 'not recorded'
            endings.setdefault(outcome(g), {}).setdefault(kind, 0)
            endings[outcome(g)][kind] += 1
    out['endings'] = endings
    # What the player's own engine believed, move by move (bot games only).
    scale = lambda x: (100 if x > 0 else -100) if abs(x) > 99000 else max(-99.0, min(99.0, 100 * math.tanh(x / 600)))
    turning, ahead, never, tracked = [], [], [], 0
    for g in games:
        gid = str(g.get('url') or '').rsplit('/', 1)[-1]
        bot, deep = evals.get(gid, (None, None))
        series = {t: v[1] for t, v in deep.items()} if deep else None
        if bot != me or not series or len(series) < 3:
            continue
        tracked += 1
        if outcome(g) != 'lost':
            continue
        turns = sorted(series)
        best = None
        for i in range(1, len(turns)):
            before, after = scale(series[turns[i - 1]]), scale(series[turns[i]])
            drop = before - after
            if drop < 10:
                continue
            lasting = before > -25 and all(scale(series[t]) <= -25 for t in turns[i:])
            weight = drop + (1000 if lasting else 0)
            if best is None or weight > best[0]:
                best = (weight, turns[i - 1], turns[i])
        peak_turn = max(turns, key=lambda t: series[t])
        peak = _view(series[peak_turn])
        opponent = g.get('black') if colour(g) == 'white' else g.get('white')
        ref = dict(id=g.get('id'), opponent=opponent, played=g.get('played') or g.get('saved'), colour=colour(g), moves=g.get('moves'), clock=str(g.get('time_control') or '').split(' ')[0])
        if best:
            turning.append(dict(ref, move=best[1] + 1, before=_view(series[best[1]]), after=_view(series[best[2]])))
        if peak >= 60:
            ahead.append(dict(ref, move=peak_turn + 1, peak=peak))
        elif peak < 20:
            never.append(dict(ref, peak=peak))
    turning.sort(key=lambda t: t['move'])
    ahead.sort(key=lambda t: -t['peak'])
    out.update(tracked=tracked, turning=turning, ahead=ahead, never=never)
    # Saved Game reviews: who made the graded errors, and when.
    def review_rows(g):
        try:
            import base64
            text = _review_path(g['id']).read_text(encoding='utf-8')
            block = re.findall(r'\{FoulBroodReview\s+([^}]*)\}', text, re.S)
            if not block:
                block = re.findall(r'\{[A-Za-z]*Review[A-Za-z]*\s+([^}]*)\}', text, re.S)
            encoded = block[0].partition('\n')[2]
            return json.loads(base64.b64decode(''.join(encoded.split())))['rows']
        except Exception:
            return None
    def grade(row):
        if row.get('label') in ('Book move', 'Best move') or row.get('alternative') == row.get('move'):
            return ''
        best, played = row.get('best_score'), row.get('score')
        if best is None or played is None:
            return ''
        sign = 1 if row.get('side') == 0 else -1
        best, played = best * sign, played * sign
        if abs(best) > 99000 and abs(played) > 99000 and (best > 0) == (played > 0):
            return ''
        loss = max(0, scale(best) - scale(played))
        return 'blunder' if loss >= 46 or (best > 99000 and scale(played) < 90) else 'mistake' if loss >= 24 else ''
    reviewed, errors = 0, dict(me=dict(mistake=0, blunder=0), them=dict(mistake=0, blunder=0))
    phases = dict(opening=0, middle=0, late=0)
    for g in games:
        info = g.get('review') or {}
        if not info.get('total') or info.get('reviewed', 0) < info.get('total', 0):
            continue
        rows = review_rows(g)
        if not rows:
            continue
        reviewed += 1
        mine = 0 if colour(g) == 'white' else 1
        for row in rows:
            kind = grade(row)
            if not kind:
                continue
            who = 'me' if row.get('side') == mine else 'them'
            errors[who][kind] += 1
            if who == 'me':
                phases['opening' if row.get('ply', 0) <= 16 else 'middle' if row.get('ply', 0) <= 40 else 'late'] += 1
    out.update(reviewed=reviewed, errors=errors, phases=phases)
    # Findings in plain words, each with the counts behind it.
    findings = []
    total = out['total']
    if total['games']:
        findings.append('%s won %d and lost %d of %d games%s.' % (me, total['won'], total['lost'], total['games'], (' against ' + opponents[0]) if len(opponents) == 1 else ''))
    for c in out['colours']:
        if c['games'] >= 3:
            findings.append('As %s: %d won, %d lost.' % (c['colour'].capitalize(), c['won'], c['lost']))
    for o in out['openings']:
        decided = o['won'] + o['lost']
        if decided >= 3 and (o['lost'] == decided or o['won'] == decided):
            findings.append('As %s with %s: %s all %d.' % (o['colour'].capitalize(), o['opening'], 'lost' if o['lost'] else 'won', decided))
        elif decided >= 5 and (o['won'] / decided <= .2 or o['won'] / decided >= .8):
            findings.append('As %s with %s: won %d of %d.' % (o['colour'].capitalize(), o['opening'], o['won'], decided))
    lost_tracked = len([1 for t in turning]) or 0
    if turning:
        moves = sorted(t['move'] for t in turning)
        findings.append('Losses turn around move %d (from move %d to %d, %d games).' % (moves[len(moves) // 2], moves[0], moves[-1], len(moves)))
        high = [t for t in turning if t['before'] >= 30]
        if high:
            findings.append('In %d of %d losses %s still rated itself ahead (+30 or more) on its last move before the turn.' % (len(high), len(turning), me))
    if ahead:
        findings.append('%s rated itself clearly winning (+60 or more) at some point in %d games it went on to lose.' % (me, len(ahead)))
    if never:
        findings.append('In %d losses it was never ahead (peak below +20): behind from the opening.' % len(never))
    if out['length']['won'] and out['length']['lost']:
        findings.append('Wins last %d moves on average, losses %d.' % (out['length']['won'], out['length']['lost']))
    if reviewed:
        mine, theirs = errors['me'], errors['them']
        findings.append('In the %d reviewed game%s: %s made %d mistake%s and %d blunder%s, the other side %d and %d.' % (
            reviewed, '' if reviewed == 1 else 's', me, mine['mistake'], '' if mine['mistake'] == 1 else 's', mine['blunder'], '' if mine['blunder'] == 1 else 's', theirs['mistake'], theirs['blunder']))
        if sum(phases.values()) >= 3:
            worst = max(phases, key=phases.get)
            findings.append('Most of its graded errors come in the %s (%d of %d).' % ({'opening': 'first 16 moves', 'middle': 'middle game (moves 17 to 40)', 'late': 'late game (after move 40)'}[worst], phases[worst], sum(phases.values())))
    if reviewed < total['games']:
        missing = total['games'] - reviewed
        findings.append('Game review has not been done on %d of these %d games. Review them for a full report.' % (missing, total['games']))
    if tracked < total['games']:
        findings.append('The move-by-move findings use %d of the %d games: only games played by the bot record what it was thinking.' % (tracked, total['games']))
    out['findings'] = findings
    return out


def library_action(payload):
    action = payload.get('action')
    if action == 'library_list':
        rows = listing(payload.get('query'))
        return dict(games=rows[:500], total=len(rows))
    if action == 'library_report':
        ids = payload.get('ids')
        if not isinstance(ids, list) or not isinstance(payload.get('me'), str) or not payload.get('me'):
            raise ValueError('Choose a player for the report.')
        return report([i for i in ids if isinstance(i, str)][:2000], payload['me'])
    if action in ('library_batch_start', 'library_batch_stop', 'library_batch_status'):
        import batch_review  # kept loaded across reloads of this module, so a running batch carries on
        if action == 'library_batch_start':
            return batch_review.start(payload.get('ids') or [], payload.get('seconds'))
        return batch_review.stop() if action == 'library_batch_stop' else batch_review.status()
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
            # What the bot was thinking during this game, for Game review to show until a review is run.
            bot, deep = _bot_evals().get(str(entry.get('url') or '').rsplit('/', 1)[-1], (None, None))
            out = dict(entry, review_text=review, bot_name=bot, bot_evals={str(t): list(v) for t, v in deep.items()} if deep else None)
            if not out.get('times') and bot:
                out['times'] = _logged_times(str(entry.get('url') or '').rsplit('/', 1)[-1], len(_moves(entry.get('game'))), 0 if entry.get('white') == bot else 1)
            return out
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

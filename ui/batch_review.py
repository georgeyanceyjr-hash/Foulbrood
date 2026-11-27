"""Reviews saved games in the background, one at a time, without using the Analysis board.

Each game gets the same review as the Game review page (same engine, grading and book marks) and is
saved to the History entry. The work pauses while the bot is playing a game.
"""
import json
import sys
import threading
import time
import types

import library

STATE = dict(running=False, total=0, done=0, current='', ply=0, moves=0, error='', stop=False, paused=False, seconds=5)
_THREAD = None


class _Engines:
    def __init__(self, entry):
        self.entry = entry
        self.analysis_engine = entry['id']

    def get(self, key):
        return self.entry if key == self.entry['id'] else None


class _App:
    """The few things a Review needs from the viewer, with no board attached."""
    def __init__(self, entry, game, milliseconds):
        self.lock = threading.RLock()
        self.engines = _Engines(entry)
        self.analysis_ms = milliseconds
        self.hints = False
        self.mode = 'batch'
        self.review = None
        self.analysis = None
        self.revision = 0
        self.session = types.SimpleNamespace(review_game=game, analysis_history={})


def _engine():
    entries = json.loads((library.ROOT.parent / 'engines.json').read_text()).get('entries') or []
    usable = [e for e in entries if e.get('connected') and e.get('review_supported') and e.get('path')]
    return next((e for e in usable if e.get('name') == 'FoulBrood Book'), None) or \
        next((e for e in usable if e.get('score_adapter') == 'foulbrood'), None)


def _bot_playing():
    try:
        import hivebot
        return any(not g.get('finished') for g in hivebot.BOT.games.values())
    except Exception:
        return False


def _run(ids, milliseconds):
    main = sys.modules['__main__']
    try:
        from game_review import Review
        from review_file import save_review
        entry = _engine()
        if not entry:
            raise ValueError('Connect FoulBrood on the Engine page first.')
        for gid in ids:
            if STATE['stop']:
                break
            with library.LOCK:
                saved = next((g for g in library._load() if g.get('id') == gid), None)
            info = (saved or {}).get('review') or {}
            if not saved or not saved.get('game') or (info.get('total') and info.get('reviewed', 0) >= info.get('total', 0)):
                STATE['done'] += 1
                continue
            try:
                game = main.snapshot('snapshot', saved['game'])['game']
                app = _App(entry, game, milliseconds)
                review = Review(app, main.snapshot, main.ROOT)
                STATE.update(current='%s vs %s' % (saved.get('white') or 'White', saved.get('black') or 'Black'), ply=0, moves=review.total)
                review.start()
                while True:
                    time.sleep(1)
                    if STATE['stop']:
                        review.stop()
                        break
                    if _bot_playing():           # the bot's own game comes first
                        STATE['paused'] = True
                        if review.status == 'running':
                            review.stop()
                        continue
                    STATE['paused'] = False
                    if review.status == 'stopped':
                        review.start()           # carries on from where it stopped
                    STATE['ply'] = len(review.rows)
                    if review.status in ('complete', 'error'):
                        break
                if review.rows and review.status in ('complete', 'stopped'):
                    result = str(saved.get('result') or '')
                    session = types.SimpleNamespace(
                        data=dict(ply=review.total), player_names=[saved.get('white') or '', saved.get('black') or ''],
                        reported_result='WhiteWins' if result.startswith('White won') else 'BlackWins' if result.startswith('Black won') else 'Draw' if result.startswith('Draw') else None,
                        setup_placed=None)
                    with app.lock:
                        text = save_review(review, session)['text']
                    library.set_review(game, text, len(review.rows), review.total, entry.get('name', ''))
                elif review.status == 'error':
                    STATE['error'] = review.error or 'A review failed.'
            except Exception as exc:  # one bad game must not stop the rest
                STATE['error'] = str(exc)[:200]
            STATE['done'] += 1
    except Exception as exc:
        STATE['error'] = str(exc)[:200]
    finally:
        STATE.update(running=False, paused=False, current='', stop=False)


def start(ids, seconds=5):
    global _THREAD
    if STATE['running']:
        raise ValueError('Games are already being reviewed.')
    ids = [i for i in ids if isinstance(i, str)][:500]
    if not ids:
        raise ValueError('There are no games to review.')
    seconds = seconds if seconds in (2, 5, 15, 30, 60, 300, 900, 3600) else 5  # the same times as Game review
    STATE.update(running=True, total=len(ids), done=0, current='', ply=0, moves=0, error='', stop=False, paused=False, seconds=seconds)
    _THREAD = threading.Thread(target=_run, args=(ids, seconds * 1000), daemon=True)
    _THREAD.start()
    return status()


def stop():
    if STATE['running']:
        STATE['stop'] = True
    return status()


def status():
    return {k: STATE[k] for k in ('running', 'total', 'done', 'current', 'ply', 'moves', 'error', 'paused', 'seconds')}

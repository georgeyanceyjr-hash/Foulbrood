"""hivegame.com bot control for the viewer.

Runs the Hive-hydra bot client (hivegame.com's own UHP bot client, with the HotFrass clock
and open-challenge patches) as a child process, and turns its status lines into a small state
the bot panel can show.  The account password is handed to the child through its environment
and is never written to a file.  If asked to remember it, it goes into the macOS Keychain.
"""
import atexit
import collections
import json
import os
import re
import shlex
import subprocess
import threading
import time
from pathlib import Path

try:  # the History tab's store; refreshed whenever this module is reloaded
    import importlib
    import library
    importlib.reload(library)
except Exception:  # pragma: no cover - history must never stop the bot
    library = None

BOT_DIR = Path(os.environ.get('FOULBROOD_BOT_DIR', str(Path.home() / 'Documents/Codex/FoulBroodData/hivegame-bot')))
CLIENT_DIR = BOT_DIR / 'client'
BINARY = CLIENT_DIR / 'target' / 'release' / 'hive-hydra'
ANSI = re.compile(r'\x1b\[[0-9;]*m')
NAME = re.compile(r'^[A-Za-z0-9_-]{1,40}$')
GAME_ID = re.compile(r'^[A-Za-z0-9_-]{6,64}$')


SECURITY = '/usr/bin/security'
KEYCHAIN_SERVICE = 'FoulBrood hivegame.com bot'
SAVED_LOGIN = BOT_DIR / 'saved-login.txt'


def saved_login():
    """The login whose password is kept in the macOS Keychain, if any (the password is not in this file)."""
    try:
        value = SAVED_LOGIN.read_text().strip()
        return value if 0 < len(value) <= 200 else None
    except OSError:
        return None


def keychain_save(login, password):
    if not Path(SECURITY).exists():
        raise ValueError('Saving the password needs the macOS Keychain.')
    done = subprocess.run([SECURITY, 'add-generic-password', '-U', '-a', login, '-s', KEYCHAIN_SERVICE, '-w', password],
                          capture_output=True, text=True, timeout=20)
    if done.returncode != 0:
        raise ValueError('The Keychain did not accept the password.')
    BOT_DIR.mkdir(parents=True, exist_ok=True)
    SAVED_LOGIN.write_text(login + '\n')


def keychain_load(login):
    if not Path(SECURITY).exists():
        return None
    done = subprocess.run([SECURITY, 'find-generic-password', '-a', login, '-s', KEYCHAIN_SERVICE, '-w'],
                          capture_output=True, text=True, timeout=20)
    return done.stdout.rstrip('\n') if done.returncode == 0 and done.stdout.strip() else None


def keychain_forget():
    login = saved_login()
    if login and Path(SECURITY).exists():
        subprocess.run([SECURITY, 'delete-generic-password', '-a', login, '-s', KEYCHAIN_SERVICE],
                       capture_output=True, text=True, timeout=20)
    try:
        SAVED_LOGIN.unlink()
    except OSError:
        pass


def _cargo():
    for candidate in (Path.home() / '.cargo/bin/cargo', Path('/opt/homebrew/bin/cargo'), Path('/usr/local/bin/cargo')):
        if candidate.exists():
            return str(candidate)
    return None


def _needs_build():
    if not BINARY.exists():
        return True
    built = BINARY.stat().st_mtime
    sources = list((CLIENT_DIR / 'src').glob('*.rs')) + [CLIENT_DIR / 'Cargo.toml']
    return any(p.exists() and p.stat().st_mtime > built for p in sources)


def _friendly(message):
    text = str(message)
    if 'Not found' in text:
        return 'hivegame.com has no account with that login. Use the username (for example HotFrass) or the account email.'
    if 'Not a bot' in text:
        return 'That account is not marked as a bot on hivegame.com.'
    if 'token request refused' in text:
        if re.search(r'assword|credential|401|403', text):
            return 'hivegame.com refused the login. Check the password.'
        return 'hivegame.com refused the login: ' + text[-160:]
    return text[:240]


class HiveBot:
    def __init__(self):
        self.lock = threading.RLock()
        self.proc = None
        self.generation = 0
        self._reset('stopped', 'Not running.')
        atexit.register(self.stop)

    def _reset(self, state, message):
        self.state = state
        self.message = message
        self.user = None
        self.engine_name = None
        self.games = {}
        self.order = []
        self._restore()
        self.accepted = 0
        self.thinking = None
        self.manual = False   # moves made by hand on the viewer's board instead of by the engine
        self.refused = None
        self.log = collections.deque(maxlen=12)
        self.started = None
        self.accept = []
        self.max_games = 0
        self.anyone = False
        self.humans = False
        self.clock = None
        self.lobby = []
        self.online = []
        self.lobby_at = 0.0
        self.lobby_asked = 0.0

    # ---- control -------------------------------------------------------------------------
    def start(self, login, password, engine, accept, max_games, min_base, remember=False, anyone=False, clock=None):
        if not isinstance(login, str) or not login.strip() or len(login) > 200 or '\n' in login:
            raise ValueError('Enter the bot account username or email.')
        login = login.strip()
        if not password and saved_login() == login:
            password = keychain_load(login)
            if not password:
                raise ValueError('The saved password could not be read from the Keychain. Type it again.')
        if not isinstance(password, str) or not password or len(password) > 500 or '\n' in password:
            raise ValueError('Enter the bot account password.')
        if not engine or not engine.get('path') or not Path(engine['path']).exists():
            raise ValueError('Choose an installed engine for the bot.')
        accept = [n for n in (accept or []) if isinstance(n, str) and NAME.match(n)][:12]
        max_games = max(0, min(int(max_games or 0), 1000000))
        min_base = max(60, min(int(min_base or 600), 10800))
        if not (CLIENT_DIR / 'Cargo.toml').exists():
            raise ValueError('The bot client is missing from FoulBroodData/hivegame-bot/client.')
        with self.lock:
            if self.proc is not None or self.state in ('building', 'starting'):
                raise ValueError('The bot is already running.')
            self.generation += 1
            generation = self.generation
            self._reset('starting', 'Starting…')
            self.engine_name = engine.get('name')
            self.anyone = bool(anyone)
            self.clock = self._clock(clock)
            self.accept = list(accept)
            self.max_games = max_games if (accept or anyone) else 0
            self.started = time.time()
        BOT_DIR.mkdir(parents=True, exist_ok=True)
        if remember:
            try:
                keychain_save(login, password)
            except Exception as exc:
                with self.lock:
                    self.log.append(str(exc)[:200])
        launcher = BOT_DIR / 'bot-engine.sh'
        extra = 'TR_CLIMB=1 ' if 'thoraxrex' in Path(engine['path']).name.lower() else ''
        launcher.write_text('#!/bin/bash\n# Written by the viewer: the engine the hivegame.com bot plays with.\n'
                            'exec env %s%s\n' % (extra, shlex.quote(engine['path'])))
        launcher.chmod(0o755)
        lines = ['max_concurrent_processes: 1', 'base_url: "https://hivegame.com"', 'bots:', '  - name: hotfrass',
                 '    ai_command: %s' % launcher, '    bestmove_command_args: time 00:02:00',
                 '    email: set-at-start', '    password: set-at-start',
                 '    accept_open_from: []', '    min_base_secs: %d' % min_base, '    max_auto_games: 0']
        (BOT_DIR / 'hive-hydra.yaml').write_text('\n'.join(lines) + '\n')
        env = dict(os.environ, HIVE_HYDRA_BOT_HOTFRASS_EMAIL=login, HIVE_HYDRA_BOT_HOTFRASS_PASSWORD=password)
        threading.Thread(target=self._run, args=(generation, env), daemon=True).start()
        return self.view()

    def stop(self):
        with self.lock:
            proc = self.proc
            self.generation += 1
            self.proc = None
            if self.state != 'error':
                self.state, self.message = 'stopped', 'Stopped.'
            self.thinking = None
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
        return self.view()

    def challenge(self, opponent, base, increment, rated, color=None, min_rating=None, max_rating=None):
        """Ask the running client to post a challenge: to one user, or open when `opponent` is empty."""
        opponent = (opponent or '').strip()
        if opponent and not NAME.match(opponent):
            raise ValueError('That is not a hivegame.com username.')
        base = max(60, min(int(base or 600), 10800))
        increment = max(0, min(int(increment if increment is not None else 10), 180))
        details = dict(cmd='challenge', opponent=opponent or None, base=base, increment=increment, rated=bool(rated),
                       color=color if color in ('White', 'Black') else 'Random')
        for name, value in (('min_rating', min_rating), ('max_rating', max_rating)):
            if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 < value < 4000:
                details[name] = int(value)
        command = json.dumps(details)
        with self.lock:
            if self.proc is None or self.state != 'connected':
                raise ValueError('Start the bot and wait until it is connected.')
            try:
                self.proc.stdin.write(command + '\n')
                self.proc.stdin.flush()
            except (OSError, ValueError):
                raise ValueError('The bot client is not listening. Stop and start the bot.')
        return self.view()

    def _send(self, command):
        with self.lock:
            if self.proc is None:
                raise ValueError('Start the bot first.')
            try:
                self.proc.stdin.write(json.dumps(command) + '\n')
                self.proc.stdin.flush()
            except (OSError, ValueError):
                raise ValueError('The bot client is not listening. Stop and start the bot.')

    def set_manual(self, on):
        """Play by hand (the engine stays idle) or hand the moves back to the engine."""
        with self.lock:
            if self.state != 'connected':
                raise ValueError('Start the bot and wait until it is connected.')
            self.manual = bool(on)
        self._send(dict(cmd='manual', on=bool(on)))
        return self.view()

    def _own_game(self, game_id):
        game = self.games.get(str(game_id))
        if not game or game.get('finished'):
            raise ValueError('That game is not being played any more.')
        return game

    def hand_move(self, game_id, move):
        """Send a move made on the viewer's board."""
        move = ' '.join(str(move or '').split())[:40]
        with self.lock:
            if self.state != 'connected':
                raise ValueError('Start the bot and wait until it is connected.')
            if not self.manual:
                raise ValueError('Turn on playing by hand first.')
            game = self._own_game(game_id)
            if not game.get('our_turn'):
                raise ValueError('It is not your turn.')
            if not move:
                raise ValueError('Choose a move.')
            turn = int(game.get('turn') or 0)
            self.refused = None
        self._send(dict(cmd='move', id=str(game_id), turn=turn, move=move))
        return self.view()

    def control(self, game_id, what):
        """Resign, or offer / accept / decline a draw, in the game being played by hand."""
        if what not in ('Resign', 'DrawOffer', 'DrawAccept', 'DrawReject', 'Abort'):
            raise ValueError('The viewer did not understand that.')
        with self.lock:
            if self.state != 'connected':
                raise ValueError('Start the bot and wait until it is connected.')
            game = self._own_game(game_id)
            color = 'White' if game.get('white') == self.user else 'Black'
        self._send(dict(cmd='control', id=str(game_id), what=what, color=color))
        return self.view()

    def take(self, challenge_id):
        """Accept one challenge the user picked from the list."""
        if not GAME_ID.match(str(challenge_id)):
            raise ValueError('That challenge is no longer available.')
        with self.lock:
            if self.state != 'connected':
                raise ValueError('Start the bot and wait until it is connected.')
            if any(not g.get('finished') for g in self.games.values()):
                raise ValueError('The bot is already playing a game.')
        self._send(dict(cmd='take', id=challenge_id))
        self._send(dict(cmd='resync'))
        return self.view()

    def refresh_lobby(self):
        """Ask for a fresh list of open challenges, at most every few seconds."""
        with self.lock:
            due = self.proc is not None and self.state == 'connected' and time.time() - self.lobby_asked > 5
            if due:
                self.lobby_asked = time.time()
        if due:
            try:
                self._send(dict(cmd='resync'))
            except ValueError:
                pass

    @staticmethod
    def _clock(clock):
        """(base seconds, increment seconds) for an exact time control, or None for any game of 10 minutes or more."""
        try:
            base, increment = int(clock[0]), int(clock[1])
        except (TypeError, ValueError, IndexError):
            return None
        return (base, increment) if 60 <= base <= 10800 and 0 <= increment <= 180 else None

    def _rules_command(self):
        command = dict(cmd='accept', max_games=self.max_games, min_base=600, anyone=self.anyone,
                       humans=bool(getattr(self, 'humans', False)), **{'from': self.accept})
        if self.clock:
            command.update(base=self.clock[0], increment=self.clock[1])
        return json.dumps(command)

    def set_accept(self, accept, max_games, anyone=False, clock=None):
        """Change, while running, whose open challenges the bot takes and at which time control."""
        accept = [n for n in (accept or []) if isinstance(n, str) and NAME.match(n)][:12]
        max_games = max(0, min(int(max_games or 0), 1000000)) if (accept or anyone) else 0
        with self.lock:
            if self.proc is None:
                raise ValueError('Start the bot first.')
            self.accept, self.max_games, self.accepted = accept, max_games, 0
            self.anyone, self.clock = bool(anyone), self._clock(clock)
            try:
                self.proc.stdin.write(self._rules_command() + '\n')
                self.proc.stdin.flush()
            except (OSError, ValueError):
                raise ValueError('The bot client is not listening. Stop and start the bot.')
        return self.view()

    # ---- child process -------------------------------------------------------------------
    def _run(self, generation, env):
        try:
            if _needs_build():
                cargo = _cargo()
                if cargo is None:
                    raise RuntimeError('Rust (cargo) is needed once to build the bot client, and was not found.')
                with self.lock:
                    if generation != self.generation:
                        return
                    self.state, self.message = 'building', 'Building the bot client (first run only, a few minutes)…'
                build = subprocess.run([cargo, 'build', '--release'], cwd=str(CLIENT_DIR), capture_output=True, text=True,
                                       env=dict(os.environ, PATH=str(Path(cargo).parent) + ':' + os.environ.get('PATH', '')))
                if build.returncode != 0:
                    raise RuntimeError('Could not build the bot client: ' + build.stderr.strip()[-300:])
            with self.lock:
                if generation != self.generation:
                    return
                self.state, self.message = 'starting', 'Connecting to hivegame.com…'
                proc = subprocess.Popen([str(BINARY), '-c', str(BOT_DIR / 'hive-hydra.yaml')], cwd=str(BOT_DIR), env=env,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        text=True, bufsize=1)
                self.proc = proc
                # The challenge rules go in as the first command, so they hold from the first lobby snapshot.
                proc.stdin.write(self._rules_command() + '\n')
                proc.stdin.flush()
            env = None
            for line in proc.stdout:
                self._line(generation, line.rstrip('\n'))
            code = proc.wait()
            with self.lock:
                if generation == self.generation:
                    self.proc = None
                    if self.state != 'error':
                        self.state, self.message = 'stopped', 'The bot client stopped (exit %s).' % code
        except Exception as exc:  # shown in the panel
            with self.lock:
                if generation == self.generation:
                    self.proc = None
                    self.state, self.message = 'error', str(exc)[:400]

    def _line(self, generation, line):
        if not line.startswith('HB\t'):
            clean = ANSI.sub('', line)
            if ' WARN ' in clean or 'ERROR' in clean:
                with self.lock:
                    self.log.append(re.sub(r'^\S+\s+', '', clean)[:200])
            return
        try:
            event = json.loads(line[3:])
        except ValueError:
            return
        refused = False
        with self.lock:
            if generation != self.generation:
                return
            kind = event.get('ev')
            if kind == 'connected':
                self.user = str(event.get('user') or '')[:60]
                self.state, self.message = 'connected', 'Connected as %s. Waiting for a game.' % self.user
            elif kind == 'error':
                message = _friendly(event.get('msg'))
                self.log.append(message)
                if 'token request refused' in str(event.get('msg')):
                    self.state, self.message, refused = 'error', message, True
                elif self.state != 'connected':
                    self.message = message
            elif kind == 'lobby':
                rows = []
                for c in (event.get('challenges') or [])[:60]:
                    if not isinstance(c, dict) or not GAME_ID.match(str(c.get('id'))):
                        continue
                    rows.append(dict(id=c['id'], who=str(c.get('from') or '')[:40], mine=bool(c.get('mine')),
                                     to=(str(c.get('to'))[:40] if c.get('to') else None), rating=c.get('rating'),
                                     rated=c.get('rated'), mode=str(c.get('mode') or '')[:20],
                                     base=c.get('base'), increment=c.get('increment'), bot=bool(c.get('bot')),
                                     color=c.get('color') if c.get('color') in ('White', 'Black') else None))
                self.lobby, self.lobby_at = rows, time.time()
                if isinstance(event.get('online'), list):
                    self.online = [dict(name=str(u.get('name'))[:40], bot=bool(u.get('bot')),
                                        ratings={k: int(v) for k, v in (u.get('ratings') or {}).items()
                                                 if k in ('Bullet', 'Blitz', 'Rapid', 'Classic') and isinstance(v, (int, float))})
                                   for u in event['online'][:400] if isinstance(u, dict) and NAME.match(str(u.get('name') or ''))]
            elif kind == 'gone' and str(event.get('id')) in self.games:
                game = self.games[event['id']]
                if not game.get('finished'):
                    game.update(finished=True, result='Aborted or ended', our_turn=False, updated=time.time())
                    self.log.append('The game %s vs %s was aborted.' % (game.get('white') or 'White', game.get('black') or 'Black'))
                if self.thinking == event['id']:
                    self.thinking = None
            elif kind == 'manual':
                self.manual = bool(event.get('on'))
            elif kind == 'refused':
                self.refused = dict(id=str(event.get('id') or ''), msg=str(event.get('msg') or '')[:200], at=time.time())
                self.log.append('hivegame.com did not accept that: %s' % (str(event.get('msg') or 'no reason given')[:160]))
                try:
                    self._send(dict(cmd='resync'))  # our optimistic turn count is wrong now: ask for the real state
                except Exception:
                    pass
            elif kind == 'note':
                self.log.append(str(event.get('msg') or '')[:200])
            elif kind == 'challenge_sent':
                who = str(event.get('opponent') or '')[:40]
                self.log.append('Challenge sent%s: %d+%d, %s.' % (
                    ' to ' + who if who else ' (open to anyone)', int(event.get('base') or 0) // 60,
                    int(event.get('increment') or 0), 'rated' if event.get('rated') else 'casual'))
            elif kind == 'accept':
                if event.get('open'):
                    self.accepted += 1
                self.log.append('Accepted a challenge%s.' % (' from ' + str(event.get('from'))[:40] if event.get('from') else ''))
            elif kind == 'game' and GAME_ID.match(str(event.get('id'))):
                gid = event['id']
                game = self.games.setdefault(gid, {'id': gid, 'last_move': None})
                if gid not in self.order:
                    self.order.append(gid)
                status = event.get('status')
                result = None
                if event.get('finished') and isinstance(status, dict):
                    outcome = status.get('Finished')
                    if isinstance(outcome, dict) and outcome.get('Winner') in ('White', 'Black'):
                        result = outcome['Winner'] + ' won'
                    elif outcome == 'Draw':
                        result = 'Draw'
                    else:
                        result = 'Finished'
                elif event.get('finished'):
                    # Finished without a result: the game was aborted (hivegame.com deletes it, unrated).
                    result = 'Aborted by the opponent'
                    if not game.get('finished'):
                        self.log.append('%s vs %s was aborted by the opponent before it got going. Nothing was rated.' % (
                            str(event.get('white') or 'White')[:40], str(event.get('black') or 'Black')[:40]))
                if game.get('turn') != int(event.get('turn') or 0) or 'turn_at' not in game:
                    game['turn_at'] = time.time()  # when this move began, for 'thinking so far' (the site may repeat an update mid-move)
                game.update(turn=int(event.get('turn') or 0), finished=bool(event.get('finished')), result=result,
                            white=str(event.get('white') or '')[:40], black=str(event.get('black') or '')[:40],
                            our_turn=bool(event.get('our_turn')), updated=time.time(),
                            timed=bool(event.get('timed')), increment=event.get('increment'),
                            white_left=event.get('white_left'), black_left=event.get('black_left'),
                            clock_at=time.time())
                if game['finished'] and self.thinking == gid:
                    self.thinking = None
                game['base'] = event.get('base')
                game['speed'] = str(event.get('speed') or '')[:20]
                game['rated'] = event.get('rated')
                for side in ('white', 'black'):
                    card = event.get(side + '_card')
                    if isinstance(card, dict):
                        game[side + '_card'] = {k: card.get(k) for k in ('rating', 'change', 'bot', 'patreon', 'played', 'win', 'loss', 'draw', 'certainty')}
                if game['finished'] and isinstance(event.get('history'), list) and not game.get('saved'):
                    game['saved'] = True
                    self._record(game, event['history'])
            elif kind == 'think' and str(event.get('id')) in self.games:
                self.thinking = event['id']
                self.games[event['id']]['budget'] = str(event.get('args') or '')[:40]
            elif kind == 'info' and str(event.get('id')) in self.games:
                try:
                    self.games[event['id']].setdefault('evals', {})[str(int(event.get('turn') or 0))] = [
                        int(event['depth']), int(event['score']), str(event.get('move') or '')[:40]]
                    self.games[event['id']]['info'] = dict(turn=int(event.get('turn') or 0), depth=int(event['depth']),
                                                           score=int(event['score']), move=str(event.get('move') or '')[:40])
                except (KeyError, TypeError, ValueError):
                    pass
            elif kind == 'move' and str(event.get('id')) in self.games:
                game = self.games[event['id']]
                game['last_move'] = str(event.get('move') or '')[:40]
                game['turn'] = int(event.get('turn') or 0) + 1
                game['our_turn'] = False
                game['updated'] = time.time()
                if self.thinking == event['id']:
                    self.thinking = None
        if refused:
            self.stop()

    def _restore(self):
        """Bring the last few finished games back after a restart, with the engine's scores, so they can still be stepped through."""
        try:
            lines = [line for line in (BOT_DIR / 'games.jsonl').read_text().splitlines() if line.strip()][-8:]
        except Exception:
            return
        now = time.time()
        for n, line in enumerate(lines):
            try:
                row = json.loads(line)
                gid = str(row['id'])
                moves = row.get('moves') or []
                if len(moves) < 2:
                    continue
                evals = {str(k): v for k, v in (row.get('evals') or {}).items()}
                game = dict(id=gid, white=row.get('white'), black=row.get('black'), result=row.get('result'), finished=True, saved=True,
                            turn=len(moves), last_move=moves[-1] if moves else '', our_turn=False, updated=now - (len(lines) - n),
                            timed=False, base=row.get('base'), increment=row.get('increment'), speed=row.get('speed'), rated=row.get('rated'),
                            white_card=row.get('white_card'), black_card=row.get('black_card'), evals=evals)
                if evals:
                    last = max(evals, key=lambda k: int(k))
                    game['info'] = dict(turn=int(last), depth=int(evals[last][0]), score=int(evals[last][1]), move=str(evals[last][2]))
                self.games[gid] = game
                if gid in self.order:
                    self.order.remove(gid)
                self.order.append(gid)
            except Exception:
                continue

    def _record(self, game, history):
        """Append a finished game to FoulBroodData/hivegame-bot/games.jsonl (moves, result, our evaluations)."""
        try:
            moves = [' '.join(str(x) for x in pair).strip() for pair in history if isinstance(pair, list)][:2000]
            if len(moves) < 2:
                return  # aborted before the clock started: nothing to keep
            row = dict(id=game['id'], white=game.get('white'), black=game.get('black'), result=game.get('result'),
                       bot=self.user, engine=self.engine_name, base=game.get('base'), increment=game.get('increment'),
                       finished=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), moves=moves,
                       speed=game.get('speed'), rated=game.get('rated'), white_card=game.get('white_card'), black_card=game.get('black_card'),
                       evals=game.get('evals') or {})
            BOT_DIR.mkdir(parents=True, exist_ok=True)
            with (BOT_DIR / 'games.jsonl').open('a') as out:
                out.write(json.dumps(row) + '\n')
            # The viewer's History tab.
            import library
            n = len(moves)
            cards = [game.get('white_card') or {}, game.get('black_card') or {}]
            clock = '%d+%d' % (int(game['base']) // 60, int(game.get('increment') or 0)) if game.get('base') else ''
            library.add(dict(
                game='Base+MLP;InProgress;%s[%d];%s' % ('White' if n % 2 == 0 else 'Black', n // 2 + 1, ';'.join(moves)),
                white=game.get('white'), black=game.get('black'), result=game.get('result') or 'Finished', source='Live',
                time_control=(clock + (' rated' if game.get('rated') else ' casual' if game.get('rated') is False else '')).strip(),
                played=time.strftime('%Y-%m-%dT%H:%M:%S'), url='https://hivegame.com/game/' + str(game['id']),
                white_rating=cards[0].get('rating'), black_rating=cards[1].get('rating'),
                white_change=cards[0].get('change'), black_change=cards[1].get('change'),
                white_kind='Bot' if cards[0].get('bot') else 'Human', black_kind='Bot' if cards[1].get('bot') else 'Human',
                note=('Played by ' + self.engine_name) if self.engine_name else ''))
        except Exception as exc:  # never let record-keeping disturb play
            self.log.append('Could not save the game record: %s' % str(exc)[:120])

    # ---- what the panel sees -------------------------------------------------------------
    def view(self):
        with self.lock:
            games = [{k: v for k, v in self.games[g].items() if k != 'saved'} for g in self.order[-8:]]  # evals go along so a finished game can be stepped through with its scores
            for game in games:
                game['url'] = 'https://hivegame.com/game/' + game['id']
                game['thinking'] = self.thinking == game['id']
                game['clock_age'] = max(0.0, time.time() - game.get('clock_at', time.time()))
                game['turn_age'] = max(0.0, time.time() - game.get('turn_at', game.get('clock_at', time.time())))
            live = [g for g in games if not g.get('finished')]
            current = max(live, key=lambda g: g.get('updated', 0)) if live else None
            return dict(state=self.state, message=self.message, user=self.user, engine=self.engine_name,
                        running=self.proc is not None or self.state in ('building', 'starting'),
                        current=current, games=games, accepted=self.accepted, log=list(self.log)[-6:],
                        client_ready=(CLIENT_DIR / 'Cargo.toml').exists(), needs_build=_needs_build(),
                        saved_login=saved_login(), accept=list(self.accept), max_games=self.max_games,
                        anyone=self.anyone, humans=bool(getattr(self, 'humans', False)), clock=list(self.clock) if self.clock else None,
                        lobby=list(self.lobby) if self.state == 'connected' else [],
                        online=list(getattr(self, 'online', [])) if self.state == 'connected' else [],
                        site=True if self.state == 'connected' else site_online(),
                        manual=bool(self.manual) and self.state == 'connected', refused=self.refused, cleared=cleared_get())


_CLEARED = {}


def cleared_get():
    """The finished game the user cleared off the Online board; kept in a file so every window and a restart agree."""
    if 'v' not in _CLEARED:
        try:
            _CLEARED['v'] = (BOT_DIR / 'live-cleared.txt').read_text().strip() or None
        except Exception:
            _CLEARED['v'] = None
    return _CLEARED['v']


def cleared_set(value):
    _CLEARED['v'] = str(value)[:64] if value else None
    try:
        (BOT_DIR / 'live-cleared.txt').write_text(_CLEARED['v'] or '')
    except Exception:
        pass


_SITE = {'ok': None, 'at': 0.0, 'busy': False}


def _site_check():
    ok = False
    try:
        from urllib.request import Request, urlopen
        from urllib.error import HTTPError
        try:
            with urlopen(Request('https://hivegame.com/', headers={'User-Agent': 'FoulBrood/1.0 (connection check)'}), timeout=6) as r:
                ok = r.status < 500
        except HTTPError as e:
            ok = e.code < 500
    except Exception:
        ok = False
    _SITE.update(ok=ok, at=time.time(), busy=False)


def site_online():
    """Whether hivegame.com can be reached from this computer (checked in the background, at most every 30 s)."""
    if not _SITE['busy'] and time.time() - _SITE['at'] > 30:
        _SITE['busy'] = True
        threading.Thread(target=_site_check, daemon=True).start()
    return _SITE['ok']


BOT = HiveBot()


def _backfill_history():
    """First run of the History tab: bring in the bot games recorded before it existed."""
    if library is None or library.INDEX.exists():
        return
    try:
        rows = [json.loads(line) for line in (BOT_DIR / 'games.jsonl').read_text().splitlines() if line.strip()]
    except (OSError, ValueError):
        return
    for row in rows:
        try:
            moves = [m for m in row.get('moves') or [] if isinstance(m, str) and m]
            if not moves or not row.get('result'):
                continue  # aborted before it got going
            n = len(moves)
            cards = [row.get('white_card') or {}, row.get('black_card') or {}]
            clock = '%d+%d' % (int(row['base']) // 60, int(row.get('increment') or 0)) if row.get('base') else ''
            played = ''
            try:
                played = time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(__import__('calendar').timegm(time.strptime(row['finished'], '%Y-%m-%dT%H:%M:%SZ'))))
            except (KeyError, ValueError):
                pass
            library.add(dict(
                game='Base+MLP;InProgress;%s[%d];%s' % ('White' if n % 2 == 0 else 'Black', n // 2 + 1, ';'.join(moves)),
                white=row.get('white'), black=row.get('black'), result=row.get('result'), source='Live',
                time_control=(clock + (' rated' if row.get('rated') else ' casual' if row.get('rated') is False else '')).strip(),
                played=played, url='https://hivegame.com/game/' + str(row.get('id')),
                white_rating=cards[0].get('rating'), black_rating=cards[1].get('rating'),
                white_change=cards[0].get('change'), black_change=cards[1].get('change'),
                white_kind='Bot' if cards[0].get('bot') else ('Human' if cards[0] else ''),
                black_kind='Bot' if cards[1].get('bot') else ('Human' if cards[1] else ''),
                note=('Played by ' + str(row.get('engine'))) if row.get('engine') else ''))
        except Exception:
            continue


try:
    _backfill_history()
except Exception:
    pass


BUILT_IN = [Path.home() / 'Documents/Codex/FoulBroodData/Engines/ThoraxRex/thoraxrex',
            Path.home() / 'Documents/Codex/FoulBroodData/Engines/ThoraxRex-NoBook/thoraxrex']
_built_in_checked = False


def _ensure_built_in(engines):
    """The FoulBrood engine is part of the viewer: put it back if it is missing, reconnect it if it was disconnected."""
    global _built_in_checked
    if _built_in_checked or engines is None:
        return
    _built_in_checked = True
    try:
        import external_engines
        for path in BUILT_IN:
            if not path.is_file():
                continue
            entry = next((e for e in engines.entries if e.get('path') == str(path)), None)
            if entry is None:
                engines.add(external_engines.inspect_engine(str(path)))
            elif not entry.get('connected'):
                entry['connected'] = True
                engines.save()
    except Exception:
        pass


def hivebot_action(payload, engines):
    """Handle the bot panel's actions. `engines` is the viewer's EngineLibrary."""
    # Show the engine under the FoulBrood name, without net tag or build number (the viewer does the same when it starts).
    for entry in getattr(engines, 'entries', None) or []:
        name = entry.get('name') if isinstance(entry, dict) else None
        if isinstance(name, str) and name.startswith(('ThoraxRex', 'FoulBrood ')) and not name.startswith('FoulBrood Legacy') \
                and name not in ('FoulBrood', 'FoulBrood Book'):
            entry['name'] = 'FoulBrood Book' if ' Book' in name else 'FoulBrood'
    _ensure_built_in(engines)
    action = payload.get('action')
    if isinstance(action, str) and action.startswith('hivebot_library_'):
        # Bridge for the History tab until the viewer has been restarted with its own library route.
        import library
        return library.library_action(dict(payload, action=action[len('hivebot_'):]))
    if action == 'hivebot_status':
        if payload.get('lobby'):
            BOT.refresh_lobby()
        return BOT.view()
    if action == 'hivebot_cleared':
        cleared_set(payload.get('id'))
        return BOT.view()
    if action == 'hivebot_take':
        return BOT.take(payload.get('id'))
    if action == 'hivebot_manual':
        return BOT.set_manual(payload.get('on'))
    if action == 'hivebot_move':
        return BOT.hand_move(payload.get('id'), payload.get('move'))
    if action == 'hivebot_control':
        return BOT.control(payload.get('id'), payload.get('what'))
    if action == 'hivebot_stop':
        return BOT.stop()
    if action == 'hivebot_challenge':
        return BOT.challenge(payload.get('opponent'), payload.get('base'), payload.get('increment'),
                             payload.get('rated') is not False, payload.get('color'),
                             payload.get('min_rating'), payload.get('max_rating'))
    if action in ('hivebot_accept', 'hivebot_start'):
        BOT.humans = payload.get('humans') is True
    if action == 'hivebot_accept':
        return BOT.set_accept(payload.get('accept'), payload.get('max_games'), payload.get('anyone') is True,
                              payload.get('clock'))
    if action == 'hivebot_open':
        # Open a game page in the Mac's default browser. Only hivegame.com game links are accepted.
        url = str(payload.get('url') or '')
        if not re.fullmatch(r'https://hivegame\.com/game/[A-Za-z0-9_-]{1,40}', url):
            raise ValueError('Not a hivegame.com game link.')
        subprocess.Popen(['/usr/bin/open', url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return BOT.view()
    if action == 'hivebot_save_reference':
        # Saves opening-reference text gathered in the browser to one fixed file in the bot's data folder.
        text = payload.get('text')
        if not isinstance(text, str) or len(text) > 4_000_000:
            raise ValueError('Nothing to save.')
        target = Path.home() / 'Documents/Codex/FoulBroodData/hivegame-bot/opening-reference.json'
        target.write_text(text, encoding='utf-8')
        return dict(saved=len(text))
    if action == 'hivebot_forget':
        keychain_forget()
        return BOT.view()
    if action == 'hivebot_start':
        entry = engines.get(payload.get('engine'))
        if entry is None or not entry.get('connected') or not entry.get('path'):
            raise ValueError('Choose a connected engine for the bot.')
        return BOT.start(payload.get('login'), payload.get('password'), entry, payload.get('accept'),
                         payload.get('max_games'), payload.get('min_base'), payload.get('remember') is True,
                         payload.get('anyone') is True, payload.get('clock'))
    raise ValueError('Unknown bot action.')

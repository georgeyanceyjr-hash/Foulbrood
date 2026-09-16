"""Import a public, finished hivegame.com game without login or script execution."""
import json
import re
from html.parser import HTMLParser
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError
from import_game import variant, read_export

MAX_PAGE = 2_000_000


def game_url(value):
    if not isinstance(value, str):
        raise ValueError('Paste a finished hivegame.com game link.')
    value = value.strip()
    if value.startswith(('hivegame.com/', 'www.hivegame.com/')):
        value = 'https://' + value
    try:
        u = urlsplit(value)
        valid_port = u.port in (None, 443)
    except ValueError:
        raise ValueError('Use a link like https://hivegame.com/game/…')
    match = re.fullmatch(r'/game/([A-Za-z0-9_-]{6,64})/?', u.path)
    if (u.scheme != 'https' or u.hostname not in ('hivegame.com', 'www.hivegame.com')
            or u.username or u.password or not valid_port or not match):
        raise ValueError('Use a link like https://hivegame.com/game/…')
    return 'https://hivegame.com/game/' + match[1], match[1]


class Scripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []
        self.inside = False
    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            self.inside = True
            self.scripts.append('')
    def handle_endtag(self, tag):
        if tag == 'script': self.inside = False
    def handle_data(self, data):
        if self.inside: self.scripts[-1] += data


def pgn_from_page(page, game_id):
    parser = Scripts()
    parser.feed(page)
    decoder = json.JSONDecoder()
    for script in parser.scripts:
        for match in re.finditer(r'__RESOLVED_RESOURCES\[\d+\]\s*=\s*', script):
            try:
                value, _ = decoder.raw_decode(script[match.end():])
                data = json.loads(value) if isinstance(value, str) else value
            except (ValueError, TypeError):
                continue
            if not isinstance(data, dict) or data.get('game_id') != game_id:
                continue
            if data.get('finished') is not True:
                raise ValueError('This game is still in progress. Import it once it has finished.')
            history = data.get('history')
            if (not isinstance(history, list) or len(history) > 10000
                    or type(data.get('turn')) is not int or data['turn'] != len(history)):
                raise ValueError('The game link contains incomplete move history.')
            moves = []
            for pair in history:
                if (not isinstance(pair, list) or len(pair) != 2
                        or not all(isinstance(x, str) for x in pair)):
                    raise ValueError('The game link contains an invalid move.')
                moves.append(' '.join(pair).strip())
            result = data.get('game_status', {}).get('Finished')
            result = ('Draw' if result == 'Draw' else
                      {'White': 'WhiteWins', 'Black': 'BlackWins'}.get(
                          result.get('Winner') if isinstance(result, dict) else None))
            if result is None:
                raise ValueError('This finished game has no recognized result.')
            def name(side):
                player = data.get(side + '_player')
                value = player.get('username') if isinstance(player, dict) else None
                if not isinstance(value, str) or not value.strip(): return side.title()
                return re.sub(r'[\x00-\x1f\x7f"\\]', '', value).strip()[:100]
            tags = {'GameType': variant(data.get('game_type')), 'Site': 'https://hivegame.com/game/' + game_id,
                    'White': name('white'), 'Black': name('black'), 'Result': result}
            pgn = '\n'.join('[%s "%s"]' % item for item in tags.items()) + '\n\n'
            pgn += '\n'.join(f'{i}. {m}' for i, m in enumerate(moves, 1)) + '\n' + result
            read_export(pgn, 'game.pgn')  # Validate notation before replay.
            return pgn
    raise ValueError('Could not read this game link. Check the link, or import its PGN/JSON download instead.')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_game(value):
    url, game_id = game_url(value)
    request = Request(url, headers={'User-Agent': 'FoulBrood/1.0 (finished-game import)',
                                    'Accept': 'text/html'})
    try:
        with build_opener(NoRedirect).open(request, timeout=15) as response:
            raw = response.read(MAX_PAGE + 1)
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise ValueError('Could not reach that hivegame.com game. Try again or import its PGN/JSON file.') from exc
    if len(raw) > MAX_PAGE:
        raise ValueError('The game page is too large to import.')
    return pgn_from_page(raw.decode('utf-8'), game_id)

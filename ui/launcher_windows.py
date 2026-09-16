"""Start the portable Windows viewer in the current user's session."""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from launcher import working_board


def main():
    resources = Path(__file__).resolve().parent
    config = json.loads((resources/'beta.json').read_text(encoding='utf-8'))
    default = Path(os.environ.get('LOCALAPPDATA', str(Path.home()/'AppData/Local')))/'FoulBrood GUI Beta'
    runtime = Path(os.environ.get('FOULBROOD_DATA_DIR', str(default)))
    runtime.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, FOULBROOD_DATA_DIR=str(runtime),
               FOULBROOD_ENGINES_FILE=str(runtime/'engines.json'),
               FOULBROOD_ENGINE_CACHE=str(runtime/'engine-cache'),
               FOULBROOD_BUILD_ID=config['build_id'])
    state = runtime/'server.json'
    url = None
    try:
        candidate = json.loads(state.read_text(encoding='utf-8'))['url']
        if working_board(candidate, resources, config['build_id']):
            url = candidate
    except (OSError, ValueError, KeyError):
        pass
    if url is None:
        state.unlink(missing_ok=True)
        with (runtime/'server.log').open('a', encoding='utf-8') as log:
            process = subprocess.Popen(
                [str(resources/'python/pythonw.exe'), '-X', 'utf8', '-E', '-s', '-B',
                 str(resources/'ui/server.py'), '--state-file', str(state)],
                cwd=resources, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP)
        for _ in range(200):
            if process.poll() is not None:
                raise RuntimeError('The viewer could not start. Details: '+str(runtime/'server.log'))
            try:
                candidate = json.loads(state.read_text(encoding='utf-8'))['url']
                if working_board(candidate, resources, config['build_id']):
                    url = candidate
                    break
            except (OSError, ValueError, KeyError):
                pass
            time.sleep(.1)
        if url is None:
            raise RuntimeError('The viewer took too long to start. Details: '+str(runtime/'server.log'))
    if '--no-browser' not in sys.argv:
        os.startfile(url)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        ctypes.windll.user32.MessageBoxW(None, str(exc), 'FoulBrood GUI', 0x10)
        raise SystemExit(1)

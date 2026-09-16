#!/usr/bin/python3
"""Double-click launcher for the self-contained Mac app bundle."""
import json
import os
import sys
from pathlib import Path
import subprocess
import time
import urllib.request


def working_board(candidate, resources=None, build_id=None):
    if not candidate.startswith('http://127.0.0.1:'):return False
    try:
        with urllib.request.urlopen(candidate+'/health',timeout=1) as response:
            health=json.load(response)
            if health.get('app')!='foulbrood-local-board':return False
            if resources is not None and health.get('bundle_path')!=str(resources):return False
            if build_id is not None and health.get('build_id')!=build_id:return False
        # A moved bundle can leave a live process whose assets no longer exist.
        with urllib.request.urlopen(candidate+'/',timeout=2) as response:
            return b'id="board"' in response.read()
    except Exception:return False


def main():
    resources=Path(__file__).resolve().parents[1]/'Resources'
    config=json.loads((resources/'beta.json').read_text()) if (resources/'beta.json').exists() else {}
    default=Path.home()/'Library'/'Application Support'/'FoulBrood GUI Beta' if config else Path.home()/'Documents'/'FoulBroodData'
    runtime=Path(os.environ.get('FOULBROOD_DATA_DIR',str(default)))
    env=os.environ.copy()
    env.update(FOULBROOD_ENGINES_FILE=str(runtime/'engines.json'),FOULBROOD_ENGINE_CACHE=str(runtime/'engine-cache'),FOULBROOD_DATA_DIR=str(runtime),FOULBROOD_BUILD_ID=config.get('build_id','development'))
    runtime.mkdir(parents=True,exist_ok=True)
    state=runtime/'server.json'
    url=None
    if state.exists():
        try:
            saved=json.loads(state.read_text())
            candidate=saved['url']
            if working_board(candidate,resources,config.get('build_id','development')):url=candidate
        except Exception:pass
    if url is None:
        if state.exists():state.unlink()
        with (runtime/'server.log').open('a') as log:
            process=subprocess.Popen([sys.executable,'-E','-s','-B',str(resources/'ui/server.py'),'--state-file',str(state)],
                                     cwd=str(resources),env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
        for _ in range(100):
            if process.poll() is not None:raise RuntimeError('The local board could not start. Details: '+str(runtime/'server.log'))
            if state.exists():
                url=json.loads(state.read_text())['url'];break
            time.sleep(.1)
        if url is None:raise RuntimeError('The engine took too long to start.')
    subprocess.run(['/usr/bin/open',url],check=True)


if __name__=='__main__':
    try:main()
    except Exception as exc:
        subprocess.run(['/usr/bin/osascript','-e','on run argv\ndisplay alert "FoulBrood" message (item 1 of argv)\nend run',str(exc)])

"""Translate using FoulBrood's exact legal actions, never the legacy rule model."""
from platform_support import executable, process_options
from functools import lru_cache
import json
from pathlib import Path
import subprocess
import sys
from analytic import Analytic
ROOT=Path(__file__).resolve().parents[1]

def engine(command,game):
    p=subprocess.run([executable(ROOT, 'board_view'),command,game],capture_output=True,text=True,encoding='utf-8',**process_options(),timeout=30)
    if p.returncode:raise ValueError(p.stderr.strip())
    return json.loads(p.stdout)

@lru_cache(maxsize=64)
def translate_history(game):
    parts=game.split(';');texts=parts[3:]
    rows=[dict(number=i+1,traditional=text,analytic=None,error=None) for i,text in enumerate(texts)]
    try:frames=engine('trace',game)
    except ValueError:
        frames=[engine('snapshot',parts[0])]
        for text in texts:
            p=subprocess.run([executable(ROOT, 'board_view'),'play',frames[-1]['game'],text],capture_output=True,text=True,encoding='utf-8',**process_options())
            if p.returncode:break
            frames.append(json.loads(p.stdout))
    for i,row in enumerate(rows):
        if i+1>=len(frames):row['error']='The engine rejected this history.';continue
        try:row['analytic']=Analytic(frames[i]).translate(frames[i+1]['last_move'])
        except Exception as exc:row['error']=str(exc)
    return rows

def translate_move(game,move):
    before=engine('snapshot',game)
    p=subprocess.run([executable(ROOT, 'board_view'),'play',game,move],capture_output=True,text=True,encoding='utf-8',**process_options(),timeout=15)
    if p.returncode:raise ValueError(p.stderr.strip())
    after=json.loads(p.stdout)
    return Analytic(before).translate(after['last_move'])

if __name__=='__main__':
    if '--move' in sys.argv:
        data=json.load(sys.stdin);print(json.dumps(dict(analytic=translate_move(data['game'],data['move'])),ensure_ascii=False))
    else:print(json.dumps(translate_history(sys.stdin.read()),ensure_ascii=False))

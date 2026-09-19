#!/usr/bin/env python3
"""Run the viewer regressions with isolated data after building release helpers."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    node = shutil.which('node')
    if node is None:
        raise SystemExit('Node.js is required for the board-control tests.')
    scripts = sorted((ROOT / 'ui').glob('test_*.cjs'))
    if not scripts:
        raise SystemExit('No JavaScript tests found.')
    with tempfile.TemporaryDirectory(prefix='foulbrood-checks-') as directory:
        folder = Path(directory)
        env = dict(os.environ,
                   FOULBROOD_DATA_DIR=str(folder),
                   FOULBROOD_ENGINES_FILE=str(folder / 'engines.json'),
                   FOULBROOD_ENGINE_CACHE=str(folder / 'engine-cache'),
                   FOULBROOD_TEST_PYTHON=sys.executable,
                   PYTHONUTF8='1')
        subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'ui', '-v'],
                       cwd=ROOT, env=env, check=True, timeout=600)
        for script in scripts:
            print(f'Running {script.name}', flush=True)
            subprocess.run([node, str(script)], cwd=ROOT, env=env,
                           check=True, timeout=120)
        print(f'All {len(scripts)} JavaScript suites passed.', flush=True)


if __name__ == '__main__':
    main()

"""A freshly packaged viewer must boot independently of the source tree."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request


class PackageAppTests(unittest.TestCase):
    def test_packaged_viewer_starts_and_serves_assets(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix='viewer-package-test-') as directory:
            folder = Path(directory).resolve()
            subprocess.run([sys.executable, str(root/'ui/package_app.py'), directory],
                           check=True, capture_output=True, text=True)
            resources = folder/'FoulBrood.app/Contents/Resources'
            config = folder/'engines.json'
            config.write_text('{"version":2,"entries":[],"analysis_engine":null}')
            state_file = folder/'server.json'
            env = dict(os.environ, FOULBROOD_ENGINES_FILE=str(config),
                       FOULBROOD_DATA_DIR=str(folder),
                       FOULBROOD_ENGINE_CACHE=str(folder/'cache'))
            with (folder/'server.log').open('w+') as log:
                proc = subprocess.Popen(
                    [sys.executable, '-E', '-s', '-B', str(resources/'ui/server.py'),
                     '--port', '0', '--state-file', str(state_file)],
                    cwd=directory, env=env, stdout=log, stderr=log)
                try:
                    deadline = time.monotonic() + 15
                    while not state_file.exists():
                        if proc.poll() is not None or time.monotonic() > deadline:
                            log.seek(0)
                            self.fail('Packaged viewer did not start: '+log.read())
                        time.sleep(.05)
                    url = json.loads(state_file.read_text())['url']
                    with urllib.request.urlopen(url+'/health', timeout=5) as response:
                        self.assertEqual(json.load(response)['bundle_path'], str(resources))
                    with urllib.request.urlopen(url+'/api/state', timeout=5) as response:
                        self.assertIn('game', json.load(response))
                    for asset in ('/', '/app.js', '/review.js', '/engines.js', '/pieces.js', '/style.css'):
                        with self.subTest(asset=asset):
                            with urllib.request.urlopen(url+asset, timeout=5) as response:
                                self.assertEqual(response.status, 200)
                                self.assertTrue(response.read())
                finally:
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait()

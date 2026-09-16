import io
import unittest
from unittest.mock import patch
from launcher import working_board

class LauncherTests(unittest.TestCase):
    def test_moved_bundle_is_not_reused(self):
        with patch('launcher.urllib.request.urlopen',side_effect=[io.BytesIO(b'{"app":"foulbrood-local-board"}'),OSError('assets moved')]):
            self.assertFalse(working_board('http://127.0.0.1:1234'))
    def test_working_bundle_is_reused(self):
        with patch('launcher.urllib.request.urlopen',side_effect=[io.BytesIO(b'{"app":"foulbrood-local-board"}'),io.BytesIO(b'<svg id="board"></svg>')]):
            self.assertTrue(working_board('http://127.0.0.1:1234'))
    def test_unrelated_page_is_not_reused(self):
        with patch('launcher.urllib.request.urlopen',side_effect=[io.BytesIO(b'{"app":"foulbrood-local-board"}'),io.BytesIO(b'error')]):
            self.assertFalse(working_board('http://127.0.0.1:1234'))
    def test_reuse_requires_matching_bundle_and_build(self):
        for bundle,build,expected in [('/beta','one',True),('/old','one',False),('/beta','old',False)]:
            import json
            health=json.dumps(dict(app='foulbrood-local-board',bundle_path=bundle,build_id=build)).encode()
            with self.subTest(bundle=bundle,build=build),patch('launcher.urllib.request.urlopen',side_effect=[io.BytesIO(health),io.BytesIO(b'<svg id="board"></svg>')]):
                self.assertEqual(working_board('http://127.0.0.1:1234','/beta','one'),expected)

import json
from pathlib import Path
import unittest
from server import App
from import_game import read_export

FIXTURES=Path(__file__).parent/'fixtures'
class ImportTests(unittest.TestCase):
    def setUp(self):self.app=App()
    def tearDown(self):
        with self.app.lock:self.app.invalidate()
    def test_real_pgn_and_history_navigation(self):
        s=self.app.command(dict(action='load',filename='game.pgn',text=(FIXTURES/'hivegame.pgn').read_text()))
        self.assertEqual(s['ply'],74);self.assertEqual(s['state'],'InProgress')
        self.assertIn('BlackWins',s['import_info']);final=s['game']
        self.app.command(dict(action='navigate',direction='first'))
        self.assertEqual(self.app.command(dict(action='navigate',direction='last'))['game'],final)
    def test_real_json_with_carried_pieces_and_draw(self):
        s=self.app.command(dict(action='load',filename='game.json',text=(FIXTURES/'hivegame.json').read_text()))
        self.assertEqual(s['ply'],41);self.assertEqual(s['state'],'Draw');self.assertEqual(s['review_total'],41)
    def test_bad_import_preserves_existing_position(self):
        self.app.command(dict(action='load',confirm_review_clear=True,text='Base\nwS1'))
        game=self.app.session.data['game']
        with self.assertRaisesRegex(ValueError,'move 1'):
            self.app.command(dict(action='load',confirm_review_clear=True,filename='bad.pgn',text='[GameType "Base"]\n1. wQ'))
        self.assertEqual(self.app.session.data['game'],game)
    def test_json_selection_and_cycle(self):
        data=json.loads((FIXTURES/'hivegame.json').read_text());data['selected_node_id']=4
        variant,moves,note=read_export(json.dumps(data))
        self.assertEqual(len(moves),4);self.assertIn('not imported',note)
        data['nodes'][4]['parent']=4
        with self.assertRaisesRegex(ValueError,'cyclic'):read_export(json.dumps(data))
    def test_comments_and_unsupported_variations(self):
        v,m,n=read_export('[GameType "Base"]\n1. wS1 {a comment}\n2. bS1 wS1-\n*')
        self.assertEqual(m,['wS1','bS1 wS1-'])
        with self.assertRaises(ValueError):read_export('[GameType "Base"]\n1. wS1 (1. wA1)')

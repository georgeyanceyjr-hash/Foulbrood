import unittest, subprocess
from pathlib import Path
from server import App, snapshot
from platform_support import executable
from import_game import read_export

class SetupPositionTests(unittest.TestCase):
    def setUp(self):
        self.app=App();self.app.command({'action':'mode','mode':'analysis'})
        self.payload=dict(action='setup_position',variant='Base+MLP',side=0,turn=5,
            pieces=[dict(id=p,q=q,r=r,level=0) for p,q,r in
                [('wQ',0,0),('bQ',1,0),('wP',0,-1),('bP',-1,1),('wA1',-1,0),('bA1',2,0)]],last=None)

    def test_last_moved_piece_restriction_and_origin(self):
        before=self.app.command(self.payload)
        self.assertTrue(any(m['piece']=='wA1' for m in before['legal']))
        after=self.app.command(dict(self.payload,last={'piece':'wA1','from':[-2,1]}))
        self.assertFalse(any(m['piece']=='wA1' for m in after['legal']))
        self.assertEqual(after['last_move']['from'],[-2,1])
        self.assertEqual(after['ply'],0)

    def test_setup_replaces_old_history_with_only_last_move_context(self):
        self.app.command({'action':'load','text':'Base+MLP;InProgress;White[2];wS1;bS1 wS1-'})
        after=self.app.command(dict(self.payload,last={'piece':'wA1','from':[-2,1]}))
        self.assertEqual(after['review_total'],0)
        self.assertEqual(after['review_game'].split(';')[3:],[])
        self.assertEqual(after['last_move']['piece'],'wA1')
        self.assertEqual(after['last_move']['from'],[-2,1])

    def test_last_placement_is_visual_context_and_roundtrips(self):
        plain=self.app.command(self.payload)
        placed=self.app.command(dict(self.payload,last={'piece':'wA1','kind':'placed','from':None}))
        self.assertEqual(plain['legal'],placed['legal'])
        self.assertEqual(placed['setup_placed'],'wA1')
        self.assertIsNone(placed['last_move']['from'])
        for fmt in ['pgn','json']:
            exported=self.app.command({'action':'export','format':fmt})
            loaded=self.app.command({'action':'load','confirm_review_clear':True,'text':exported['text'],'filename':'test.'+fmt})
            self.assertEqual(loaded['setup_placed'],'wA1')
            self.assertEqual(loaded['last_move']['piece'],'wA1')
        later=self.app.command({'action':'move','move':placed['legal'][0]['move']})
        self.assertEqual(later['setup_placed'],'wA1')
        start=self.app.command({'action':'navigate','direction':'first'})
        self.assertEqual(start['last_move']['piece'],'wA1')
        self.assertIsNone(start['last_move']['from'])
        with self.assertRaises(ValueError):self.app.command(dict(self.payload,last={'piece':'wB2','kind':'placed'}))

    def test_custom_root_history_search_and_exports(self):
        root=self.app.command(self.payload)
        moved=self.app.command({'action':'move','move':root['legal'][0]['move']})
        self.assertEqual(moved['ply'],1)
        self.assertEqual(self.app.command({'action':'navigate','direction':'first'})['game'],root['game'])
        self.assertEqual(self.app.command({'action':'navigate','direction':'last'})['game'],moved['game'])
        for fmt in ('pgn','json'):
            text=self.app.command({'action':'export','format':fmt})['text']
            self.assertTrue('~' in read_export(text,'setup.'+fmt)[0])
            self.assertEqual(self.app.command({'action':'load','confirm_review_clear':True,'text':text,'filename':'setup.'+fmt})['game'],moved['game'])
        engine=executable(Path(__file__).resolve().parents[1], 'bench_search')
        p=subprocess.run([str(engine),root['game'],'50'],capture_output=True,text=True,timeout=5)
        self.assertEqual(p.returncode,0,p.stderr)
        move=p.stdout.strip().split('\t')[-1]
        self.assertIn(move,[m['move'] for m in root['legal']])

    def test_invalid_setup_leaves_previous_analysis_and_play_intact(self):
        before=self.app.view()['game'];play=self.app.play.data['game']
        for pieces in [self.payload['pieces']+[self.payload['pieces'][0]],
                       [dict(id='wQ',q=0,r=0,level=0),dict(id='bQ',q=10,r=0,level=0)],
                       self.payload['pieces']+[dict(id='bA2',q=0,r=0,level=1)]]:
            with self.assertRaises(ValueError):self.app.command(dict(self.payload,pieces=pieces))
            self.assertEqual(self.app.view()['game'],before)
            self.assertEqual(self.app.play.data['game'],play)

    def test_stack_roundtrip_and_root_bounds(self):
        p=dict(self.payload,pieces=self.payload['pieces']+[dict(id='wB1',q=0,r=0,level=1)])
        s=self.app.command(p)
        self.assertIn(dict(id='wB1',q=0,r=0,level=1),s['pieces'])
        self.assertEqual(snapshot('snapshot',s['game'])['game'],s['game'])
        for text in ['Base~0~5~wQ:-32768:0:0,bQ:1:0:0~','Base~0~5~wQ:0:0:0,wB1:0:0:7~']:
            with self.assertRaises(ValueError):snapshot('snapshot',text)

if __name__=='__main__':unittest.main()

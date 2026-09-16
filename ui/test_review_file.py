import base64
import copy
import json
import os
import re
import tempfile
import unittest
from unittest.mock import patch
from server import App, snapshot
from game_review import Review
from import_game import read_export
from review_file import read_review, save_review


def fake(review,data,generation):
    review.check(generation)
    return dict(score=10,side=data['side'],depth=4,move=data['legal'][0]['move'] if data['legal'] else None,terminal=False)


class ReviewFileTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.env=patch.dict(os.environ,FOULBROOD_ENGINES_FILE=self.temp.name+'/engines.json');self.env.start()
        self.app=App();self.app.command(dict(action='load',text='Base\nwS1\nbS1 wS1-\nwQ /wS1'))
        self.app.command(dict(action='review_enter'));self.app.analysis_ms=2000
        with patch.object(Review,'evaluate',fake):
            self.app.command(dict(action='review_start'));self.app.review.thread.join(5)
        self.assertEqual(self.app.review.status,'complete')
    def tearDown(self):
        if self.app.review:self.app.review.stop()
        self.app.invalidate();self.env.stop();self.temp.cleanup()
    def saved(self):return self.app.command(dict(action='review_save'))['text']
    def load(self,text,**kwargs):return self.app.command(dict(action='review_load',text=text,filename='review.pgn',**kwargs))
    def rewrite(self,text,change):
        block=re.search(r'\{FoulBroodReview v1\n([^}]+)\}',text)
        data=json.loads(base64.b64decode(block[1]));change(data)
        encoded=base64.b64encode(json.dumps(data).encode()).decode()
        return text[:block.start()]+'{FoulBroodReview v1\n'+encoded+'\n}'+text[block.end():]
    def test_complete_roundtrip_and_plain_game(self):
        self.app.analysis.player_names=['Alice','Bob'];self.app.analysis.reported_result='BlackWins'
        self.app.command(dict(action='navigate',ply=1))
        rows=copy.deepcopy(self.app.review.rows);points=copy.deepcopy(self.app.review.points)
        text=self.saved();variant,moves,_=read_export(text,'review.pgn')
        self.assertEqual(variant,'Base');self.assertEqual(moves,self.app.review.game.split(';')[3:])
        self.assertNotIn(self.app.review.engine['path'],text)
        checkpoint=read_review(text,self.app.review.game);self.assertNotIn('path',checkpoint['engine'])
        existing=self.app.review
        self.assertIn('review_confirmation',self.load(text));self.assertIs(self.app.review,existing)
        view=self.load(text,confirm_review_clear=True)
        self.assertEqual(view['game_review']['rows'],rows);self.assertEqual(view['game_review']['points'],points)
        self.assertEqual(view['game_review']['status'],'complete');self.assertEqual(view['ply'],1)
        self.assertEqual(view['analysis_ms'],2000);self.assertEqual(view['player_names'],['Alice','Bob']);self.assertEqual(view['reported_result'],'BlackWins')
        self.assertEqual(read_review(self.saved(),view['review_game'])['rows'],rows)
    def test_save_from_position_keeps_review_and_cursor_without_switching(self):
        rows=copy.deepcopy(self.app.review.rows)
        self.app.command(dict(action='review_exit'))
        self.app.command(dict(action='navigate',ply=1))
        saved=read_review(self.saved(),self.app.analysis.review_game)
        self.assertEqual(saved['rows'],rows)
        self.assertEqual(saved['cursor'],1)
        self.assertIsNone(self.app.review)
        self.assertEqual(self.app.analysis.data['ply'],1)
        self.assertTrue(self.app.saved_reviews)

    def test_partial_running_snapshot_and_resume_reuses_checkpoints(self):
        review=self.app.review
        review.rows=review.rows[:1];review.points=review.points[:2]
        initial=snapshot('snapshot','Base');after=snapshot('play',initial['game'],'wS1')
        review.before=fake(review,after,review.generation)
        next_board=snapshot('play',after['game'],'bS1 wS1-')
        review.pending_played=fake(review,next_board,review.generation)
        review.status='running'
        text=self.saved();self.assertEqual(review.status,'running','saving must not stop review')
        saved=read_review(text,review.game);self.assertEqual(saved['status'],'stopped')
        self.load(text,confirm_review_clear=True);self.assertTrue(self.app.review.can_resume())
        calls=[]
        def count(obj,data,generation):calls.append(data['game']);return fake(obj,data,generation)
        with patch.object(Review,'evaluate',count):
            self.app.command(dict(action='review_start'));self.app.review.thread.join(5)
        self.assertEqual(self.app.review.status,'complete');self.assertEqual(len(self.app.review.rows),3)
        self.assertNotIn(initial['game'],calls);self.assertNotIn(after['game'],calls);self.assertNotIn(next_board['game'],calls)
        self.assertEqual(self.app.review.rows[:1],saved['rows'])
    def test_missing_engine_still_loads_and_reconnect_can_resume(self):
        review=self.app.review;review.rows=[];review.points=review.points[:1]
        initial=snapshot('snapshot','Base');review.before=fake(review,initial,review.generation);review.pending_played=None;review.status='stopped'
        text=self.saved();entry=self.app.engines.get('Computer');entry['connected']=False
        v=self.load(text,confirm_review_clear=True)
        self.assertEqual(v['game_review']['points'],review.points);self.assertTrue(v['game_review']['resume_engine_missing']);self.assertFalse(v['game_review']['can_resume'])
        self.app.command(dict(action='review_exit'));self.app.command(dict(action='review_enter'))
        self.assertEqual(self.app.review.points,review.points)
        entry['connected']=True
        v=self.app.command(dict(action='engine_select',id='Computer'))
        self.assertTrue(v['game_review']['can_resume']);self.assertEqual(v['game_review']['points'],review.points)
    def test_external_engine_different_local_id_and_path(self):
        r=self.app.review;r.engine=dict(id='old',name='Nokamute 1.0',path='/old/local/engine',score_adapter='nokamute')
        text=self.saved()
        self.app.engines.entries.append(dict(id='new',name='Nokamute 1.0',path='/new/local/engine',score_adapter='nokamute',connected=True,review_supported=True))
        v=self.load(text,confirm_review_clear=True)
        self.assertEqual(v['analysis_engine'],'new');self.assertEqual(self.app.review.engine['path'],'/new/local/engine')
        self.assertFalse(v['game_review']['resume_engine_missing']);self.assertTrue(v['game_review']['external'])
    def test_invalid_files_do_not_replace_review(self):
        text=self.saved();original=self.app.review
        changes=[lambda d:d.update(version=2),lambda d:d.update(game=d['game']+';pass'),
                 lambda d:d['rows'][0].update(score=float('nan')),lambda d:d['rows'][0].update(ply=2),
                 lambda d:d['engine'].update(path='/untrusted/program'),lambda d:d.update(milliseconds=-1),
                 lambda d:d['before'].update(move='wQ bad'),lambda d:d.update(cursor=999)]
        for change in changes:
            with self.subTest(change=change):
                with self.assertRaises(ValueError):self.load(self.rewrite(text,change),confirm_review_clear=True)
                self.assertIs(self.app.review,original)
        with self.assertRaises(ValueError):self.load('[GameType "Base"]\n1. wS1\n*',confirm_review_clear=True)
        self.assertIs(self.app.review,original)
    def test_setup_black_root_and_ready_review(self):
        self.app.command(dict(action='review_exit'))
        self.app.command(dict(action='setup_position',variant='Base',side=1,turn=4,pieces=[dict(id='wQ',q=0,r=0,level=0),dict(id='bQ',q=1,r=0,level=0)],confirm_review_clear=True))
        self.app.command(dict(action='review_enter'))
        text=self.saved();v=self.load(text,confirm_review_clear=True)
        self.assertEqual(v['side'],1);self.assertEqual(v['game_review']['rows'],[])

    def test_mzinga_line_reader_compatibility(self):
        # Mzinga.Core.GameRecording.LoadPGN uses a line-based parser: tags,
        # standalone brace comments (including multiline), moves, enum results.
        for result in (None,'*','1-0','0-1','1/2-1/2','WhiteWins','BlackWins','Draw'):
            self.app.analysis.reported_result=result
            text=self.saved();moves=[];in_comment=False
            for line in text.splitlines():
                line=line.strip()
                if in_comment:
                    if line.endswith('}'):in_comment=False
                elif line.startswith('[') and line.endswith(']'):continue
                elif line.startswith('{'):in_comment=not line.endswith('}')
                elif line and line not in ('NotStarted','InProgress','WhiteWins','BlackWins','Draw'):
                    moves.append(line.lstrip('.1234567890 '))
            self.assertFalse(in_comment)
            self.assertEqual(moves,self.app.review.game.split(';')[3:])

if __name__=='__main__':unittest.main()

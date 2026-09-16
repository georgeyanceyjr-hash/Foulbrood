import copy
import os
import tempfile
import unittest
from unittest.mock import patch
from server import App
from live_analysis import visible_history
from game_review import Review
from review_file import read_review
from test_review_file import fake


class LiveAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.env=patch.dict(os.environ,FOULBROOD_ENGINES_FILE=self.temp.name+'/engines.json');self.env.start()
        self.app=App();self.app.command(dict(action='new',variant='Base',time='5+4',players=['Human','Human']))
        self.app.hints=True;self.app.search_milliseconds=2000
    def tearDown(self):
        if self.app.review:self.app.review.stop()
        self.app.invalidate();self.env.stop();self.temp.cleanup()
    def hint(self,score=10):
        s=self.app.session
        return dict(move=s.data['legal'][0]['move'],depth=5,score=score,seconds=1.2,side=s.data['side'],source='search')
    def play_with_hint(self):
        self.app.hint=self.hint();move=self.app.hint['move'];self.app.move(move)
    def test_human_capture_survives_moves_history_and_transfer(self):
        self.play_with_hint();self.play_with_hint()
        history=copy.deepcopy(self.app.play.analysis_history)
        self.assertEqual(list(history),[0,1]);self.assertEqual(history[0]['milliseconds'],2000)
        v=self.app.command(dict(action='navigate',ply=0))
        self.assertTrue(v['use_recorded_analysis']);self.assertEqual(v['recorded_analysis'][0],history[0]);self.assertIsNone(v['recorded_analysis'][1])
        v=self.app.command(dict(action='navigate',ply=1));self.assertEqual(v['recorded_analysis'],[history[0],history[1]])
        self.app.command(dict(action='open_analysis'));v=self.app.command(dict(action='review_enter'))
        self.assertEqual(v['game_review']['source'],'in_game');self.assertEqual(v['game_review']['rows'],[])
        self.assertEqual(len(v['game_review']['points']),2);self.assertEqual(self.app.analysis.analysis_history,history)
        self.app.analysis.analysis_history[0]['evaluation']['score']=999
        self.assertEqual(self.app.play.analysis_history,history,'review copy must not mutate Play history')
    def test_final_bot_result_captured_without_browser_poll(self):
        s=self.app.play;s.players=['Computer','Computer'];result=self.hint()
        s.thoughts[0]=dict(ply=1,status='played',started=0,evaluation=result,milliseconds=4500,engine='FoulBrood')
        self.app.move(result['move'])
        self.assertEqual(s.analysis_history[0]['evaluation']['score'],10)
        self.assertEqual(s.analysis_history[0]['milliseconds'],4500)
        self.assertNotIn(1,s.analysis_history,'previous thought must not be attached to next position')
    def test_separate_analyst_is_captured_before_worker_stops(self):
        self.app.engines.entries.append(dict(id='nok',name='Nokamute',path='/test/nok',connected=True,score_adapter='nokamute'))
        self.app.engines.analysis_engine='nok';s=self.app.play;s.players=['Computer','Human']
        s.thoughts[0]=dict(ply=1,status='thinking',started=0,evaluation=self.hint(),milliseconds=3000)
        worker=App(engines=self.app.engines,position=s.data);worker.analysis=worker.play;worker.mode='analysis';worker.search_milliseconds=10000
        worker.hint=dict(self.hint(),source='external',score=None,engine_score=25)
        self.app.insight_worker=worker
        self.app.move(self.hint()['move'])
        record=s.analysis_history[0]
        self.assertEqual(record['engine']['name'],'Nokamute');self.assertEqual(record['evaluation']['engine_score'],25);self.assertEqual(record['milliseconds'],10000)
        self.assertIsNone(self.app.insight_worker)
    def test_latest_result_only_and_gap_not_filled_with_old_score(self):
        self.app.hint=self.hint(10);self.app.view();self.app.hint=self.hint(20);self.app.view();self.app.move(self.app.hint['move'])
        self.app.move(self.app.session.data['legal'][0]['move'])
        self.assertEqual(len(self.app.play.analysis_history),1)
        self.assertEqual(self.app.play.analysis_history[0]['evaluation']['score'],20)
        self.assertEqual(visible_history(self.app.play.analysis_history,2),[None,None])
    def test_finished_game_keeps_both_last_evaluations(self):
        self.play_with_hint();self.play_with_hint()
        history=copy.deepcopy(self.app.play.analysis_history)
        self.app.pause();self.app.play.resigned_side=0
        self.assertEqual(self.app.view()['recorded_analysis'],[history[0],history[1]])
        self.app.command(dict(action='open_analysis'))
        self.assertEqual(self.app.view()['recorded_analysis'],[history[0],history[1]])
        self.app.command(dict(action='navigate',ply=0))
        self.assertEqual(self.app.view()['recorded_analysis'],[history[0],None])

    def test_wins_draw_and_timeout_keep_last_evaluations(self):
        self.play_with_hint();self.play_with_hint();self.app.pause()
        s=self.app.play;history=copy.deepcopy(s.analysis_history);game=s.review_game
        for result in ('WhiteWins','BlackWins','Draw'):
            with self.subTest(result=result):
                parts=game.split(';');parts[1]=result;s.review_game=';'.join(parts)
                self.assertEqual(self.app.view()['recorded_analysis'],[history[0],history[1]])
        s.review_game=game;s.timeout_side=0
        self.assertEqual(self.app.view()['recorded_analysis'],[history[0],history[1]])

    def test_undo_and_reset_remove_stale_positions(self):
        self.play_with_hint();self.play_with_hint();self.app.command(dict(action='undo'))
        self.assertEqual(list(self.app.play.analysis_history),[0])
        self.app.command(dict(action='reset_play'));self.assertEqual(self.app.play.analysis_history,{})
    def test_pg_file_retains_both_sources_and_full_review_preserves_archive(self):
        self.play_with_hint();self.play_with_hint();self.app.command(dict(action='open_analysis'));self.app.command(dict(action='review_enter'))
        history=copy.deepcopy(self.app.analysis.analysis_history)
        with patch.object(Review,'evaluate',fake):
            v=self.app.command(dict(action='review_start'));self.assertNotIn('review_confirmation',v)
            self.app.review.thread.join(5)
        self.assertEqual(self.app.review.status,'complete');self.assertEqual(self.app.review.source,'review')
        self.app.command(dict(action='review_source',source='in_game'))
        text=self.app.command(dict(action='review_save'))['text'];saved=read_review(text,self.app.review.game)
        self.assertEqual(saved['in_game_history'],history);self.assertEqual(len(saved['rows']),2)
        v=self.app.command(dict(action='review_load',text=text,filename='review.pgn',confirm_review_clear=True))
        self.assertEqual(v['game_review']['source'],'in_game');self.assertEqual(v['game_review']['rows'],[])
        v=self.app.command(dict(action='review_source',source='review'));self.assertEqual(len(v['game_review']['rows']),2)
        self.assertEqual(self.app.analysis.analysis_history,history)

if __name__=='__main__':unittest.main()

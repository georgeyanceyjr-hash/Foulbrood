import threading
import tempfile
import os
import unittest
from unittest.mock import patch
from server import App
from game_review import Review,classify,white_score

class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.environment=patch.dict(os.environ,{"FOULBROOD_ENGINES_FILE":self.temp.name+"/engines.json"});self.environment.start()
        self.app=App();self.app.command(dict(action='load',text='Base\nwS1\nbS1 wS1-\nwQ /wS1'))
    def tearDown(self):
        if self.app.review:self.app.review.stop()
        self.app.invalidate();self.environment.stop();self.temp.cleanup()
    def fake(self,data,generation):
        self.check(generation)
        return dict(score=10,side=data['side'],depth=4,move=data['legal'][0]['move'] if data['legal'] else None,terminal=False)
    def test_enter_navigation_exit_and_infinite(self):
        self.app.analysis_ms=0;game=self.app.session.review_game
        v=self.app.command(dict(action='review_enter'));self.assertEqual(v['analysis_ms'],60000)
        self.assertFalse(v['hints']);self.assertEqual(v['game_review']['total'],3)
        with patch.object(self.app,'launch_search') as launch:self.app.tick();launch.assert_not_called()
        v=self.app.command(dict(action='navigate',ply=1));self.assertEqual(v['ply'],1);self.assertIsNotNone(v['game_review'])
        with self.assertRaises(ValueError):self.app.command(dict(action='move',move=v['legal'][0]['move']))
        v=self.app.command(dict(action='review_exit'));self.assertIsNone(v['game_review']);self.assertEqual(v['review_game'],game)
    def test_page_navigation_keeps_completed_review(self):
        self.app.command(dict(action='review_enter'))
        review=self.app.review
        with patch.object(Review,'evaluate',ReviewTests.fake):
            self.app.command(dict(action='review_start'));review.thread.join(5)
        self.assertEqual(review.status,'complete')
        rows=review.rows.copy();points=review.points.copy()
        for destination in ('position','setup','play'):
            self.app.command(dict(action='review_exit'))
            if destination=='setup':self.app.command(dict(action='setup_source',source='analysis'))
            if destination=='play':
                self.app.command(dict(action='mode',mode='play'))
                self.app.command(dict(action='mode',mode='analysis'))
            self.app.command(dict(action='review_enter'))
            self.assertIs(self.app.review,review)
            self.assertEqual(self.app.review.rows,rows)
            self.assertEqual(self.app.review.points,points)
            self.assertEqual(self.app.review.status,'complete')

    def test_leaving_running_review_keeps_finished_rows_but_stops_work(self):
        self.app.command(dict(action='review_enter'));review=self.app.review
        review.status='running';review.rows=[{'ply':1}];generation=review.generation
        self.app.command(dict(action='review_exit'))
        self.assertGreater(review.generation,generation)
        self.app.command(dict(action='review_enter'))
        self.assertIs(self.app.review,review)
        self.assertEqual(review.status,'stopped');self.assertEqual(review.rows,[{'ply':1}])

    def test_different_game_does_not_reuse_saved_review(self):
        self.app.command(dict(action='review_enter'));review=self.app.review
        self.app.command(dict(action='review_exit'))
        self.app.command(dict(action='load',confirm_review_clear=True,text='Base\nwA1'))
        self.app.command(dict(action='review_enter'))
        self.assertIsNot(self.app.review,review)
        self.assertEqual(self.app.review.rows,[])

    def test_review_full_game_from_past_and_equal_budgets(self):
        self.app.command(dict(action='navigate',ply=1));self.app.command(dict(action='review_enter'))
        calls=[];fake=self.fake
        def evaluate(obj,data,generation):
            calls.append((data['game'],obj.milliseconds))
            shown=self.app.view()
            self.assertEqual(shown['ply'],data['ply'])
            self.assertEqual(shown['game'].split(';')[3:],obj.game.split(';')[3:3+data['ply']], 'follow actual game, not hypothetical alternatives')
            return fake.__func__(obj,data,generation)
        with patch.object(Review,'evaluate',evaluate):
            self.app.command(dict(action='review_start'));review=self.app.review;review.thread.join(5)
        self.assertEqual(review.status,'complete');self.assertEqual(len(review.rows),3);self.assertEqual(len(review.points),4)
        self.assertEqual(self.app.session.data['ply'],3);self.assertEqual({ms for _,ms in calls},{60000})
        self.assertEqual([r['ply'] for r in review.rows],[1,2,3])
    def test_stop_cannot_publish_late_results(self):
        started=threading.Event();release=threading.Event()
        def evaluate(obj,data,generation):started.set();release.wait(2);obj.check(generation);return {}
        self.app.command(dict(action='review_enter'))
        with patch.object(Review,'evaluate',evaluate):
            self.app.command(dict(action='review_start'));r=self.app.review;self.assertTrue(started.wait(2))
            self.app.command(dict(action='review_stop'));self.app.command(dict(action='navigate',ply=2));release.set();r.thread.join(2)
        self.assertEqual(self.app.session.data['ply'],2,'stopped worker must not move the cursor')
        self.assertEqual(r.rows,[]);self.assertEqual(r.points,[]);self.assertEqual(r.status,'stopped')
    def test_running_review_rejects_time_change_without_clearing_progress(self):
        self.app.command(dict(action='review_enter'));review=self.app.review
        review.status='running';review.rows=[{'ply':1}];generation=review.generation
        with self.assertRaisesRegex(ValueError,'Stop analysis'):
            self.app.command(dict(action='insight_time',milliseconds=5000))
        self.assertEqual(review.generation,generation);self.assertEqual(review.rows,[{'ply':1}])
        self.assertEqual(review.status,'running')
        self.app.command(dict(action='review_stop'))
        self.app.command(dict(action='insight_time',milliseconds=5000))
        self.assertEqual(self.app.analysis_ms,5000)

    def test_change_time_and_load_cancel_review(self):
        self.app.command(dict(action='review_enter'));r=self.app.review
        self.app.command(dict(action='insight_time',milliseconds=0));self.assertEqual(self.app.analysis_ms,60000)
        self.app.command(dict(action='load',confirm_review_clear=True,text='Base'));self.assertIsNot(self.app.review,r);self.assertEqual(self.app.review.total,0);self.assertGreater(r.generation,0)
    def test_failure_is_reported_and_empty_game_cannot_start(self):
        self.app.command(dict(action='review_enter'))
        with patch.object(Review,'evaluate',side_effect=ValueError('test error')):
            self.app.command(dict(action='review_start'));r=self.app.review;r.thread.join(2)
        self.assertEqual(r.status,'error');self.assertIn('test error',r.error)
        self.app.command(dict(action='load',confirm_review_clear=True,text='Base'));self.app.command(dict(action='review_enter'))
        with self.assertRaises(ValueError):self.app.command(dict(action='review_start'))
    def test_finished_play_opens_review_without_starting_search(self):
        self.app.command(dict(action='new',time='1+2',variant='Base',players=['Human','Human']))
        self.app.command(dict(action='move',move='wS1'))
        self.app.command(dict(action='resign',side=1))
        v=self.app.command(dict(action='open_analysis',confirm_review_clear=True,ply=0))
        self.assertEqual(v['mode'],'analysis');self.assertEqual(v['ply'],0)
        self.assertEqual(v['game_review']['status'],'ready');self.assertEqual(v['game_review']['total'],1)
        self.assertEqual(v['reported_result'],'WhiteWins');self.assertIsNone(self.app.review.process)

    def test_import_in_review_stays_in_review_and_bad_import_keeps_it(self):
        self.app.command(dict(action='review_enter'));before=self.app.review
        with self.assertRaises(ValueError):self.app.command(dict(action='load',confirm_review_clear=True,text='Base\ninvalid'))
        self.assertIs(self.app.review,before)
        v=self.app.command(dict(action='load',confirm_review_clear=True,text='Base\nwS1'))
        self.assertEqual(v['game_review']['total'],1);self.assertEqual(v['game_review']['status'],'ready')
        self.assertEqual(v['game_review']['rows'],[])

    def test_search_budget_and_remaining_time(self):
        self.app.command(dict(action='review_enter'));r=self.app.review
        data=self.app.session.data;move=data['legal'][0]['move']
        class Process:
            returncode=0
            def poll(self):return 0
            def communicate(self,timeout=None):return ('4\t100\t20\t0.5\t'+move+'\n','')
        with patch('game_review.subprocess.Popen',return_value=Process()) as popen:
            before=r.remaining_units;result=r.evaluate(data,r.generation)
            self.assertEqual(result['score'],20);self.assertEqual(r.remaining_units,before-1)
            self.assertEqual(popen.call_args[0][0][-1],'60000')
        r.phase_started=100
        with patch('game_review.time.monotonic',return_value=115):
            self.assertEqual(r.view()['remaining_seconds'],r.remaining_units*60-15)
        r.phase_started=None

    def test_external_score_scales_and_forced_results(self):
        from external_engines import review_score
        for adapter,unit in [('mzinga',1000000),('nokamute',100)]:
            score=lambda v:review_score(dict(engine_score=v),adapter)
            self.assertEqual(classify(score(unit),score(0)),('Blunder','??'))
            self.assertEqual(classify(score(unit/2),score(0)),('Mistake','?'))
            self.assertEqual(classify(score(unit/5),score(0)),('Inaccuracy','?!'))
            self.assertLessEqual(abs(score(1e20)),99000)
            self.assertEqual(review_score(dict(engine_forced_winner='Black'),adapter),-100000)
            self.assertIsNone(review_score({},adapter))

    def test_review_selects_supported_external_and_cancels_on_disconnect(self):
        self.app.engines.add(dict(id='test',name='MzingaEngine test',path='/test/mzinga',score_adapter='mzinga',capabilities=[]))
        self.app.command(dict(action='engine_select',id='test'))
        self.app.command(dict(action='review_enter'))
        started=threading.Event();release=threading.Event()
        def evaluate(obj,data,generation):started.set();release.wait(2);obj.check(generation);return {}
        with patch.object(Review,'evaluate',evaluate):
            self.app.command(dict(action='review_start'));r=self.app.review;self.assertTrue(started.wait(2))
            self.assertEqual(r.view()['engine'],'MzingaEngine test');self.assertTrue(r.view()['external'])
            self.app.command(dict(action='engine_toggle',id='test',connected=False))
            release.set();r.thread.join(2)
        self.assertEqual(r.status,'stopped');self.assertEqual(r.rows,[])

    def test_missing_external_program_reports_error_without_hanging(self):
        self.app.engines.add(dict(id='missing',name='MzingaEngine test',path='/nonexistent/engine',score_adapter='mzinga',capabilities=[]))
        self.app.command(dict(action='engine_select',id='missing'));self.app.command(dict(action='review_enter'))
        self.app.command(dict(action='review_start'));r=self.app.review;r.thread.join(3)
        self.assertEqual(r.status,'error');self.assertTrue(r.error);self.assertIsNone(r.process)

    def test_opening_axis_cannot_be_flagged(self):
        self.app.command(dict(action='load',text='Base\nwS1\nbS1 wS1-'))
        self.app.command(dict(action='review_enter'))
        def evaluate(obj,data,generation):
            obj.check(generation)
            move='wS1' if data['ply']==0 else 'bS1 -wS1' if data['ply']==1 else data['legal'][0]['move']
            return dict(score=1000*data['ply'],side=data['side'],depth=5,move=move,terminal=False)
        with patch.object(Review,'evaluate',evaluate):
            self.app.command(dict(action='review_start'));r=self.app.review;r.thread.join(3)
        self.assertEqual(r.status,'complete');self.assertEqual(r.rows[1]['label'],'Best move')
        self.assertEqual(r.rows[1]['alternative'],r.rows[1]['move'])

    def test_switching_review_engine_never_relabels_old_results(self):
        self.app.engines.add(dict(id='second',name='Second',path='/test/second',capabilities=[],score_adapter='mzinga'))
        self.app.command(dict(action='review_enter'));first=self.app.review
        first.status='complete';first.rows=[{'ply':1,'score':123}]
        self.app.command(dict(action='engine_select',id='second'))
        self.assertEqual(self.app.review.engine['id'],'second')
        self.assertEqual(self.app.review.rows,[])
        self.app.command(dict(action='engine_select',id='Computer'))
        self.assertIs(self.app.review,first)
        self.assertEqual(self.app.review.rows,[{'ply':1,'score':123}])

    def test_invalid_navigation_does_not_close_review(self):
        self.app.command(dict(action='review_enter'));review=self.app.review
        for payload in [dict(action='mode',mode='invalid'),dict(action='new',time='bad',players=['Human','Human'],variant='Base')]:
            with self.assertRaises(ValueError):self.app.command(payload)
            self.assertIs(self.app.review,review)

    def test_review_preserves_engine_but_blocks_new_unsupported_selection(self):
        self.app.engines.add(dict(id='other',name='Moves only',path='/test/other',capabilities=[]))
        self.app.command(dict(action='engine_select',id='other'))
        self.app.command(dict(action='review_enter'))
        self.assertEqual(self.app.engines.analysis_engine,'other')
        with self.assertRaisesRegex(ValueError,'supports game review'):
            self.app.command(dict(action='engine_select',id='other'))
        self.app.command(dict(action='engine_select',id='Computer'))
        self.assertEqual(self.app.engines.analysis_engine,'Computer')

    def test_unsupported_review_is_rejected(self):
        self.app.engines.add(dict(id='test',name='Moves only',path='/test/other',capabilities=[]))
        self.app.command(dict(action='engine_select',id='test'))
        self.app.command(dict(action='engine_toggle',id='Computer',connected=False))
        self.app.command(dict(action='review_enter'))
        with self.assertRaisesRegex(ValueError,'supports game review'):
            self.app.command(dict(action='review_start'))

    def test_resume_keeps_completed_moves_and_pending_played_evaluation(self):
        self.app.command(dict(action='review_enter'));r=self.app.review
        full=r.game;calls=[];started=threading.Event();release=threading.Event()
        def evaluate(obj,data,generation):
            obj.check(generation);calls.append(data['game'])
            self.assertEqual(self.app.session.data['ply'],data['ply'])
            # Force an alternative for move 3 and interrupt only that comparison.
            if data['ply']==3 and data['game']!=full and not release.is_set():
                started.set();release.wait(3);obj.check(generation)
            next_move=full.split(';')[3+data['ply']] if data['ply']<3 else None
            legal=[m['move'] for m in data['legal']]
            move=next_move if next_move in legal else legal[0] if legal else None
            if data['ply']==2:move=next(m for m in legal if m!=next_move)
            return dict(score=10,side=data['side'],depth=5,move=move,terminal=False)
        with patch.object(Review,'evaluate',evaluate):
            self.app.command(dict(action='review_start'));self.assertTrue(started.wait(3))
            self.app.command(dict(action='review_stop'));release.set();r.thread.join(3)
            self.assertEqual(len(r.rows),2);self.assertIsNotNone(r.pending_played)
            rows=r.rows.copy();points=r.points.copy();before_calls=calls.copy()
            self.assertTrue(r.view()['can_resume'])
            self.app.command(dict(action='review_exit'));self.app.command(dict(action='review_enter'))
            self.app.command(dict(action='review_start'));r.thread.join(3)
        self.assertEqual(r.status,'complete');self.assertEqual(r.rows[:2],rows);self.assertEqual(r.points[:3],points)
        self.assertEqual([row['ply'] for row in r.rows],[1,2,3]);self.assertEqual([p['ply'] for p in r.points],[0,1,2,3])
        self.assertEqual(len(calls),len(before_calls)+1,'only interrupted alternative is searched again')
        self.assertEqual(calls.count(full),1,'finished played continuation is not repeated')
        self.assertEqual(r.remaining_units,0)

    def test_error_can_resume_without_repeating_completed_searches(self):
        self.app.command(dict(action='review_enter'));r=self.app.review;calls=[];fail=True
        def evaluate(obj,data,generation):
            obj.check(generation);calls.append(data['ply'])
            if fail and data['ply']==2:raise ValueError('temporary engine failure')
            moves=r.game.split(';')[3:];legal=[m['move'] for m in data['legal']]
            move=moves[data['ply']] if data['ply']<len(moves) else legal[0]
            return dict(score=10,side=data['side'],depth=5,move=move,terminal=False)
        with patch.object(Review,'evaluate',evaluate):
            self.app.command(dict(action='review_start'));r.thread.join(3)
            self.assertEqual(r.status,'error');self.assertEqual(len(r.rows),1);self.assertTrue(r.can_resume())
            calls.clear();fail=False
            self.app.command(dict(action='review_start'));r.thread.join(3)
        self.assertEqual(r.status,'complete');self.assertFalse(r.error);self.assertNotIn(0,calls);self.assertNotIn(1,calls)
        self.assertEqual(len(r.rows),3)

    def test_restart_and_budget_change_require_confirmation(self):
        self.app.command(dict(action='review_enter'));r=self.app.review
        with patch.object(Review,'evaluate',ReviewTests.fake):
            self.app.command(dict(action='review_start'));r.thread.join(3)
            previous=r.rows.copy();generation=r.generation
            warning=self.app.command(dict(action='review_start'))
            self.assertIn('review_confirmation',warning);self.assertEqual(r.rows,previous);self.assertEqual(r.generation,generation)
            self.app.command(dict(action='review_start',confirm_review_clear=True));r.thread.join(3)
        r.rows=r.rows[:1];r.points=r.points[:2];r.status='stopped'
        self.app.command(dict(action='insight_time',milliseconds=5000))
        self.assertFalse(r.can_resume());previous=r.rows.copy()
        self.assertIn('review_confirmation',self.app.command(dict(action='review_start')));self.assertEqual(r.rows,previous)

    def test_imports_warn_for_history_even_without_review_results(self):
        original=self.app.analysis;game=original.review_game
        for action in ('load','review_load','open_analysis'):
            with self.subTest(action=action):
                payload=dict(action=action,text='Base')
                warning=self.app.command(payload)
                self.assertIn('history',warning['review_confirmation'])
                self.assertIs(self.app.analysis,original)
                self.assertEqual(self.app.analysis.review_game,game)
        self.app.command(dict(action='navigate',ply=0))
        self.assertIn('review_confirmation',self.app.command(dict(action='load',text='Base')))
        self.app.command(dict(action='mode',mode='play'))
        self.assertIn('review_confirmation',self.app.command(dict(action='open_analysis')))
        result=self.app.command(dict(action='load',text='Base',confirm_review_clear=True))
        self.assertEqual(result['review_total'],0)
        self.assertNotIn('review_confirmation',self.app.command(dict(action='load',text='Base')))

    def test_replacing_analysis_work_warns_even_outside_review(self):
        self.app.command(dict(action='review_enter'));r=self.app.review;r.points=[dict(ply=0,score=0)]
        self.assertTrue(self.app.view()['review_work_available'])
        for payload in [dict(action='load',text='Base'),dict(action='setup_position')]:
            self.assertIn('review_confirmation',self.app.command(payload));self.assertIs(self.app.review,r)
        self.app.command(dict(action='review_exit'))
        for payload in [dict(action='load',text='Base'),dict(action='setup_position'),dict(action='undo'),dict(action='move',move=self.app.session.data['legal'][0]['move'])]:
            self.assertIn('review_confirmation',self.app.command(payload))
        self.app.command(dict(action='mode',mode='play'))
        self.assertIn('review_confirmation',self.app.command(dict(action='open_analysis')))
        # Switching tabs and navigating do not warn or discard any review data.
        self.app.command(dict(action='mode',mode='analysis'));self.app.command(dict(action='navigate',ply=1));self.app.command(dict(action='review_enter'))
        self.assertIs(self.app.review,r)
        self.app.command(dict(action='load',text='Base',confirm_review_clear=True));self.assertEqual(self.app.review.total,0)

    def test_engine_removal_warns_for_retained_review(self):
        self.app.engines.add(dict(id='other',name='Other',path='/test/other',capabilities=[],score_adapter='mzinga'))
        self.app.command(dict(action='engine_select',id='other'));self.app.command(dict(action='review_enter'))
        r=self.app.review;r.points=[dict(ply=0,score=0)]
        self.app.command(dict(action='engine_select',id='Computer'))
        self.app.command(dict(action='engine_toggle',id='other',connected=False))
        self.assertIn('review_confirmation',self.app.command(dict(action='engine_remove',id='other')))
        self.assertIsNotNone(self.app.engines.get('other'))
        self.app.command(dict(action='engine_remove',id='other',confirm_review_clear=True))
        self.assertIsNone(self.app.engines.get('other'));self.assertFalse(any(v is r for v in self.app.saved_reviews.values()))

    def test_retained_reviews_are_not_silently_evicted(self):
        self.app.command(dict(action='review_enter'));r=self.app.review;r.points=[dict(ply=0,score=0)]
        for i in range(10):self.app.saved_reviews[('test',str(i),'path')]=r
        self.app.command(dict(action='review_exit'))
        self.assertEqual(len(self.app.saved_reviews),11)

    def test_classification_and_side_conversion(self):
        self.assertEqual(classify(100,-201),('Blunder','??'))
        self.assertEqual(classify(100,-51),('Mistake','?'))
        self.assertEqual(classify(100,39),('Inaccuracy','?!'))
        self.assertEqual(classify(99995,100),('Missed win','∅'))
        self.assertEqual(classify(0,-99995),('Blunder','??'))
        self.assertEqual(classify(None,0),('Uncertain',''))
        self.assertEqual(white_score(dict(score=100,side=1)),-100)
        self.assertEqual(classify(0,100),('No clear error',''))

if __name__=='__main__':unittest.main()

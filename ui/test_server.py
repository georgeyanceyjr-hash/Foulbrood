import time
import tempfile
import os
from unittest.mock import patch
import unittest
import json
from server import App, Clock, TIMES, ROOT, budget_ms, snapshot


class ClockTests(unittest.TestCase):
    def test_five_controls_and_increment_only_after_completion(self):
        self.assertEqual(list(TIMES),['1+2','3+3','5+4','10+10','20+20'])
        for initial,increment in TIMES.values():
            now=[0.0];c=Clock(initial,increment,lambda:now[0]);c.start(0)
            now[0]=3;self.assertEqual(c.values(),[initial-3,initial])
            self.assertTrue(c.commit());self.assertEqual(c.remaining,[initial-3+increment,initial])
            c.start(1);now[0]+=initial
            self.assertFalse(c.commit());self.assertEqual(c.remaining[1],0)

    def test_pause_resume_and_budget_margin(self):
        now=[0.0];c=Clock(60,2,lambda:now[0]);c.start(0);now[0]=4;c.pause()
        now[0]=100;self.assertEqual(c.values(),[56,60]);c.start(0);now[0]=102
        self.assertEqual(c.values(),[54,60])
        for remain in [0,.01,.1,1,10,60,1200]:
            for inc in [2,3,4,10,20]:self.assertLessEqual(budget_ms(remain,inc)/1000,max(0,remain-.02)+1e-9)


class BoardTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.environment=patch.dict(os.environ,{"FOULBROOD_ENGINES_FILE":self.temp.name+"/engines.json"});self.environment.start();self.app=App()
    def tearDown(self):
        with self.app.lock:self.app.invalidate()
        self.environment.stop();self.temp.cleanup()

    def new(self,players=None):
        return self.app.command(dict(action='new',time='1+2',variant='Base+MLP',players=players or ['Human','Human']))

    def parallel_fixture(self):
        self.new()
        self.app.engines.entries.append(dict(id='opponent',name='Opponent',path='/tmp/other-engine',connected=True,capabilities=['Mosquito','Ladybug','Pillbug']))
        self.app.play.players=['opponent','Human']
        self.app.job='computer'
        from unittest.mock import Mock
        proc=Mock();proc.poll.return_value=None
        self.app.process=proc
        return proc

    def test_other_engine_can_analyze_during_computer_turn(self):
        proc=self.parallel_fixture();revision=self.app.revision;game=self.app.play.data['game']
        view=self.app.command(dict(action='analyze',milliseconds=2000))
        worker=self.app.insight_worker
        self.assertTrue(view['parallel_insight_allowed']);self.assertEqual(view['job'],'computer');self.assertEqual(view['insight_job'],'hint')
        deadline=time.monotonic()+8
        while worker.job and time.monotonic()<deadline:time.sleep(.03)
        self.assertIsNotNone(worker.hint,worker.error)
        self.assertEqual(self.app.view()['hint'],worker.hint)
        self.assertEqual(self.app.play.data['game'],game);self.assertEqual(self.app.revision,revision)
        self.assertIs(self.app.process,proc);proc.terminate.assert_not_called()
        self.app.command(dict(action='stop_analysis'))
        self.assertIsNone(self.app.insight_worker);self.assertIs(self.app.process,proc)
        self.assertIsNotNone(self.app.view()['hint']);proc.terminate.assert_not_called()

    def test_parallel_insight_controls_and_position_cancellation(self):
        proc=self.parallel_fixture()
        self.app.command(dict(action='analyze',milliseconds=2000));worker=self.app.insight_worker
        with self.assertRaisesRegex(ValueError,'Stop analysis'):
            self.app.command(dict(action='insight_time',milliseconds=5000))
        self.assertIs(self.app.insight_worker,worker)
        self.app.command(dict(action='stop_analysis'))
        self.app.command(dict(action='insight_time',milliseconds=5000))
        self.assertIsNone(self.app.insight_worker);self.assertIs(self.app.process,proc)
        self.assertGreater(worker.revision,0);proc.terminate.assert_not_called()
        self.app.command(dict(action='analyze',milliseconds=2000));worker=self.app.insight_worker
        self.app.move('wS1')
        self.assertIsNone(self.app.insight_worker);self.assertIsNone(self.app.hint)
        self.assertGreater(worker.revision,0)
        time.sleep(.1);self.assertIsNone(self.app.hint,'stale worker cannot publish to next position')

    def test_parallel_insight_rejects_same_engine_and_bot_duel(self):
        proc=self.parallel_fixture()
        self.app.engines.analysis_engine='opponent'
        self.assertFalse(self.app.parallel_insight_allowed())
        with self.assertRaises(ValueError):self.app.command(dict(action='analyze'))
        self.app.engines.analysis_engine='Computer'
        self.app.play.players[1]='Computer'
        self.assertFalse(self.app.parallel_insight_allowed())
        proc.terminate.assert_not_called()

    def test_foulbrood_timed_search_publishes_live_thoughts(self):
        self.new(['Computer','Human'])
        with self.app.lock:self.app.launch_search('computer',2000)
        deadline=time.monotonic()+6;saw_live=False
        while time.monotonic()<deadline:
            view=self.app.view()
            if view['job']=='computer' and view['engine_thoughts'][0].get('evaluation'):saw_live=True
            if view['ply']==1:break
            time.sleep(.005)
        self.assertTrue(saw_live,'expected completed-depth report before move is played')
        self.assertEqual(view['ply'],1)
        self.assertEqual(view['engine_thoughts'][0]['status'],'played')

    def test_new_game_rearms_enabled_suggestions_after_stop(self):
        self.new();self.app.hints=True;self.app.hint_paused=True
        self.new()
        self.assertTrue(self.app.hints)
        self.assertFalse(self.app.hint_paused)
        with patch.object(self.app,'launch_search') as launch:
            self.app.tick();launch.assert_called_once_with('hint',self.app.analysis_ms)

    def test_switch_engine_rearms_stopped_suggestions_without_enabling_them(self):
        self.new()
        self.app.engines.entries.append(dict(id='alternate',name='Alternate',path='/tmp/alternate',connected=True))
        for enabled in [True,False]:
            self.app.hints=enabled;self.app.hint_paused=True
            self.app.command(dict(action='engine_select',id='alternate'))
            self.assertFalse(self.app.hint_paused)
            self.assertEqual(self.app.hints,enabled)
            with patch.object(self.app,'launch_search') as launch:
                self.app.tick()
                self.assertEqual(launch.called,enabled)

    def test_opening_is_untimed_until_both_first_moves(self):
        self.new();s=self.app.play;now=[0.];s.clock.now=lambda:now[0]
        now[0]=600
        self.assertEqual(self.app.view()['clocks'],[60,60])
        self.app.command(dict(action='move',move='wS1'))
        self.app.command(dict(action='toggle'));self.app.command(dict(action='toggle'))
        now[0]=1200
        self.assertEqual(self.app.view()['clocks'],[60,60])
        self.app.command(dict(action='move',move='bS1 wS1-'))
        self.assertEqual(s.clock.started,1200)
        now[0]=1207
        self.assertEqual(self.app.view()['clocks'],[53,60])
        self.app.command(dict(action='undo'))
        self.assertEqual(s.data['ply'],1);self.assertIsNone(s.clock.started)
        now[0]=2000
        self.assertEqual(self.app.view()['clocks'],[60,60])

    def test_live_takeback_keeps_clock_running_and_paused_stays_paused(self):
        self.new();self.app.command(dict(action='move',move='wS1'))
        v=self.app.command(dict(action='undo'))
        self.assertTrue(v['running']);self.assertEqual(v['ply'],0)
        self.assertEqual(self.app.play.clock.side,0)
        self.app.command(dict(action='move',move='wS1'))
        self.app.command(dict(action='toggle'))
        self.assertFalse(self.app.command(dict(action='undo'))['running'])

    def test_live_history_is_a_view_and_clock_search_keep_running(self):
        self.new()
        self.app.command(dict(action='move',move='wS1'))
        self.app.command(dict(action='move',move='bS1 wS1-'))
        live=self.app.play.data['game'];revision=self.app.revision
        clock=self.app.play.clock.side
        self.app.job='computer'
        past=self.app.command(dict(action='navigate',ply=1))
        self.assertEqual(past['ply'],1);self.assertTrue(past['reviewing'])
        self.assertEqual(self.app.play.data['game'],live)
        self.assertTrue(self.app.play.running);self.assertEqual(self.app.play.clock.side,clock)
        self.assertEqual(self.app.revision,revision);self.assertEqual(self.app.job,'computer')
        with self.assertRaises(ValueError):self.app.command(dict(action='move',move='wQ /wS1'))
        # Computer completion uses the live board while the displayed past stays fixed.
        self.app.move('wQ /wS1')
        view=self.app.view();self.assertEqual(view['ply'],1);self.assertEqual(view['review_total'],3)
        now=self.app.command(dict(action='navigate',direction='last'))
        self.assertFalse(now['reviewing']);self.assertEqual(now['ply'],3)
        self.assertTrue(now['running'])
        with self.assertRaises(ValueError):self.app.command(dict(action='navigate',ply=4))
        with self.assertRaises(ValueError):self.app.command(dict(action='navigate',ply=True))

    def test_finished_play_review_keeps_result_clock_and_full_export(self):
        self.new()
        self.app.command(dict(action='move',move='wS1'))
        final=self.app.command(dict(action='resign',side=1))
        first=self.app.command(dict(action='navigate',direction='first'))
        self.assertEqual(first['ply'],0)
        self.assertTrue(first['play_finished'])
        self.assertEqual(first['review_total'],1)
        self.assertEqual(first['clocks'],final['clocks'])
        self.assertFalse(self.app.command(dict(action='toggle'))['running'])
        self.assertIn('wS1',self.app.command(dict(action='export',format='pgn'))['text'])
        self.assertEqual(self.app.command(dict(action='navigate',direction='last'))['game'],final['game'])
        self.app.command(dict(action='navigate',direction='first'))
        restored=self.app.command(dict(action='undo'))
        self.assertEqual(restored['game'],final['game'])
        self.assertFalse(restored['play_finished'])

    def test_reported_result_survives_review_but_not_new_variation(self):
        pgn='[GameType "Base"]\n[Result "WhiteWins"]\n1. wS1\n2. bS1 wS1-\nWhiteWins'
        v=self.app.command(dict(action='load',confirm_review_clear=True,text=pgn))
        self.assertEqual(v['reported_result'],'WhiteWins')
        self.assertEqual(v['state'],'InProgress')
        v=self.app.command(dict(action='navigate',ply=1))
        self.assertEqual(v['reported_result'],'WhiteWins')
        v=self.app.command(dict(action='move',move=v['legal'][0]['move']))
        self.assertIsNone(v['reported_result'])
        self.new();self.app.command(dict(action='move',move='wS1'))
        self.app.command(dict(action='resign',side=1))
        v=self.app.command(dict(action='open_analysis',confirm_review_clear=True,ply=0))
        self.assertEqual(v['reported_result'],'WhiteWins')
        self.assertEqual(v['state'],'NotStarted')

    def test_saved_player_names_and_no_stale_names(self):
        text=(ROOT/'ui/fixtures/hivegame.pgn').read_text()
        view=self.app.command(dict(action='load',confirm_review_clear=True,text=text))
        self.assertEqual(view['player_names'],['PlayerWhite','PlayerBlack'])
        self.assertEqual(self.app.command(dict(action='navigate',direction='first'))['player_names'],view['player_names'])
        view=self.app.command(dict(action='load',confirm_review_clear=True,text='Base'))
        self.assertEqual(view['player_names'],[None,None])
        data=json.loads((ROOT/'ui/fixtures/hivegame.json').read_text())
        data['players']={'white':'Alice','black':'Bob'}
        self.assertEqual(self.app.command(dict(action='load',confirm_review_clear=True,text=json.dumps(data)))['player_names'],['Alice','Bob'])

    def test_reset_play_is_empty_paused_and_preserves_analysis(self):
        self.new(['Computer','Human'])
        self.app.play.data=snapshot('play',self.app.play.data['game'],'wS1')
        self.app.command(dict(action='load',text='Base\nwS1'))
        analysis=self.app.analysis.data['game']
        self.app.command(dict(action='mode',mode='play'))
        result=self.app.command(dict(action='reset_play'))
        self.assertEqual(result['ply'],0);self.assertFalse(result['running'])
        self.assertEqual(result['clocks'],[60,60]);self.assertEqual(result['players'],['Computer','Human'])
        self.app.tick();self.assertIsNone(self.app.job)
        self.assertEqual(self.app.analysis.data['game'],analysis)

    def test_same_insight_controls_in_both_modes(self):
        from unittest.mock import patch
        self.new()
        for mode in ['play','analysis']:
            self.app.command(dict(action='mode',mode=mode))
            with patch.object(self.app,'launch_search') as launch:
                self.app.command(dict(action='hints',enabled=True,milliseconds=5000))
                self.app.tick();launch.assert_called_with('hint',5000)
                self.app.command(dict(action='stop_analysis'));launch.reset_mock()
                self.app.tick();launch.assert_not_called()
                self.app.command(dict(action='analyze',milliseconds=0));launch.assert_called_with('hint',0)
                self.app.command(dict(action='hints',enabled=False));launch.reset_mock()
                self.app.tick();launch.assert_not_called();self.assertIsNone(self.app.hint)

    def test_insight_off_does_not_cancel_computer_turn(self):
        self.new(['Computer','Human']);self.app.launch_search('computer',5000)
        proc=self.app.process
        self.app.command(dict(action='hints',enabled=False))
        self.assertIs(self.app.process,proc);self.assertEqual(self.app.job,'computer')

    def test_move_and_unconditional_takeback_restore_clock(self):
        self.new();self.app.move('wS1');self.app.move('bS1 wS1-');s=self.app.session;now=[0.0];s.clock.now=lambda:now[0];s.clock.started=0
        move=s.data['legal'][0]['move'];now[0]=7
        self.app.command(dict(action='move',move=move))
        self.assertEqual(s.clock.remaining,[55,60]);self.assertEqual(s.data['side'],1)
        s.players=['Computer','Computer']
        self.app.command(dict(action='undo'))
        self.assertEqual(s.data['ply'],2);self.assertEqual(s.clock.remaining,[60,60]);self.assertTrue(s.running)

    def test_timeout_never_grants_increment_or_plays_move(self):
        self.new();self.app.move('wS1');self.app.move('bS1 wS1-');s=self.app.session;now=[0.0];s.clock.now=lambda:now[0];s.clock.started=0
        move=s.data['legal'][0]['move'];now[0]=61
        self.app.command(dict(action='move',move=move))
        self.assertEqual(s.timeout_side,0);self.assertEqual(s.data['ply'],2)
        self.assertEqual(s.clock.remaining[0],0);self.assertFalse(s.running)

    def test_analysis_is_separate_and_bad_input_preserves_position(self):
        self.new();original=self.app.play.data['game']
        self.app.command(dict(action='load',confirm_review_clear=True,text='Base\nwS1\nbS1 wS1-',variant='Base'))
        self.assertEqual(self.app.session.data['ply'],2)
        with self.assertRaises(ValueError):self.app.command(dict(action='load',confirm_review_clear=True,text='Base\nwQ'))
        self.assertEqual(self.app.session.data['ply'],2)
        self.app.command(dict(action='undo'));self.assertEqual(self.app.session.data['ply'],1)
        self.app.command(dict(action='mode',mode='play'))
        self.assertEqual(self.app.play.data['game'],original);self.assertFalse(self.app.play.running)

    def test_time_change_requires_stop_and_does_not_restart_analysis(self):
        self.app.job='hint';old=self.app.analysis_ms;revision=self.app.revision
        with self.assertRaisesRegex(ValueError,'Stop analysis'):
            self.app.command(dict(action='insight_time',milliseconds=5000))
        self.assertEqual(self.app.analysis_ms,old);self.assertEqual(self.app.revision,revision)
        self.app.command(dict(action='stop_analysis'))
        self.app.command(dict(action='insight_time',milliseconds=5000))
        self.assertEqual(self.app.analysis_ms,5000);self.assertTrue(self.app.hint_paused)
        with patch.object(self.app,'launch_search') as launch:self.app.tick();launch.assert_not_called()

    def test_analysis_times_and_play_only_matching(self):
        self.assertEqual(self.app.analysis_ms,-1)
        self.app.play.clock.remaining=[60,300]
        self.assertEqual(self.app.analysis_budget_ms(),budget_ms(60,4))
        self.app.play.data['side']=1
        self.assertEqual(self.app.analysis_budget_ms(),budget_ms(300,4))
        self.app.command(dict(action='mode',mode='analysis'))
        self.assertEqual(self.app.analysis_ms,60000)
        with self.assertRaisesRegex(ValueError,'only on Play'):
            self.app.command(dict(action='insight_time',milliseconds=-1))
        for ms in [600000,3600000,86400000]:
            self.app.command(dict(action='insight_time',milliseconds=ms))
            with patch.object(self.app,'launch_search') as launch:
                self.app.command(dict(action='analyze',milliseconds=ms))
                launch.assert_called_once_with('hint',ms)
        self.app.command(dict(action='mode',mode='play'))
        self.assertEqual(self.app.analysis_ms,-1)
        self.app.command(dict(action='mode',mode='analysis'))
        self.assertEqual(self.app.analysis_ms,86400000)
        self.app.command(dict(action='review_enter'))
        with self.assertRaisesRegex(ValueError,'only on Play'):
            self.app.command(dict(action='insight_time',milliseconds=-1))
        self.assertEqual(self.app.analysis_ms,86400000)

    def test_matching_resolves_before_external_search(self):
        self.app.engines.entries.append(dict(id='external',name='External',connected=True,path='/test',capabilities=[]))
        self.app.engines.analysis_engine='external'
        with patch.object(self.app,'launch_external') as launch:
            self.app.launch_search('hint',-1)
            launch.assert_called_once_with(self.app.analysis_budget_ms(),'hint','external')

    def test_analysis_half_second_upgrades_to_two_seconds(self):
        self.app.command(dict(action='insight_time',milliseconds=500))
        self.assertEqual(self.app.analysis_ms,2000)

    def test_computer_thoughts_follow_search_and_stop(self):
        self.new(['Computer','Computer']);self.app.book_enabled=False
        self.app.launch_search('computer',5000)
        thought=self.app.view()['engine_thoughts'][0]
        self.assertEqual(thought['engine'],'FoulBrood');self.assertEqual(thought['status'],'thinking')
        self.assertEqual(thought['ply'],1);self.assertGreaterEqual(thought['elapsed'],0)
        proc=self.app.process
        self.app.command(dict(action='insight_time',milliseconds=2000))
        self.assertIs(self.app.process,proc)
        self.app.engines.add(dict(id='alternate',name='Other engine',path='/test/other',capabilities=[]))
        self.app.command(dict(action='engine_select',id='alternate'))
        self.assertIs(self.app.process,proc)
        self.app.pause();self.assertEqual(self.app.view()['engine_thoughts'][0]['status'],'stopped')

    def test_takeback_cancels_search_and_discards_stale_move(self):
        self.new(['Human','Computer']);self.app.book_enabled=False;self.app.command(dict(action='move',move='wS1'))
        self.app.launch_search('computer',5000);proc=self.app.process
        self.app.command(dict(action='undo'));time.sleep(.15)
        self.assertIsNotNone(proc.poll());self.assertEqual(self.app.session.data['ply'],0)
        self.assertTrue(self.app.session.running);self.assertIsNone(self.app.job)

    def test_hint_does_not_play_and_can_be_disabled(self):
        self.new();self.app.hints=True;self.app.launch_search('hint',50)
        deadline=time.monotonic()+3
        while self.app.job and time.monotonic()<deadline:time.sleep(.02)
        self.assertIsNotNone(self.app.hint);self.assertEqual(self.app.session.data['ply'],0)
        self.app.command(dict(action='hints',enabled=False));self.assertIsNone(self.app.hint)

    def test_computer_moves_both_colors(self):
        self.new(['Computer','Computer'])
        self.app.session.clock.remaining=[1,1]
        self.app.session.clock.increment=0
        for ply in [1,2]:
            self.app.tick()
            deadline=time.monotonic()+3
            while self.app.job and time.monotonic()<deadline:time.sleep(.02)
            self.assertEqual(self.app.session.data['ply'],ply)

    def test_terminal_draw_disables_moves_and_allows_takeback(self):
        games=json.loads((ROOT/'docs/mzinga-strength-2026-09-11/matches-500.json').read_text())['games']
        draw=next(g['final'] for g in games if g['outcome']=='draw')
        result=self.app.command(dict(action='load',text=draw))
        self.assertEqual(result['state'],'Draw');self.assertEqual(result['legal'],[])
        self.app.command(dict(action='undo'))
        self.assertEqual(self.app.session.data['state'],'InProgress')

    def test_resign_cancels_computer_and_takeback_restores_position(self):
        self.new(['Human','Computer']);self.app.command(dict(action='move',move='wS1'))
        before=self.app.session.data['game'];self.app.launch_search('computer',5000)
        proc=self.app.process
        result=self.app.command(dict(action='resign',side=0));time.sleep(.1)
        self.assertEqual(result['resigned_side'],0);self.assertFalse(result['running'])
        self.assertIsNotNone(proc.poll());self.app.tick()
        self.assertEqual(self.app.session.data['game'],before)
        self.app.command(dict(action='toggle'));self.assertFalse(self.app.session.running)
        self.app.command(dict(action='undo'))
        self.assertIsNone(self.app.session.resigned_side);self.assertEqual(self.app.session.data['game'],before)
        self.assertFalse(self.app.session.running)

    def test_stack_last_move_import_and_undo(self):
        moves=['Base+MLP','wL',r'bP \wL','wQ /wL','bQ bP/','wB1 wL-',r'bM \bP','wB1 wL']
        self.app.command(dict(action='load',text='\n'.join(moves)))
        data=self.app.session.data
        last=data['last_move']
        self.assertEqual(last['piece'],'wB1')
        self.assertIsNotNone(last['from'])
        self.assertNotEqual(last['from'],last['to'])
        stack=sorted((p for p in data['pieces'] if [p['q'],p['r']]==last['to']),key=lambda p:p['level'])
        self.assertEqual([(p['id'],p['level']) for p in stack],[('wL',0),('wB1',1)])
        self.assertEqual(snapshot('snapshot',data['game'])['last_move'],last)
        self.app.command(dict(action='undo'))
        self.assertEqual(self.app.session.data['last_move']['piece'],'bM')
        self.assertTrue(all(p['level']==0 for p in self.app.session.data['pieces']))

    def test_continuous_analysis_progress_stop_and_position_change(self):
        self.app.command(dict(action='load',text='Base+MLP\nwL\nbS1 -wL\nwQ wL/\nbM \\bS1\nwB1 wL\\\nbQ -bS1\nwB1 wL'))
        original=self.app.session.data['game']
        self.app.command(dict(action='analyze',milliseconds=0));proc=self.app.process
        deadline=time.monotonic()+5
        while (not self.app.hint or self.app.hint['depth']<2) and time.monotonic()<deadline:time.sleep(.02)
        self.assertIsNotNone(self.app.hint)
        self.assertGreaterEqual(self.app.hint['depth'],2)
        self.assertIn(self.app.hint['move'],[m['move'] for m in self.app.session.data['legal']])
        stopped=self.app.command(dict(action='stop_analysis'))
        self.assertIsNone(stopped['job']);self.assertIsNotNone(stopped['hint'])
        proc.wait(timeout=2);time.sleep(.05)
        self.assertEqual(self.app.hint,stopped['hint'])
        self.assertEqual(self.app.session.data['game'],original)
        self.app.command(dict(action='analyze',milliseconds=0));proc=self.app.process
        self.app.command(dict(action='undo'));proc.wait(timeout=2);time.sleep(.05)
        self.assertIsNone(self.app.hint);self.assertIsNone(self.app.job)

    def test_play_continuous_hint_restarts_after_move(self):
        self.new()
        self.app.command(dict(action='continuous_hints',enabled=True));self.app.tick()
        proc=self.app.process
        deadline=time.monotonic()+3
        while not self.app.hint and time.monotonic()<deadline:time.sleep(.02)
        self.assertIsNotNone(self.app.hint);self.assertEqual(self.app.job,'hint')
        self.app.command(dict(action='move',move=self.app.hint['move']))
        proc.wait(timeout=2);self.assertIsNone(self.app.hint)
        self.app.tick();self.assertEqual(self.app.job,'hint')
        self.assertIsNot(self.app.process,proc)
        self.app.command(dict(action='hints',enabled=False));self.app.tick()
        self.assertIsNone(self.app.job)

    def test_infinite_analysis_survives_idle_browser_and_reports_activity(self):
        self.app.command(dict(action='mode',mode='analysis'))
        self.app.command(dict(action='analyze',milliseconds=0))
        proc=self.app.process
        self.app.last_seen=time.monotonic()-60
        self.app.tick()
        self.assertIs(self.app.process,proc)
        self.assertIsNone(proc.poll())
        view=self.app.view()
        self.assertEqual(view['job'],'hint')
        self.assertGreaterEqual(view['search_elapsed'],0)
        self.assertFalse(view['search_finished'])
        self.app.command(dict(action='stop_analysis'))
        proc.wait(timeout=2)
        self.assertIsNone(self.app.view()['search_elapsed'])

    def test_continuous_hints_yield_to_computer_and_disconnect(self):
        self.new(['Human','Computer'])
        self.app.command(dict(action='continuous_hints',enabled=True));self.app.tick()
        self.app.command(dict(action='move',move='wS1'));self.app.tick()
        self.assertEqual(self.app.job,'computer')
        self.app.last_seen=time.monotonic()-20;self.app.tick()
        self.assertIsNone(self.app.job);self.assertFalse(self.app.session.running)
        self.app.tick();self.assertIsNone(self.app.job)

    def test_experimental_book_hint_and_calculate_override(self):
        from opening_book import OpeningBook
        self.app.command(dict(action='mode',mode='analysis'))
        game=self.app.session.data['game'];move=self.app.session.data['legal'][0]['move']
        self.app.book.data={'entries':{game:dict(move=move,depth=10,score=0)}}
        self.app.command(dict(action='book_enabled',enabled=True))
        self.app.command(dict(action='hints',enabled=True));self.app.tick()
        self.assertEqual(self.app.view()['hint']['source'],'book')
        self.assertIsNone(self.app.process)
        self.app.command(dict(action='calculate_instead'))
        self.assertEqual(self.app.book_bypass_game,game)
        self.assertIsNotNone(self.app.process)
        self.app.command(dict(action='stop_analysis'))
        self.assertIsNone(self.app.book.lookup(game,['not a legal move']))

    def test_open_analysis_carries_full_history_at_selected_move(self):
        self.new(['Human','Human'])
        for _ in range(4):
            move=self.app.session.data['legal'][0]['move']
            self.app.command(dict(action='move',move=move))
        full=self.app.session.review_game
        self.app.play.player_names=['Alice','Bob']
        selected=self.app.command(dict(action='navigate',ply=2))['game']
        view=self.app.command(dict(action='open_analysis',ply=2))
        self.assertEqual(view['mode'],'analysis')
        self.assertEqual(view['game'],selected)
        self.assertEqual(view['review_game'],full)
        self.assertEqual(view['review_total'],4)
        self.assertEqual(view['player_names'],['Alice','Bob'])
        self.assertEqual(self.app.command(dict(action='navigate',direction='last'))['game'],full)
        self.assertEqual(self.app.play.data['game'],full)
        self.assertFalse(self.app.play.running)

    def test_analysis_navigation_preserves_forward_history_and_cancels_search(self):
        self.new();play=self.app.play.data['game']
        self.app.command(dict(action='load',text='Base\nwS1\nbS1 wS1-\nwQ /wS1'))
        final=self.app.session.data['game']
        self.app.command(dict(action='analyze',milliseconds=0));proc=self.app.process
        first=self.app.command(dict(action='navigate',direction='first'))
        proc.wait(timeout=2)
        self.assertEqual(first['ply'],0);self.assertEqual(first['review_total'],3)
        self.assertIsNone(first['hint']);self.assertIsNone(first['job'])
        self.assertEqual(self.app.command(dict(action='navigate',direction='next'))['ply'],1)
        self.assertEqual(self.app.command(dict(action='navigate',direction='last'))['game'],final)
        self.assertEqual(self.app.command(dict(action='navigate',direction='previous'))['ply'],2)
        self.assertEqual(self.app.command(dict(action='navigate',direction='next'))['game'],final)
        self.app.command(dict(action='mode',mode='play'));self.assertEqual(self.app.play.data['game'],play)

    def test_only_humans_resign_and_either_human_may_resign(self):
        self.new(['Human','Computer'])
        with self.assertRaises(ValueError):self.app.command(dict(action='resign',side=1))
        self.new();self.app.command(dict(action='resign',side=1))
        self.assertEqual(self.app.session.resigned_side,1)
        with self.assertRaises(ValueError):self.app.command(dict(action='resign',side=0))


if __name__=='__main__':unittest.main()

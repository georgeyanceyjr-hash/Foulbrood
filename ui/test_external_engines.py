import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from external_engines import UHP,EngineLibrary,inspect_engine,parse_score,foulbrood_entry,discover_engines,exact_score_lines
from server import App

class ExternalTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.env=patch.dict(os.environ,{'FOULBROOD_ENGINES_FILE':str(self.root/'engines.json'),'FOULBROOD_ENGINE_CACHE':str(self.root/'cache')});self.env.start()
        self.program=self.root/'test engine'
        self.program.write_text('''#!/usr/bin/python3
import sys
print('id Test Hive Engine',flush=True)
print('Mosquito;Ladybug;Pillbug',flush=True)
print('ok',flush=True)
for line in sys.stdin:
 if line.startswith('newgame'):print('Base;NotStarted;White[1]')
 elif line.startswith('validmoves'):print('wS1;wA1')
 elif line.startswith('bestmove'):print('wS1')
 print('ok',flush=True)
''');self.program.chmod(0o755)
    def tearDown(self):self.env.stop();self.tmp.cleanup()
    def test_foulbrood_reconnect_restores_review_support(self):
        app=App()
        entry=dict(id='uhp:report',name='FoulBrood',path=str(self.program),score_adapter=None,capabilities=[])
        try:
            app.command(dict(action='engine_add',entry=entry))
            checked=dict(entry,score_adapter='foulbrood',score_format_check='matched')
            app.command(dict(action='engine_toggle',id=entry['id'],connected=True,checked_entry=checked))
            self.assertTrue(app.engines.get(entry['id'])['review_supported'])
        finally:app.invalidate()
    def test_discovery_does_not_run_programs_and_deduplicates(self):
        marker=self.root/'executed'
        program=self.root/'MzingaEngine'
        program.write_text('#!/bin/sh\ntouch "'+str(marker)+'"\n');program.chmod(0o755)
        (self.root/'nokamute').write_text('not executable')
        hidden=self.root/'.hidden';hidden.mkdir();(hidden/'foulbrood').write_text('ignored')
        result=discover_engines([self.root,self.root])
        self.assertEqual(result['candidates'],[dict(name='Mzinga',path=str(program.resolve()))])
        self.assertFalse(marker.exists());self.assertFalse(result['limited'])
        self.assertTrue(discover_engines([self.root],max_files=0)['limited'])
        self.assertTrue(discover_engines([self.root],seconds=0)['limited'])

    def test_discovery_checks_shared_engine_folder_before_large_downloads(self):
        home=self.root/'home'
        engine=home/'Documents/FoulBroodData/Engines/Nokamute/nokamute'
        engine.parent.mkdir(parents=True);engine.write_text('not executed');engine.chmod(0o755)
        downloads=home/'Downloads';downloads.mkdir()
        for n in range(5):(downloads/str(n)).write_text('noise')
        with patch('external_engines.Path.home',return_value=home),patch.dict(os.environ,{'FOULBROOD_DATA_DIR':str(home/'beta-data')}):
            result=discover_engines(max_files=2)
        self.assertTrue(result['limited'])
        self.assertIn(dict(name='Nokamute',path=str(engine.resolve())),result['candidates'])

    def test_probe_and_persistence(self):
        entry=inspect_engine(str(self.program));lib=EngineLibrary();lib.add(entry)
        self.assertEqual(entry['name'],'Test Hive Engine');self.assertEqual(len(entry['capabilities']),3)
        key=entry['id'];lib.add(inspect_engine(str(self.program)));self.assertEqual(len([e for e in lib.entries if e['id']!='Computer']),1);self.assertEqual(lib.get(key)['id'],key)
        self.assertTrue(EngineLibrary().connected(key));lib.remove(key);self.assertIsNone(EngineLibrary().get(key))
    def score_program(self,format):
        source="""#!/usr/bin/python3
import sys
mode=FORMAT
black=False
print('id Unfamiliar engine',flush=True)
print('ok',flush=True)
for line in sys.stdin:
 line=line.strip()
 if line.startswith('newgame'):
  black='Black[1]' in line
  print('Base;InProgress;Black[1];wS1' if black else 'Base;NotStarted;White[1]')
 move='bS1 -wS1' if black else 'wS1'
 if line=='validmoves':print(move)
 if line.startswith('bestmove'):
  if mode in ('mzinga','both') and not (mode=='white_only' and black):print(move+';4;12.50;'+move)
  if mode in ('nokamute','both'):print('Iterative fullsearch depth 4 took 0ms; value 12; bestmove='+move,file=sys.stderr,flush=True)
  if mode=='near':print(move+';depth=4;12.50')
  if mode=='white_only' and not black:print(move+';4;12.50;'+move)
  print(move)
 print('ok',flush=True)
""".replace('FORMAT',repr(format))
        self.program.write_text(source);self.program.chmod(0o755)

    def test_unknown_engine_detects_only_exact_unique_format(self):
        for adapter in ('mzinga','nokamute'):
            with self.subTest(adapter=adapter):
                self.score_program(adapter);entry=inspect_engine(str(self.program))
                self.assertEqual(entry['score_adapter'],adapter);self.assertEqual(entry['score_format_check'],'matched')
                lib=EngineLibrary();saved=lib.add(entry)
                self.assertTrue(EngineLibrary().get(saved['id'])['review_supported'])
        for format,status in [('near','unsupported'),('white_only','unsupported'),('both','ambiguous')]:
            with self.subTest(format=format):
                self.score_program(format);entry=inspect_engine(str(self.program))
                self.assertIsNone(entry['score_adapter']);self.assertEqual(entry['score_format_check'],status)
                self.assertFalse(EngineLibrary().add(entry)['review_supported'])

    def test_near_match_scores_are_not_parsed(self):
        for line in ['wS1;4;12.5','wS1;4;NaN','prefix wS1;4;12.50','wS1;4;12.50;garbage','wS1;4;12.50;wA1 -bS1/']:
            self.assertFalse(exact_score_lines('mzinga',[line],[],'wS1'))
            self.assertEqual(parse_score('mzinga',[line],[],0,'wS1'),{})
        self.assertEqual(parse_score('nokamute',[],['Iterative fullsearch depth 4 bogus; value 12; bestmove=wS1'],0,'wS1'),{})

    def test_non_executable_rejected(self):
        self.program.chmod(0o644)
        with self.assertRaises(ValueError):inspect_engine(str(self.program))
    def test_missing_capabilities(self):
        lib=EngineLibrary();entry=inspect_engine(str(self.program));entry['capabilities']=[];lib.add(entry)
        lib.check_variant(entry['id'],'Base')
        with self.assertRaises(ValueError):lib.check_variant(entry['id'],'Base+MLP')
    def test_play_external_then_disconnect(self):
        app=App();entry=inspect_engine(str(self.program));app.engines.add(entry)
        try:
            app.command(dict(action='new',time='1+2',variant='Base',players=[entry['id'],'Human']));app.tick()
            deadline=time.monotonic()+3
            while app.job and time.monotonic()<deadline:time.sleep(.01)
            app.view() # Wait for the worker's atomic completion, not merely job=None.
            self.assertEqual(app.play.data['ply'],1);self.assertEqual(app.play.data['pieces'][0]['id'],'wS1')
            app.command(dict(action='engine_toggle',id=entry['id'],connected=False));self.assertFalse(app.play.running);self.assertEqual(app.play.players,['Human','Human'])
            with self.assertRaises(ValueError):app.command(dict(action='new',time='1+2',variant='Base',players=[entry['id'],'Human']))
        finally:app.invalidate()
    def test_no_builtin_no_search(self):
        app=App()
        try:
            app.command(dict(action='engine_toggle',id='Computer',connected=False));self.assertEqual(app.play.players,['Human','Human'])
            app.hints=True
            with patch.object(__import__('server').subprocess,'Popen') as spawn:app.launch_search('hint',500);spawn.assert_not_called()
            with self.assertRaises(ValueError):app.command(dict(action='analyze'))
            self.assertFalse(App().engines.builtin_connected)
        finally:app.invalidate()
    def test_insight_selection_and_fallback(self):
        app=App();entry=inspect_engine(str(self.program));app.engines.add(entry)
        try:
            app.command(dict(action='engine_select',id=entry['id']))
            app.command(dict(action='insight_time',milliseconds=0));self.assertEqual(app.analysis_ms,60000)
            app.launch_search('hint',500);deadline=time.monotonic()+3
            while app.job and time.monotonic()<deadline:time.sleep(.01)
            self.assertEqual(app.hint['move'],'wS1');self.assertIsNone(app.hint['score']);self.assertEqual(app.hint['engine'],entry['name'])
            self.assertEqual(app.play.data['ply'],0)
            app.command(dict(action='engine_toggle',id=entry['id'],connected=False));self.assertEqual(app.engines.analysis_engine,'Computer');self.assertIsNone(app.hint)
        finally:app.invalidate()

    def test_score_perspective_and_forced_results(self):
        rows=['wS1;4;12.50;wS1;bS1 wS1-', 'wS1']
        self.assertEqual(parse_score('mzinga',rows,[],0,'wS1')['engine_score'],12.5)
        self.assertEqual(parse_score('mzinga',rows,[],1,'wS1')['engine_score'],-12.5)
        self.assertEqual(parse_score('mzinga',['bS1;5;Infinity'],[],1,'bS1')['engine_forced_winner'],'Black')
        self.assertEqual(parse_score('mzinga',['wS1;0;12','wS1;4;NaN'],[],0,'wS1'),{})
        self.assertEqual(parse_score('mzinga',rows,[],0,'wA1'),{})
    def test_nokamute_diagnostics(self):
        rows=['Iterative fullsearch depth 4 took 20ms; value   -32; bestmove=wS1','random logging value 999']
        self.assertEqual(parse_score('nokamute',[],rows,1,'wS1')['engine_score'],32)
        rows+=['Parallel (threads=1) depth= 5, took=  80ms; returned  ∞; bestmove wS1; MBF=3']
        self.assertEqual(parse_score('nokamute',[],rows,0,'wS1')['engine_forced_winner'],'White')
        self.assertEqual(parse_score(None,[],rows,0,'wS1'),{})
        self.assertEqual(parse_score('nokamute',[],rows,0,'wA1'),{})

    def test_remove_and_restore_builtin(self):
        app=App()
        app.command(dict(action='engine_toggle',id='Computer',connected=False))
        app.command(dict(action='engine_remove',id='Computer'))
        saved=EngineLibrary();self.assertFalse(saved.builtin_present);self.assertFalse(saved.builtin_connected)
        self.assertIsNone(saved.analysis_engine)
        app.command(dict(action='engine_add',entry=foulbrood_entry()));self.assertTrue(app.engines.builtin_present);self.assertTrue(app.engines.connected('Computer'));self.assertEqual(app.engines.analysis_engine,'Computer')
        app.invalidate()

    def test_protocol_errors(self):
        self.program.write_text("#!/usr/bin/python3\nprint('id Bad',flush=True)\nprint('err unsupported',flush=True)\nprint('ok',flush=True)\n")
        with self.assertRaises(ValueError):inspect_engine(str(self.program))
    def test_hung_protocol_deadline(self):
        self.program.write_text('#!/usr/bin/python3\nimport time\ntime.sleep(10)\n');engine=UHP(str(self.program))
        try:
            with self.assertRaises(ValueError):engine.reply(.05)
        finally:engine.close()
        self.assertIsNotNone(engine.proc.poll())

if __name__=='__main__':unittest.main()

class EngineFreeDistributionTests(unittest.TestCase):
    def test_missing_foulbrood_does_not_create_an_engine(self):
        with tempfile.TemporaryDirectory() as folder:
            entry=foulbrood_entry();entry['path']=str(Path(folder)/'missing-engine')
            with patch('external_engines.foulbrood_entry',return_value=entry):
                library=EngineLibrary(Path(folder)/'engines.json')
                self.assertEqual(library.entries,[])
                self.assertIsNone(library.analysis_engine)

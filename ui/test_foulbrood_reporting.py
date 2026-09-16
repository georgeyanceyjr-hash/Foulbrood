import unittest,tempfile,json
from pathlib import Path
from external_engines import parse_score,exact_score_lines,review_score,EngineLibrary
class FoulBroodReportingTests(unittest.TestCase):
 def test_native_units_and_perspective(self):
  line='FoulBroodScore v1;depth=7;score=99995;move=bS1 wS1-'
  r=parse_score('foulbrood',[],[line],1,'bS1 wS1-')
  self.assertEqual((r['score'],r['engine_score'],r['source']),(99995,-99995,'foulbrood'))
  self.assertEqual(review_score(r,'foulbrood'),-99995)
 def test_exact_format_and_move_required(self):
  good='FoulBroodScore v1;depth=2;score=-12;move=wS1'
  self.assertTrue(exact_score_lines('foulbrood',[],[good],'wS1'))
  for bad in [good+' extra',good.replace('v1','v2'),good.replace('depth=2','depth=0'),good.replace('score=-12','score=NaN'),good.replace('wS1','wA1')]:
   self.assertFalse(parse_score('foulbrood',[],[bad],0,'wS1'))
 def test_support_survives_library_reload(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'engines.json';p.write_text(json.dumps(dict(version=2,entries=[dict(id='uhp:test',path='/tmp/engine',name='FoulBrood',score_adapter='foulbrood')],analysis_engine='uhp:test')))
   self.assertTrue(EngineLibrary(p).get('uhp:test')['review_supported'])

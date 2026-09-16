import unittest
from notation import translate_history

class NotationTests(unittest.TestCase):
    def test_exact_supplied_translator_forms_and_preserved_traditional(self):
        texts=['wA1','bB1 wA1-','wB1 /wA1','bQ bB1-']
        game='Base;InProgress;White[3];'+';'.join(texts)
        rows=translate_history(game)
        self.assertEqual([r['traditional'] for r in rows],texts)
        self.assertEqual(rows[0]['analytic'],'wA')
        self.assertEqual(rows[1]['analytic'],'bB @ wA')
        self.assertEqual([r['number'] for r in rows],[1,2,3,4])

    def test_unresolved_move_is_explicit_and_history_not_lost(self):
        rows=translate_history('Base;InProgress;White[2];wS1;pass')
        self.assertEqual(len(rows),2)
        self.assertEqual(rows[0]['analytic'],'wS')
        self.assertIsNone(rows[1]['analytic']);self.assertTrue(rows[1]['error'])
        self.assertEqual(rows[1]['traditional'],'pass')

    def test_empty_history(self):self.assertEqual(translate_history('Base;NotStarted;White[1]'),[])

if __name__=='__main__':unittest.main()

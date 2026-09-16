import copy,unittest
from analytic import Analytic,Form,PieceDesc,transform,parse_form
from server import snapshot
from notation import translate_history

class AnalyticTests(unittest.TestCase):
    def last(self,frame,move):
        p=next((p for p in frame['pieces'] if p['id']==move['piece']),None)
        return None if move['piece'] is None else dict(piece=move['piece'],actor=move['actor'],to=move['to'],**{'from':None if not p else [p['q'],p['r']]})

    def test_opening_O_means_symmetry_break_not_axis_move(self):
        game='Base;InProgress;White[3];wA1;bB1 wA1-;wB1 /wA1;bQ bB1-'
        rows=translate_history(game)
        self.assertEqual(rows[2]['analytic'],'wB @ wA [O]')
        frame=snapshot('snapshot','Base;InProgress;White[2];wA1;bB1 wA1-');t=Analytic(frame)
        f=Form('spawn',PieceDesc('wB'),None,(PieceDesc('wA'),),('O',None))
        choices=t.resolve(f)
        self.assertEqual(len(choices),2)
        self.assertEqual(len({t.orbit(a) for a in choices}),1)
        self.assertNotIn((-1,0),[a.dest for a in choices])

    def test_O_can_return_in_later_symmetric_position(self):
        frame=snapshot('snapshot','Base~1~20~wQ:0:0:0,bQ:1:0:0~')
        move=next(m for m in frame['legal'] if m['piece']=='bB1' and m['to']==[2,-1])
        t=Analytic(frame);self.assertIn('[O]',t.translate(self.last(frame,move)))
        # The same shape with an asymmetric extra piece has no symmetry shortcut.
        frame=snapshot('snapshot','Base~1~20~wQ:0:0:0,bQ:1:0:0,wA1:-1:1:0~')
        t=Analytic(frame)
        f=Form('spawn',PieceDesc('bB'),None,(PieceDesc('bQ'),),('O',None))
        self.assertFalse(t.resolve(f))

    def test_engine_legal_pass_and_setup_history(self):
        root='Base+MLP~0~20~wQ:0:0:0,bB1:0:0:1,bQ:1:0:0~'
        before=snapshot('snapshot',root);self.assertEqual([m['move'] for m in before['legal']],['pass'])
        after=snapshot('play',before['game'],'pass');rows=translate_history(after['game'])
        self.assertEqual(rows[0]['analytic'],'pass');self.assertIsNone(rows[0]['error'])

    def test_written_forms_are_independently_readable(self):
        for text in ['wA', 'bB @ wA', 'wB @ wA [O]', 'wB(↓wQ) ↑ bB', 'wA(wQ) → bB[N:wQ] [F:bA(wP)]', 'wMᴾ: bA → wQ']:
            with self.subTest(text=text):self.assertEqual(parse_form(text).text(),text)
        for text in ['wA1 → bQ','wA(wQ1) → bQ','wA → bQ [O] junk']:
            with self.assertRaises(ValueError):parse_form(text)

    def test_stacks_and_pillbug_actions(self):
        root='Base+MLP~0~10~wQ:0:0:0,bQ:1:0:0,wP:0:-1:0,bP:-1:1:0,wA1:-1:0:0,bA1:-1:-1:0,wB1:0:0:1,wB2:1:0:1~'
        frame=snapshot('snapshot',root);t=Analytic(frame)
        samples=[m for m in frame['legal'] if m['actor'] or m['piece'] in ('wB1','wB2')]
        self.assertTrue(any(m['actor'] for m in samples))
        for move in samples:
            with self.subTest(move=move['move']):
                text=t.translate(self.last(frame,move));self.assertNotRegex(text,r'[wb][ABGS][123]')
                if move['actor']:self.assertIn(': ',text)

if __name__=='__main__':unittest.main()

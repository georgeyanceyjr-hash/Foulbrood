import json
import unittest
from pathlib import Path
from unittest.mock import patch
from hivegame import game_url, pgn_from_page, fetch_game
from import_game import read_export, player_names

ID='Example12345'

def page(data):
    return '<script>__RESOLVED_RESOURCES[2] = '+json.dumps(json.dumps(data))+';</script>'

def game():
    variant,moves,_=read_export(Path(__file__).with_name('hivegame_fixture.pgn').read_text())
    return dict(game_id=ID,finished=True,turn=len(moves),game_type=variant,
                history=[(m.split(' ',1)+[''])[:2] for m in moves],
                game_status={'Finished':{'Winner':'White'}},
                white_player={'username':'PlayerWhite'},black_player={'username':'PlayerBlack'})

class HivegameTests(unittest.TestCase):
    def test_link_and_export(self):
        url,ident=game_url(' https://hivegame.com/game/'+ID+'?turn=5#history ')
        self.assertEqual((url,ident),('https://hivegame.com/game/'+ID,ID))
        text=pgn_from_page(page(game()),ID)
        self.assertEqual(len(read_export(text)[1]),33)
        self.assertEqual(player_names(text),['PlayerWhite','PlayerBlack'])
        from server import App
        view=App().command({'action':'load','text':text})
        self.assertEqual((view['ply'],view['state']),(33,'WhiteWins'))
    def test_reject_other_hosts_and_paths_before_network(self):
        with patch('hivegame.build_opener') as opener:
            for u in ['http://hivegame.com/game/'+ID,'https://evil.test/game/'+ID,
                      'https://hivegame.com.evil.test/game/'+ID,'https://hivegame.com:444/game/'+ID,
                      'https://user@hivegame.com/game/'+ID,'https://hivegame.com/game/../admin',
                      'https://hivegame.com/profile/PlayerWhite','file:///tmp/game']:
                with self.assertRaises(ValueError):fetch_game(u)
            opener.assert_not_called()
    def test_unfinished_mismatched_and_incomplete(self):
        d=game();d['finished']=False
        with self.assertRaisesRegex(ValueError,'still in progress'):pgn_from_page(page(d),ID)
        with self.assertRaises(ValueError):pgn_from_page(page(game()),'anotherGame')
        d=game();d['turn']=34
        with self.assertRaisesRegex(ValueError,'incomplete'):pgn_from_page(page(d),ID)
    def test_no_script_execution_and_invalid_moves(self):
        with self.assertRaises(ValueError):pgn_from_page('<script>__RESOLVED_RESOURCES[0] = alert("x")</script>',ID)
        d=game();d['history'][2]=['wA1','bad target']
        with self.assertRaises(ValueError):pgn_from_page(page(d),ID)
    def test_failed_import_keeps_position(self):
        from server import App
        app=App();before=app.view()['game'];d=game();d['history'][0]=['wQ','']
        text=pgn_from_page(page(d),ID)
        with self.assertRaises(ValueError):app.command({'action':'load','text':text})
        self.assertEqual(app.view()['game'],before)

if __name__=='__main__':unittest.main()

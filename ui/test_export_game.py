from pathlib import Path
import unittest
from server import App
class ExportTests(unittest.TestCase):
    def test_roundtrip_both_formats_with_full_history_while_reviewing(self):
        for fixture in ('hivegame.json','hivegame.pgn'):
            app=App()
            app.command(dict(action='load',text=(Path(__file__).parent/'fixtures'/fixture).read_text()))
            final=app.session.data['game']
            app.command(dict(action='navigate',direction='first'))
            for kind in ('pgn','json'):
                exported=app.command(dict(action='export',format=kind))
                if fixture.endswith('pgn') and kind=='pgn':self.assertIn('[Result "BlackWins"]',exported['text'])
                other=App();s=other.command(dict(action='load',text=exported['text'],filename=exported['filename']))
                self.assertEqual(s['game'],final)
            self.assertEqual(app.session.data['ply'],0)
    def test_empty_game_and_resignation_result(self):
        app=App()
        for kind in ('pgn','json'):
            exported=app.command(dict(action='export',format=kind));other=App()
            self.assertEqual(other.command(dict(action='load',text=exported['text'],filename=exported['filename']))['ply'],0)
        app.command(dict(action='resign',side=0))
        self.assertIn('[Result "BlackWins"]',app.command(dict(action='export',format='pgn'))['text'])

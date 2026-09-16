"""Opt-in experimental exact-history book; legal move and binary provenance checked."""
import hashlib,json
from pathlib import Path
class OpeningBook:
    def __init__(self,root):
        self.data=None;self.error=None
        try:
            p=Path(root)/'ui/draft_opening_book.json'
            if not p.exists():return
            data=json.loads(p.read_text())
            for key,name in [('probe_sha256','bench_search')]:
                if hashlib.sha256((Path(root)/'target/release'/name).read_bytes()).hexdigest()!=data['config'][key]:
                    self.error='Draft book belongs to a different engine.';return
            self.data=data
        except (OSError,ValueError,KeyError) as exc:self.error=str(exc)
    def lookup(self,game,legal):
        if not self.data:return None
        entry=self.data['entries'].get(game)
        if not entry or entry['move'] not in legal:return None
        return entry

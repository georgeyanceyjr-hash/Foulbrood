from __future__ import annotations
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import List,Optional
from .core import Board, Action, add, parse_source_position

@dataclass
class SourceMove:
    turn:int
    piece:str
    position:str


def load_game(path:str)->List[SourceMove]:
    text=Path(path).read_text()
    stripped=text.lstrip()
    if stripped.startswith('{'):
        data=json.loads(text)
        nodes={n['id']:n for n in data['nodes']}
        cur=data['selected_node_id']; chain=[]
        while cur!=data['root_id']:
            n=nodes[cur]; chain.append(n['move_delta']); cur=n['parent']
        chain.reverse()
        return [SourceMove(x['turn'],x['piece'],x['position']) for x in chain]

    # hivegame.com PGN-style export. Header tags are ignored here; move lines
    # use the same piece/relative-position source notation as hive-analysis JSON.
    moves=[]
    rx=re.compile(r'^\s*(\d+)\.\s+(\S+)(?:\s+(\S+))?\s*$')
    for line in text.splitlines():
        m=rx.match(line)
        if not m:
            continue
        turn=int(m.group(1)); piece=m.group(2); position=m.group(3) or ''
        moves.append(SourceMove(turn,piece,position))
    if not moves:
        raise ValueError(f'unsupported or empty game source: {path}')
    return moves


def authoritative_dest(board:Board, sm:SourceMove):
    if sm.position=='': return (0,0)
    ref,delta,cover=parse_source_position(sm.position)
    if ref not in board.positions:
        raise KeyError(f'move {sm.turn}: source reference {ref} not on board')
    rc=board.positions[ref]
    return rc if cover else add(rc,delta)


def matching_authoritative_actions(board:Board, sm:SourceMove):
    dest=authoritative_dest(board,sm)
    acts=board.legal_actions()
    out=[]
    piece_on_board=sm.piece in board.positions
    if piece_on_board:
        for a in acts:
            if a.changed==sm.piece and a.dest==dest: out.append(a)
    else:
        # unspawned source piece must be a spawn of that color/type
        color,kind=sm.piece[0],sm.piece[1]
        for a in acts:
            if a.type=='spawn' and a.actor.startswith(color+kind) and a.dest==dest: out.append(a)
    return dest,acts,out

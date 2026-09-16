"""Export canonical history using Hive PGN or hive-analysis JSON v1."""
import json

def export_game(game, kind, result=None):
    parts=game.split(';');variant,state=parts[:2];moves=parts[3:]
    root=variant if '~' in variant else None
    if root:variant=root.split('~')[0]
    result=result or (state if state in ('WhiteWins','BlackWins','Draw') else '*')
    if kind=='pgn':
        text=f'[GameType "{variant}"]\n[Site "FoulBrood"]\n[Result "{result}"]\n\n'
        if root:text=f'[FoulBroodRoot "{root}"]\n'+text
        text+='\n'.join(f'{n}. {move}' for n,move in enumerate(moves,1))
        return dict(filename='FoulBrood.pgn',mime='application/x-chess-pgn',text=text+'\n\n'+result+'\n')
    if kind=='json' and root:
        data=dict(format='foulbrood-position',version=1,root=root,moves=moves,result=result)
        return dict(filename='FoulBrood-position.json',mime='application/json',text=json.dumps(data,indent=2)+'\n')
    if kind=='json':
        nodes=[dict(id=0,parent=None,children=[1] if moves else [],move_delta=None,position_hash=None)]
        for n,move in enumerate(moves,1):
            piece,_,position=move.partition(' ')
            nodes.append(dict(id=n,parent=n-1,children=[n+1] if n<len(moves) else [],
                              move_delta=dict(turn=n,piece=piece,position=position),position_hash=None))
        data=dict(format='hive-analysis',version=1,game_type=variant.removeprefix('Base+') if variant!='Base' else 'Base',
                  root_id=0,selected_node_id=len(moves),nodes=nodes,annotations={},start_hop=None)
        return dict(filename='FoulBrood.json',mime='application/json',text=json.dumps(data,indent=2)+'\n')
    raise ValueError('Choose PGN or JSON.')

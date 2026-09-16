"""Read Hive exports as move history; engine replay remains the rules authority."""
import json
import re

RESULTS=('WhiteWins','BlackWins','Draw','1-0','0-1','1/2-1/2','*')

def replay_history(game):
    if not isinstance(game,str):raise ValueError('Missing replay history.')
    parts=game.split(';')
    if len(parts)<3 or len(parts)>10003 or any('\n' in p or '\r' in p for p in parts):raise ValueError('Invalid replay history.')
    return parts[0],parts[3:],'Imported analytic display with its original replay history.'

def variant(value):
    if not isinstance(value,str):raise ValueError('Missing game type.')
    if value=='Base':return value
    extra=value.removeprefix('Base+') if hasattr(value,'removeprefix') else value.replace('Base+','',1)
    if extra and set(extra)<=set('MLP') and len(set(extra))==len(extra):return 'Base+'+''.join(c for c in 'MLP' if c in extra)
    raise ValueError('Unsupported game type: '+value)

def read_export(text, filename=''):
    text=text.lstrip('\ufeff').strip()
    if filename.lower().endswith('.json') or text.startswith('{'):
        try:data=json.loads(text)
        except (ValueError,TypeError) as exc:raise ValueError('This JSON file is not valid JSON.') from exc
        if isinstance(data,dict) and data.get('format')=='foulbrood-analytic-history':
            if data.get('version')!=1:raise ValueError('Unsupported analytic history version.')
            return replay_history(data.get('replay_game'))
        if isinstance(data,dict) and data.get('format')=='foulbrood-position':
            if data.get('version')!=1 or not isinstance(data.get('root'),str) or '~' not in data['root'] or ';' in data['root']:raise ValueError('Invalid set-up position.')
            moves=data.get('moves')
            if not isinstance(moves,list) or len(moves)>10000 or not all(isinstance(m,str) and '\n' not in m and ';' not in m for m in moves):raise ValueError('Invalid setup move history.')
            return data['root'],moves,'Set-up position. Earlier repetitions are unknown.'
        if not isinstance(data,dict) or data.get('format')!='hive-analysis' or data.get('version')!=1:
            raise ValueError('Unsupported Hive JSON format; expected hive-analysis version 1.')
        if data.get('start_hop') is not None:raise ValueError('JSON with a custom starting position is not supported yet.')
        nodes=data.get('nodes');root=data.get('root_id');selected=data.get('selected_node_id')
        if not isinstance(nodes,list) or not nodes or len(nodes)>10000:raise ValueError('Invalid JSON node list.')
        indexed={}
        for n in nodes:
            if not isinstance(n,dict) or type(n.get('id')) is not int or n['id'] in indexed:raise ValueError('Invalid or duplicate JSON node ID.')
            indexed[n['id']]=n
        if root not in indexed or selected not in indexed:raise ValueError('The root or selected JSON node is missing.')
        if indexed[root].get('parent') is not None or indexed[root].get('move_delta') is not None:raise ValueError('Unsupported JSON root position.')
        path=[];seen=set();current=selected
        while current!=root:
            if current in seen or current not in indexed:raise ValueError('Broken or cyclic JSON move history.')
            seen.add(current);n=indexed[current];delta=n.get('move_delta')
            if not isinstance(delta,dict) or not isinstance(delta.get('piece'),str) or not isinstance(delta.get('position',''),str):raise ValueError('Invalid JSON move.')
            path.append((delta['piece']+' '+delta.get('position','')).strip());current=n.get('parent')
        path.reverse()
        note=f'JSON: imported the selected node’s history ({len(path)} moves).'
        if len(nodes)>len(path)+1:note+=' Other branches or later nodes are not imported.'
        return variant(data.get('game_type')),path,note
    if filename.lower().endswith('.pgn') or text.startswith('['):
        tags={}
        def tag(m):tags[m[1]]=m[2];return ''
        body=re.sub(r'\[([A-Za-z][A-Za-z0-9_]*)\s+"([^"\r\n]*)"\s*\]',tag,text)
        if tags.get('Notation')=='Analytic' and 'FoulBroodReplay' in tags:
            import base64
            try:game=base64.b64decode(tags['FoulBroodReplay'],validate=True).decode('utf-8')
            except (ValueError,UnicodeError):raise ValueError('Invalid analytic replay data.')
            return replay_history(game)
        body=re.sub(r'\{[^}]*\}',' ',body,flags=re.S)
        body=re.sub(r';[^\n]*',' ',body)
        if any(c in body for c in '(){}[]'):raise ValueError('Unsupported PGN variation or malformed comment/tag.')
        body=re.sub(r'\$\d+',' ',body).strip()
        result=tags.get('Result','')
        ending=re.search(r'(WhiteWins|BlackWins|Draw|1/2-1/2|1-0|0-1|\*)\s*$',body)
        if ending:
            if result and result!=ending[1]:raise ValueError('Conflicting PGN results.')
            result=ending[1];body=body[:ending.start()].strip()
        if result and result not in RESULTS:raise ValueError('Unrecognized PGN result.')
        chunks=re.split(r'\b\d+\.(?:\.\.)?\s*',body)
        if chunks[0].strip():raise ValueError('Expected numbered Hive PGN moves.')
        moves=[]
        for chunk in chunks[1:]:
            move=' '.join(chunk.split())
            if not re.fullmatch(r'(?:pass|[wb][QABGSLMP][123]?(?:\s+[-/\\]?[wb][QABGSLMP][123]?[-/\\]?)?)',move):
                raise ValueError('Unsupported PGN move: '+move[:80])
            moves.append(move)
        note=f'PGN: imported {len(moves)} moves.'
        if result and result!='*':note+=' File reports '+result+'; board status is determined from the moves.'
        root=tags.get('FoulBroodRoot')
        if root and (';' in root or '~' not in root or root.split('~')[0]!=variant(tags.get('GameType','Base+MLP'))):raise ValueError('Invalid set-up position tag.')
        return root or variant(tags.get('GameType','Base+MLP')),moves,note
    return None

def reported_result(text):
    if text.lstrip().startswith('{'):
        try:result=json.loads(text).get('result')
        except (ValueError,AttributeError):return None
        return result if result in RESULTS else None
    if not text.lstrip('\ufeff \n\r\t').startswith('['):return None
    tag=re.search(r'\[Result\s+"([^"\r\n]+)"\s*\]',text)
    if tag and tag[1] in RESULTS:return tag[1]
    ending=re.search(r'(WhiteWins|BlackWins|Draw|1/2-1/2|1-0|0-1|\*)\s*$',text)
    return ending[1] if ending else None


def player_names(text):
    """Optional display metadata, never controller types or game rules."""
    text=text.lstrip('\ufeff \n\r\t')
    if text.startswith('{'):
        data=json.loads(text)
        tags=data.get('players', data)
        if not isinstance(tags,dict):return [None,None]
        values=[tags.get(c,tags.get(c.title())) for c in ('white','black')]
    else:
        tags=dict(re.findall(r'\[([A-Za-z]+)\s+"([^"\r\n]*)"\s*\]',text))
        values=[tags.get('White'),tags.get('Black')]
    return [v.strip() if isinstance(v,str) and v.strip() and v.strip()!='?' else None for v in values]

"""Engine-authoritative analytic notation; the original supplied converter stays intact.

All final forms are resolved against the complete legal action list. Symmetry
is tested on the pre-move colored stacks, last-move restriction and legal actions.
Numbers in traditional physical IDs never participate in written descriptors.
"""
from collections import Counter
from dataclasses import dataclass, replace
from itertools import combinations
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent/'vendor'))
from visual_hive.core import Board,Piece,Action,neighbors,hex_dist
from visual_hive.translate import Translator,PieceDesc,Form
from visual_hive.boundary import edge_cycle_index


def transform(h,t,mirror):
    q,r=h
    for _ in range(t):q,r=-r,q+r
    if mirror:q,r=-q-r,r
    return q,r


def action_key(a):return a.type,a.actor,a.changed,a.dest


@dataclass(frozen=True)
class Located(PieceDesc):
    reference: object = None
    relation: str = ''
    def text(self):
        return super().text()+(('['+self.relation+':'+self.reference.text()+']') if self.reference else '')


class Analytic(Translator):
    def __init__(self,frame):
        super().__init__();self.frame=frame
        for p in sorted(frame['pieces'],key=lambda p:(p['q'],p['r'],p['level'])):
            self.board.add_piece(Piece(p['id'],p['id'][0],p['id'][1]),(p['q'],p['r']))
        self.board.turn=2*(int(frame['game'].split(';')[2].split('[')[1].split(']')[0])-1)+frame['side']
        self.last=frame.get('last_move');self.legal=[]
        for m in frame['legal']:
            pid=m['piece']
            if pid is None:continue
            dest=tuple(m['to']);source=self.board.positions.get(pid)
            actor=m['actor'] or pid
            typ='spawn' if source is None else 'relocation' if m['actor'] else 'cover' if self.board.occupied(dest) else 'move'
            a=Action(typ,actor,pid,dest,source,power='P' if m['actor'] and actor[1]=='M' else None)
            if action_key(a) not in {action_key(x) for x in self.legal}:self.legal.append(a)
        self._matches={};self._orbits={};self._nf={};self._descriptors={};self._piece_distances={};self._raw_cache={};self._resolve_cache={}

    def orbit(self,a):
        """Exact D6 + translation orbit of the PRE-board with the action marked."""
        key=action_key(a)
        if key in self._orbits:return self._orbits[key]
        values=[]
        last=self.last['piece'] if self.last and self.last.get('from') else None
        for t in range(6):
            for mirror in (False,True):
                raw=[(transform(c,t,mirror),p,self.board.level(p)) for p,c in self.board.positions.items()]
                dest=transform(a.dest,t,mirror);coords=[x[0] for x in raw]+[dest]
                q0=min(c[0] for c in coords);r0=min(c[1] for c in coords)
                pieces=tuple(sorted((c[0]-q0,c[1]-r0,z,p[:2],p==a.actor,p==a.changed,p==last) for c,p,z in raw))
                values.append((a.type,a.actor[:2],a.changed[:2],dest[0]-q0,dest[1]-r0,pieces))
        answer=min(values);self._orbits[key]=answer;return answer

    def equivalents(self,actions,a):
        return bool(actions) and all(self.orbit(x)==self.orbit(a) for x in actions)

    def contact_tokens(self,pid):
        values=[self.visual_pid(p) for p in self.pre_neighbors(pid)]
        level=self.board.level(pid);stack=self.board.stacks[self.board.positions[pid]]
        if level:values.append('↓'+stack[level-1].visual())
        if level+1<len(stack):values.append('↑'+stack[level+1].visual())
        return values

    def simple_matches(self,d,pid):
        if self.visual_pid(pid)!=d.base:return False
        counts=Counter(self.contact_tokens(pid));need=Counter(d.contacts)
        return all(counts[k]>=v for k,v in need.items())

    def simple_descriptor(self,pid,forbidden=None):
        base=self.visual_pid(pid);same=[p for p in self.board.spawned if self.visual_pid(p)==base]
        vals=sorted(x for x in self.contact_tokens(pid) if x not in (forbidden or set()))
        for n in range(len(vals)+1):
            candidates=[]
            for contacts in set(combinations(vals,n)):
                d=PieceDesc(base,contacts)
                if [p for p in same if self.simple_matches(d,p)]==[pid]:candidates.append(d)
            if candidates:return min(candidates,key=lambda d:(len(d.text()),d.text()))
        return PieceDesc(base)

    def piece_distance(self,pid,ref):
        key=(pid,ref)
        if key in self._piece_distances:return self._piece_distances[key]
        from visual_hive.core import DIRS,add
        cell=self.board.positions[pid];rc=self.board.positions[ref];occ=set(self.board.stacks);result=None
        for side,delta in enumerate(DIRS):
            if add(cell,delta) in occ:continue
            try:
                edges,cycle,_=edge_cycle_index(occ,cell,side)
                a=[i for i,j in enumerate(cycle) if edges[j]['cell']==cell]
                b=[i for i,j in enumerate(cycle) if edges[j]['cell']==rc];n=len(cycle)
                if a and b:
                    distance=min(min((i-j)%n,(j-i)%n) for i in a for j in b)
                    result=distance if result is None else min(result,distance)
            except (ValueError,KeyError,IndexError):continue
        self._piece_distances[key]=result;return result

    def desc_matches_pid(self,d,pid):
        key=(d,pid)
        if key in self._matches:return self._matches[key]
        good=self.simple_matches(d,pid)
        if good and isinstance(d,Located) and d.reference:
            refs=[p for p in self.board.spawned if self.desc_matches_pid(d.reference,p)]
            same=[p for p in self.board.spawned if self.simple_matches(PieceDesc(d.base,d.contacts),p)]
            good=False
            if len(refs)==1:
                distances={p:self.piece_distance(p,refs[0]) for p in same}
                if all(x is not None for x in distances.values()):
                    best=(min if d.relation=='N' else max)(distances.values())
                    good=distances[pid]==best
        self._matches[key]=good;return good

    def descriptor_for_piece(self,pid,forbidden_contact_bases=None):
        key=(pid,tuple(sorted(forbidden_contact_bases or ())))
        if key in self._descriptors:return self._descriptors[key]
        simple=self.simple_descriptor(pid,forbidden_contact_bases)
        same=[p for p in self.board.spawned if self.simple_matches(simple,p)]
        options=[]
        if len(same)==1:options=[simple]
        else:
            for ref in self.board.spawned:
                desc=self.simple_descriptor(ref)
                if sum(self.simple_matches(desc,p) for p in self.board.spawned)!=1:continue
                for relation in ('N','F'):
                    d=Located(simple.base,simple.contacts,desc,relation)
                    if [p for p in same if self.desc_matches_pid(d,p)]==[pid]:options.append(d)
        answer=min(options,key=lambda d:(len(d.text()),d.text())) if options else simple
        self._descriptors[key]=answer;return answer

    def raw_matches(self,f):
        key=replace(f,qualifier=None,anchor_pid=None)
        if key not in self._raw_cache:self._raw_cache[key]=self._raw_matches(key)
        return self._raw_cache[key]

    def _raw_matches(self,f):
        out=[]
        for a in self.legal:
            if a.type!=f.action_type or a.power!=f.power:continue
            if a.type=='spawn':
                if a.actor[:2]!=f.actor.base:continue
            elif not self.desc_matches_pid(f.actor,a.actor):continue
            if a.type=='relocation' and not self.desc_matches_pid(f.changed,a.changed):continue
            if a.type=='cover':
                pid=self.board.top(a.dest).id
                if len(f.contacts)!=1 or not self.desc_matches_pid(f.contacts[0],pid):continue
                out.append((a,[(pid,)]));continue
            # Contact lists are unordered and each contact names a distinct piece.
            pids=self.effective_dest_contact_pids(a)
            assignments=[]
            def visit(i,used,found):
                if i==len(f.contacts):assignments.append(tuple(found));return
                for pid in pids:
                    if pid not in used and self.desc_matches_pid(f.contacts[i],pid):visit(i+1,used|{pid},found+[pid])
            visit(0,set(),[])
            if assignments:out.append((a,assignments))
        exact=[(a,assigns) for a,assigns in out if a.type=='cover' or len(self.effective_dest_contact_pids(a))==len(f.contacts)]
        return exact or out

    def perimeter_distance(self,target,dest,ref):
        key=(target,dest,ref)
        if key in self._nf:return self._nf[key]
        from visual_hive.core import DIRS,sub
        try:
            tc=self.board.positions[target];delta=sub(dest,tc)
            if delta not in DIRS:return None
            edges,cycle,index=edge_cycle_index(set(self.board.stacks),tc,DIRS.index(delta))
            indexes=[i for i,j in enumerate(cycle) if edges[j]['cell']==self.board.positions[ref]]
            n=len(cycle);value=min(min((i-index)%n,(index-i)%n) for i in indexes) if indexes else None
        except (KeyError,ValueError,IndexError):value=None
        self._nf[key]=value;return value

    def resolve(self,f):
        key=replace(f,anchor_pid=None)
        if key not in self._resolve_cache:self._resolve_cache[key]=self._resolve(key)
        return self._resolve_cache[key]

    def _resolve(self,f):
        raw=self.raw_matches(f)
        if not f.qualifier:return [a for a,_ in raw]
        if f.qualifier[0]=='O':
            counts=Counter(self.orbit(a) for a,_ in raw)
            return [a for a,_ in raw if counts[self.orbit(a)]>1]
        kind,reference=f.qualifier;result=[]
        if kind=='C':
            center=self.center_dest({a.dest for a,_ in raw});return [a for a,_ in raw if a.dest==center]
        if kind=='I':return [] # Opening-axis history is not an intrinsic position reference.
        if kind not in ('N','F'):return []
        refs=[p for p in self.board.spawned if self.desc_matches_pid(reference,p)]
        for target in self.board.spawned:
            # Any written contact may be the anchor; no hidden "first contact".
            candidates=[a for a,assigns in raw if any(target in assignment for assignment in assigns)]
            for ref in refs:
                distances={a:self.perimeter_distance(target,a.dest,ref) for a in candidates}
                if not distances or any(d is None for d in distances.values()):continue
                wanted=(min if kind=='N' else max)(distances.values())
                result.extend(a for a,d in distances.items() if d==wanted)
        return list(dict.fromkeys(result))

    def valid(self,f,a):
        matches=self.resolve(f)
        if a not in matches:return False
        if f.qualifier and f.qualifier[0]=='O':
            # Repeatable, including later-game returns to symmetry. All choices
            # must be related by a genuine symmetry of the PRE-move position.
            return len(matches)>1 and self.equivalents(matches,a)
        if len(matches)==1:return True
        # First two placements establish an arbitrary origin/axis, not handedness.
        return len(self.board.stacks)<2 and a.type=='spawn' and self.equivalents(matches,a)

    def resolve_positional(self,a,actor,changed,branch,target_pid,contacts):
        f=Form(a.type,actor,changed,contacts,power=a.power,anchor_pid=target_pid)
        if self.valid(f,a):return [f]
        o=replace(f,qualifier=('O',None))
        if self.valid(o,a):return [o]
        forms=[]
        c=replace(f,qualifier=('C',None))
        if self.valid(c,a):forms.append(c)
        for ref in self.board.spawned:
            d=self.descriptor_for_piece(ref)
            for kind in ('N','F'):
                candidate=replace(f,qualifier=(kind,d))
                if self.valid(candidate,a):forms.append(candidate)
        return forms

    def minimize(self,f,a):
        """Delete redundant contacts/locators/qualifiers only after full resolution."""
        seen={f};pending=[f];valid=[]
        while pending:
            cur=pending.pop()
            if not self.valid(cur,a):continue
            valid.append(cur);next_forms=[]
            if cur.qualifier:next_forms.append(replace(cur,qualifier=None))
            for field in ('actor','changed'):
                descriptor=getattr(cur,field)
                if descriptor:
                    for j in range(len(descriptor.contacts)):
                        shorter=replace(descriptor,contacts=descriptor.contacts[:j]+descriptor.contacts[j+1:])
                        next_forms.append(replace(cur,**{field:shorter}))
            if cur.qualifier and cur.qualifier[1]:
                kind,ref=cur.qualifier
                for j in range(len(ref.contacts)):
                    next_forms.append(replace(cur,qualifier=(kind,replace(ref,contacts=ref.contacts[:j]+ref.contacts[j+1:]))))
                if isinstance(ref,Located):next_forms.append(replace(cur,qualifier=(kind,PieceDesc(ref.base,ref.contacts))))

            if cur.actor.contacts or isinstance(cur.actor,Located):next_forms.append(replace(cur,actor=PieceDesc(cur.actor.base)))
            if cur.changed and (cur.changed.contacts or isinstance(cur.changed,Located)):next_forms.append(replace(cur,changed=PieceDesc(cur.changed.base)))
            for i,d in enumerate(cur.contacts):
                if len(cur.contacts)>1:next_forms.append(replace(cur,contacts=cur.contacts[:i]+cur.contacts[i+1:]))
                if isinstance(d,Located):
                    contacts=list(cur.contacts);contacts[i]=PieceDesc(d.base,d.contacts);next_forms.append(replace(cur,contacts=tuple(contacts)))
                if d.contacts:
                    for j in range(len(d.contacts)):
                        contacts=list(cur.contacts);contacts[i]=replace(d,contacts=d.contacts[:j]+d.contacts[j+1:]);next_forms.append(replace(cur,contacts=tuple(contacts)))
            for n in next_forms:
                if n not in seen:seen.add(n);pending.append(n)
        return valid

    def forms_for(self,a):
        actor=self.actor_desc(a,self.legal);changed=self.changed_desc(a) if a.type=='relocation' else None
        forms=[]
        if not self.board.stacks:forms=[Form('spawn',actor,None,())]
        else:
            contacts=self.effective_dest_contact_pids(a)
            try:forms=self.branch_forms(a,self.legal,contacts)
            except (ValueError,KeyError,IndexError):pass
            # Exhaust all true contact subsets, independently of legacy heuristic
            # pruning. This also handles multiple authoritative actors and stacks.
            pids=[self.board.top(a.dest).id] if a.type=='cover' else self.dest_contact_pids(a,False)
            descriptions=[self.descriptor_for_piece(p) for p in pids]
            for n in range(1,len(pids)+1):
                for indexes in combinations(range(len(pids)),n):
                    ds=tuple(descriptions[i] for i in indexes)
                    f=Form(a.type,actor,changed,ds,power=a.power)
                    if self.valid(f,a):forms.append(f)
                    elif not forms or len(f.text())+4<=min(len(x.text()) for x in forms):forms+=self.resolve_positional(a,actor,changed,self.legal,pids[indexes[0]],ds)
        checked=[]
        for f in forms:checked+=self.minimize(f,a)
        return sorted({f.text() for f in checked},key=lambda s:(len(s),s))

    def translate(self,last):
        if last is None:
            if any(m['piece'] is None for m in self.frame['legal']):return 'pass'
            raise ValueError('No legal pass exists in this position.')
        candidates=[a for a in self.legal if a.changed==last['piece'] and a.dest==tuple(last['to']) and ((a.type=='relocation' and a.actor==last.get('actor')) if last.get('actor') else a.type!='relocation')]
        # Traditional notation records the moved piece/destination; it need not
        # identify which of several legal Pillbugs caused the same board result.
        forms=[]
        for a in candidates:
            for text in self.forms_for(a):
                if self.valid(parse_form(text),a):forms.append(text)
        if not forms:raise ValueError('No unique contact/reference description yet.')
        return min(forms,key=lambda s:(len(s),s))


def parse_form(text):
    """Read the displayed grammar independently of candidate construction."""
    import re
    index=0;power=None
    def spaces():
        nonlocal index
        while index<len(text) and text[index].isspace():index+=1
    def token(value):
        nonlocal index
        if not text.startswith(value,index):raise ValueError('Expected '+value)
        index+=len(value)
    def descriptor(allow_power=False):
        nonlocal index,power
        match=re.match(r'[wb][QABGSMLP]',text[index:])
        if not match:raise ValueError('Expected an unnumbered piece.')
        base=match.group();index+=2
        if allow_power and text[index:index+1]=='ᴾ':power='P';index+=1
        contacts=()
        if text[index:index+1]=='(':
            index+=1;end=text.find(')',index)
            if end<0:raise ValueError('Missing closing parenthesis.')
            values=text[index:end].split(',')
            if not values or any(not re.fullmatch(r'[↑↓]?[wb][QABGSMLP]',v) for v in values):raise ValueError('Invalid contact locator.')
            contacts=tuple(values);index=end+1
        d=PieceDesc(base,contacts)
        if text[index:index+1]=='[':
            index+=1;relation=text[index:index+1];index+=1
            if relation not in ('N','F'):raise ValueError('Invalid piece reference.')
            token(':');ref=descriptor();token(']');d=Located(base,contacts,ref,relation)
        return d
    actor=descriptor(True);spaces();changed=None
    if index==len(text):return Form('spawn',actor,None,())
    if text[index:index+1]==':':
        index+=1;spaces();changed=descriptor();spaces();token('→');kind='relocation'
    else:
        symbol=text[index:index+1];index+=1
        if symbol not in ('@','→','↑'):raise ValueError('Unknown action.')
        kind={'@':'spawn','→':'move','↑':'cover'}[symbol]
    spaces();contacts=[descriptor()]
    while text[index:index+1]==',':index+=1;contacts.append(descriptor())
    spaces();qualifier=None
    if index<len(text):
        token('[');relation=text[index:index+1];index+=1
        if relation in ('O','C'):qualifier=(relation,None)
        elif relation in ('N','F'):
            token(':');qualifier=(relation,descriptor())
        else:raise ValueError('Unknown positional qualifier.')
        token(']');spaces()
    if index!=len(text):raise ValueError('Unexpected trailing notation.')
    return Form(kind,actor,changed,tuple(contacts),qualifier,power)

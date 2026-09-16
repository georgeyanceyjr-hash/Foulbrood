from __future__ import annotations
from dataclasses import dataclass, field
from collections import deque
from typing import Dict, List, Tuple, Optional, Iterable, Set, FrozenSet

Coord = Tuple[int,int]

# Axial directions, clockwise: E, NE, NW, W, SW, SE
DIRS: Tuple[Coord,...] = ((1,0),(1,-1),(0,-1),(-1,0),(-1,1),(0,1))

SOURCE_DIR = {
    ('suffix','-'): DIRS[0],
    ('suffix','\\'): DIRS[1],
    ('prefix','/'): DIRS[2],
    ('prefix','-'): DIRS[3],
    ('prefix','\\'): DIRS[4],
    ('suffix','/'): DIRS[5],
}

PIECE_COUNTS = {'Q':1,'A':3,'B':2,'G':3,'S':2,'M':1,'L':1,'P':1}


def add(a:Coord,b:Coord)->Coord: return (a[0]+b[0],a[1]+b[1])
def sub(a:Coord,b:Coord)->Coord: return (a[0]-b[0],a[1]-b[1])
def neighbors(c:Coord)->List[Coord]: return [add(c,d) for d in DIRS]
def hex_dist(a:Coord,b:Coord)->int:
    dq=a[0]-b[0]; dr=a[1]-b[1]; ds=(-a[0]-a[1])-(-b[0]-b[1])
    return max(abs(dq),abs(dr),abs(ds))
def dir_index(delta:Coord)->int: return DIRS.index(delta)

@dataclass(frozen=True)
class Piece:
    id: str
    color: str
    kind: str
    def visual(self)->str: return self.color + self.kind

@dataclass(frozen=True)
class Action:
    type: str  # spawn, move, cover, relocation
    actor: str # piece id, or reserve symbol e.g. wA*
    changed: str # physical piece id or reserve symbol
    dest: Coord
    source: Optional[Coord] = None
    power: Optional[str] = None # copied power for mosquito: A/B/G/S/L/P/Q or *
    relocated: Optional[str] = None

@dataclass
class Board:
    stacks: Dict[Coord,List[Piece]] = field(default_factory=dict)
    positions: Dict[str,Coord] = field(default_factory=dict)
    spawned: Dict[str,Piece] = field(default_factory=dict)
    turn: int = 0
    last_moved_piece: Optional[str] = None
    last_relocated_piece: Optional[str] = None
    first_two: List[Coord] = field(default_factory=list)
    opening_o_used: bool = False

    def clone(self)->'Board':
        b=Board()
        b.stacks={c:list(v) for c,v in self.stacks.items()}
        b.positions=dict(self.positions)
        b.spawned=dict(self.spawned)
        b.turn=self.turn
        b.last_moved_piece=self.last_moved_piece
        b.last_relocated_piece=self.last_relocated_piece
        b.first_two=list(self.first_two)
        b.opening_o_used=self.opening_o_used
        return b

    def occupied(self,c:Coord)->bool: return bool(self.stacks.get(c))
    def height(self,c:Coord)->int: return len(self.stacks.get(c,()))
    def top(self,c:Coord)->Optional[Piece]:
        s=self.stacks.get(c); return s[-1] if s else None
    def coord(self,pid:str)->Coord: return self.positions[pid]
    def top_piece_ids(self)->Set[str]: return {s[-1].id for s in self.stacks.values() if s}
    def is_top(self,pid:str)->bool:
        c=self.positions.get(pid); return c is not None and self.top(c).id==pid
    def level(self,pid:str)->int:
        c=self.positions[pid]; s=self.stacks[c]; return next(i for i,p in enumerate(s) if p.id==pid)
    def on_ground(self,pid:str)->bool: return self.level(pid)==0
    def all_occupied(self)->Set[Coord]: return set(self.stacks)
    def side_to_move(self)->str: return 'w' if self.turn%2==0 else 'b'
    def own_turn_no(self,color:str)->int:
        # turn is count already played. next move number is turn+1
        if color=='w': return self.turn//2 + 1
        return (self.turn+1)//2
    def queen_spawned(self,color:str)->bool:
        return any(p.color==color and p.kind=='Q' for p in self.spawned.values())
    def used_count(self,color:str,kind:str)->int:
        return sum(1 for p in self.spawned.values() if p.color==color and p.kind==kind)
    def reserve_available(self,color:str,kind:str)->bool:
        return self.used_count(color,kind) < PIECE_COUNTS[kind]
    def next_piece_id(self,color:str,kind:str)->str:
        n=self.used_count(color,kind)+1
        return f'{color}{kind}' if PIECE_COUNTS[kind]==1 else f'{color}{kind}{n}'

    def add_piece(self,p:Piece,c:Coord):
        self.stacks.setdefault(c,[]).append(p); self.positions[p.id]=c; self.spawned[p.id]=p
    def lift(self,pid:str)->Piece:
        c=self.positions[pid]; s=self.stacks[c]
        assert s and s[-1].id==pid
        p=s.pop()
        if not s: del self.stacks[c]
        del self.positions[pid]
        return p
    def place_existing(self,p:Piece,c:Coord):
        self.stacks.setdefault(c,[]).append(p); self.positions[p.id]=c

    def ground_contacts(self,c:Coord)->List[Piece]:
        out=[]
        for n in neighbors(c):
            if self.occupied(n): out.append(self.top(n))
        return out

    def connected_after_lift(self,pid:str)->bool:
        c=self.positions[pid]
        if not self.is_top(pid): return False
        occ=set(self.stacks)
        if len(self.stacks[c])==1: occ.remove(c)
        if len(occ)<=1: return True
        start=next(iter(occ)); seen={start}; q=[start]
        while q:
            x=q.pop()
            for n in neighbors(x):
                if n in occ and n not in seen:
                    seen.add(n); q.append(n)
        return seen==occ

    def lifted_occupied(self,pid:Optional[str]=None)->Set[Coord]:
        occ=set(self.stacks)
        if pid is not None:
            c=self.positions[pid]
            if len(self.stacks[c])==1: occ.remove(c)
        return occ

    def gate_open_ground(self,a:Coord,b:Coord,occ:Set[Coord])->bool:
        # a,b adjacent. Common neighbor cells flank the shared movement gap.
        di=dir_index(sub(b,a))
        left=add(a,DIRS[(di-1)%6]); right=add(a,DIRS[(di+1)%6])
        return not (left in occ and right in occ)

    def has_hive_contact(self,c:Coord,occ:Set[Coord])->bool:
        return any(n in occ for n in neighbors(c))

    def perimeter_empty(self,occ:Set[Coord])->Set[Coord]:
        out=set()
        for c in occ:
            for n in neighbors(c):
                if n not in occ: out.add(n)
        return out

    def slide_neighbors(self,c:Coord,occ:Set[Coord])->List[Coord]:
        out=[]
        for n in neighbors(c):
            if n in occ: continue
            if not self.has_hive_contact(n,occ): continue
            if self.gate_open_ground(c,n,occ): out.append(n)
        return out

    def legal_queen_dests(self,pid:str)->Set[Coord]:
        if not self.connected_after_lift(pid): return set()
        src=self.positions[pid]; occ=self.lifted_occupied(pid)
        return set(self.slide_neighbors(src,occ))

    def legal_ant_dests(self,pid:str)->Set[Coord]:
        if not self.connected_after_lift(pid): return set()
        src=self.positions[pid]; occ=self.lifted_occupied(pid)
        # Ant traverses connected empty perimeter graph via legal slides.
        seen={src}; q=deque([src]); out=set()
        while q:
            cur=q.popleft()
            for nxt in self.slide_neighbors(cur,occ):
                if nxt not in seen:
                    seen.add(nxt); q.append(nxt); out.add(nxt)
        out.discard(src)
        return out

    def legal_spider_dests(self,pid:str)->Set[Coord]:
        if not self.connected_after_lift(pid): return set()
        src=self.positions[pid]; occ=self.lifted_occupied(pid); out=set()
        def dfs(cur:Coord,depth:int,seen:Set[Coord]):
            if depth==3:
                if cur!=src: out.add(cur)
                return
            for nxt in self.slide_neighbors(cur,occ):
                if nxt in seen: continue
                dfs(nxt,depth+1,seen|{nxt})
        dfs(src,0,{src})
        return out

    def legal_grasshopper_dests(self,pid:str)->Set[Coord]:
        if not self.connected_after_lift(pid): return set()
        src=self.positions[pid]; occ=self.lifted_occupied(pid); out=set()
        for d in DIRS:
            cur=add(src,d)
            if cur not in occ: continue
            while cur in occ: cur=add(cur,d)
            out.add(cur)
        return out

    def legal_ladybug_dests(self,pid:str)->Set[Coord]:
        if not self.connected_after_lift(pid): return set()
        src=self.positions[pid]; occ=self.lifted_occupied(pid); out=set()
        # First two steps must be onto occupied cells; third down to empty.
        for a in neighbors(src):
            if a not in occ: continue
            for b in neighbors(a):
                if b not in occ or b==src or b==a: continue
                for c in neighbors(b):
                    if c in occ or c in (src,a,b): continue
                    if self.has_hive_contact(c,occ): out.add(c)
        return out

    def legal_beetle_dests(self,pid:str)->Set[Coord]:
        if not self.connected_after_lift(pid): return set()
        src=self.positions[pid]; src_level=self.level(pid); occ=self.lifted_occupied(pid); out=set()
        for di,d in enumerate(DIRS):
            dst=add(src,d)
            dh=self.height(dst)
            if dst==src: continue
            # Approximate official gate-height rule: a beetle at travel height H cannot pass
            # between two neighboring stacks both at least H+1 high. H is max(source top level, dest top level).
            left=add(src,DIRS[(di-1)%6]); right=add(src,DIRS[(di+1)%6])
            # after lifting moving beetle, source height may drop
            def h(c):
                if c==src: return self.height(c)-1
                return self.height(c)
            travel=max(src_level, dh)  # zero-based level at/above ground
            if h(left)>travel and h(right)>travel: continue
            if dh==0 and src_level==0:
                if not self.has_hive_contact(dst,occ): continue
                if not self.gate_open_ground(src,dst,occ): continue
            out.add(dst)
        return out

    def mosquito_powers(self,pid:str)->Set[str]:
        if self.level(pid)>0: return {'B'}
        c=self.positions[pid]; powers=set()
        for n in neighbors(c):
            if self.occupied(n):
                k=self.top(n).kind
                if k!='M': powers.add(k)
        return powers

    def legal_normal_dests_for_kind(self,pid:str,kind:str)->Set[Coord]:
        if kind in ('Q','P'): return self.legal_queen_dests(pid)
        if kind=='A': return self.legal_ant_dests(pid)
        if kind=='S': return self.legal_spider_dests(pid)
        if kind=='G': return self.legal_grasshopper_dests(pid)
        if kind=='L': return self.legal_ladybug_dests(pid)
        if kind=='B': return self.legal_beetle_dests(pid)
        return set()

    def legal_normal_actions_for_piece(self,pid:str)->List[Action]:
        if not self.is_top(pid): return []
        p=self.spawned[pid]
        if not self.queen_spawned(p.color): return []
        if self.last_relocated_piece==pid: return []  # stunned after special relocation
        src=self.positions[pid]
        actions=[]
        if p.kind=='M':
            pows=self.mosquito_powers(pid)
            by_dest: Dict[Coord,Set[str]]={}
            for power in pows:
                for dst in self.legal_normal_dests_for_kind(pid,power):
                    by_dest.setdefault(dst,set()).add(power)
            for dst,powers in by_dest.items():
                typ='cover' if self.occupied(dst) else 'move'
                power='*' if len(powers)>1 else next(iter(powers))
                actions.append(Action(typ,pid,pid,dst,src,power=power))
        else:
            for dst in self.legal_normal_dests_for_kind(pid,p.kind):
                typ='cover' if self.occupied(dst) else 'move'
                actions.append(Action(typ,pid,pid,dst,src))
        return actions

    def legal_spawn_coords(self,color:str)->Set[Coord]:
        occ=set(self.stacks)
        if not occ: return {(0,0)}
        if len(occ)==1:
            return set(neighbors(next(iter(occ))))
        out=set()
        for c in occ:
            top=self.top(c)
            if top.color!=color: continue
            for n in neighbors(c):
                if n in occ: continue
                touches=[self.top(x) for x in neighbors(n) if x in occ]
                if touches and all(p.color==color for p in touches): out.add(n)
        return out

    def legal_spawn_actions(self,color:str)->List[Action]:
        own_no=self.own_turn_no(color)
        must_q=(own_no>=4 and not self.queen_spawned(color))
        kinds=['Q'] if must_q else [k for k in PIECE_COUNTS if self.reserve_available(color,k)]
        out=[]
        for kind in kinds:
            if not self.reserve_available(color,kind): continue
            rid=f'{color}{kind}*'
            for c in self.legal_spawn_coords(color):
                out.append(Action('spawn',rid,rid,c,None))
        return out

    def legal_relocations_for_actor(self,actor_id:str)->List[Action]:
        if not self.is_top(actor_id): return []
        actor=self.spawned[actor_id]
        if self.level(actor_id)>0: return []
        if self.last_relocated_piece==actor_id: return []
        powers={'P'} if actor.kind=='P' else (self.mosquito_powers(actor_id) if actor.kind=='M' else set())
        if 'P' not in powers: return []
        ac=self.positions[actor_id]; out=[]
        # empty neighboring destinations around actor
        dests=[n for n in neighbors(ac) if not self.occupied(n)]
        for sc in neighbors(ac):
            if not self.occupied(sc): continue
            target=self.top(sc)
            tid=target.id
            # target must be a ground-level single piece (cannot lift from stack)
            if len(self.stacks[sc])!=1: continue
            if self.last_moved_piece==tid: continue
            if self.last_relocated_piece==tid: continue
            if not self.connected_after_lift(tid): continue
            for dst in dests:
                # Pillbug lift ignores ordinary sliding/gates, but source/dest must neighbor actor.
                power='P' if actor.kind=='M' else None
                out.append(Action('relocation',actor_id,tid,dst,sc,power=power,relocated=tid))
        return out

    def legal_actions(self)->List[Action]:
        color=self.side_to_move(); out=[]
        out.extend(self.legal_spawn_actions(color))
        for pid,p in list(self.spawned.items()):
            if p.color==color: out.extend(self.legal_normal_actions_for_piece(pid))
        for pid,p in list(self.spawned.items()):
            if p.color==color and p.kind in ('P','M'):
                out.extend(self.legal_relocations_for_actor(pid))
        return out

    def pass_turn(self):
        """Advance one legal pass turn (used by PGN sources that omit pass records)."""
        if self.legal_actions():
            raise ValueError(f'{self.side_to_move()} cannot pass: legal actions exist')
        self.last_moved_piece=None
        self.last_relocated_piece=None
        self.turn += 1

    def apply_action(self,a:Action, authoritative_piece_id:Optional[str]=None):
        color=self.side_to_move()
        if a.type=='spawn':
            rid=a.changed
            kind=rid[1]
            pid=authoritative_piece_id or self.next_piece_id(color,kind)
            p=Piece(pid,color,kind); self.add_piece(p,a.dest)
            moved=pid
        elif a.type in ('move','cover'):
            p=self.lift(a.changed); self.place_existing(p,a.dest); moved=a.changed
        elif a.type=='relocation':
            p=self.lift(a.changed); self.place_existing(p,a.dest); moved=a.changed
        else: raise ValueError(a.type)
        self.last_moved_piece=moved
        self.last_relocated_piece=moved if a.type=='relocation' else None
        if len(self.first_two)<2:
            self.first_two.append(a.dest)
        self.turn += 1


def parse_piece_id(pid:str)->Piece:
    return Piece(pid,pid[0],pid[1])

def parse_source_position(pos:str)->Tuple[Optional[str],Optional[Coord],bool]:
    """Return (reference piece id, direction delta, cover). Empty position for first move."""
    if pos=='': return None,None,False
    # plain piece id means cover its hex
    if pos[0].isalnum() and pos[-1].isalnum(): return pos,None,True
    if pos[0] in '-/\\':
        mark=pos[0]; ref=pos[1:]; return ref,SOURCE_DIR[('prefix',mark)],False
    if pos[-1] in '-/\\':
        mark=pos[-1]; ref=pos[:-1]; return ref,SOURCE_DIR[('suffix',mark)],False
    raise ValueError(f'bad source position {pos!r}')

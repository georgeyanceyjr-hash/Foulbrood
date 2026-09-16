from __future__ import annotations
import math
from collections import defaultdict
from typing import Dict,List,Tuple,Set
from .core import Coord,DIRS,add

# Pointy-top axial geometry matching DIRS order E,NE,NW,W,SW,SE.
SQ3=math.sqrt(3.0)

def center(c:Coord):
    q,r=c
    return (SQ3*(q+r/2.0), 1.5*r)

def corners(c:Coord):
    cx,cy=center(c)
    # pointy top corners, angles 30,90,...
    pts=[]
    for k in range(6):
        ang=math.radians(30+60*k)
        pts.append((round(cx+math.cos(ang),8),round(cy+math.sin(ang),8)))
    return pts

# side index corresponding to DIRS: E edge between corners 5,0; NE 0,1; NW 1,2; W 2,3; SW 3,4; SE 4,5
SIDE_CORNERS=((5,0),(4,5),(3,4),(2,3),(1,2),(0,1))

def boundary_cycles(occ:Set[Coord]):
    edges=[]
    for c in occ:
        pts=corners(c)
        for si,d in enumerate(DIRS):
            if add(c,d) not in occ:
                a,b=SIDE_CORNERS[si]
                edges.append({'cell':c,'side':si,'a':pts[a],'b':pts[b]})
    byv=defaultdict(list)
    for i,e in enumerate(edges):
        byv[e['a']].append(i); byv[e['b']].append(i)
    # Each boundary vertex should have degree 2 for edge-connected hex unions; if >2, choose continuation by geometry.
    unused=set(range(len(edges))); cycles=[]
    while unused:
        start=next(iter(unused)); cyc=[start]; unused.remove(start)
        # orient start a->b
        cur=start; prev_v=edges[cur]['a']; cur_v=edges[cur]['b']
        while True:
            cand=[i for i in byv[cur_v] if i!=cur and (i in unused or i==start)]
            if not cand: break
            if start in cand and len(cyc)>1:
                break
            if len(cand)>1:
                # choose edge that makes smallest right turn from incoming vector to stay on same boundary
                px,py=prev_v; cx,cy=cur_v; vin=(cx-px,cy-py)
                scored=[]
                for i in cand:
                    e=edges[i]; nv=e['b'] if e['a']==cur_v else e['a']
                    vout=(nv[0]-cx,nv[1]-cy)
                    cross=vin[0]*vout[1]-vin[1]*vout[0]; dot=vin[0]*vout[0]+vin[1]*vout[1]
                    ang=math.atan2(cross,dot)
                    scored.append((ang,i,nv))
                # consistent local continuation; degree>2 is rare
                _,nxt,nv=min(scored,key=lambda x:abs(x[0]))
            else:
                nxt=cand[0]; e=edges[nxt]; nv=e['b'] if e['a']==cur_v else e['a']
            if nxt==start: break
            cyc.append(nxt); unused.discard(nxt)
            prev_v,cur_v=cur_v,nv; cur=nxt
            if len(cyc)>len(edges)+2: raise RuntimeError('boundary loop overflow')
        cycles.append(cyc)
    return edges,cycles

def outer_cycle(occ:Set[Coord]):
    edges,cycles=boundary_cycles(occ)
    # outer boundary has largest absolute polygon-like cycle length; holes shorter for Hive positions.
    cyc=max(cycles,key=len) if cycles else []
    return edges,cyc

def edge_cycle_index(occ:Set[Coord],cell:Coord,side:int):
    edges,cyc=outer_cycle(occ)
    for j,ei in enumerate(cyc):
        e=edges[ei]
        if e['cell']==cell and e['side']==side:
            return edges,cyc,j
    raise KeyError((cell,side))

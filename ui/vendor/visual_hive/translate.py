from __future__ import annotations
from dataclasses import dataclass, replace
from itertools import combinations
from collections import Counter,defaultdict,deque
from typing import Tuple,List,Optional,Set,Dict,Iterable
from .core import *
from .source import *
from .boundary import edge_cycle_index

SUP={'A':'ᴬ','B':'ᴮ','G':'ᴳ','L':'ᴸ','P':'ᴾ','Q':'Q','S':'S','*':'*'}

@dataclass(frozen=True)
class PieceDesc:
    base:str
    contacts:Tuple[str,...]=()
    def text(self):
        return self.base + ("("+",".join(self.contacts)+")" if self.contacts else "")

@dataclass(frozen=True)
class Form:
    action_type:str
    actor:PieceDesc
    changed:Optional[PieceDesc]
    contacts:Tuple[PieceDesc,...]=()
    qualifier:Optional[Tuple[str,Optional[PieceDesc]]]=None
    power:Optional[str]=None
    # internal authoritative target physical id for candidate construction only, not matching semantics
    anchor_pid:Optional[str]=None

    def actor_text(self):
        s=self.actor.text()
        if self.actor.base.endswith('M') and self.power:
            s=self.actor.base+SUP.get(self.power,self.power)+("("+",".join(self.actor.contacts)+")" if self.actor.contacts else "")
        return s
    def text(self):
        a=self.actor_text()
        q=''
        if self.qualifier:
            k,ref=self.qualifier
            q=' ['+k+((':'+ref.text()) if ref else '')+']'
        # Destination contact lists are commutative unordered sets. Their written
        # order never changes meaning, including when C/N/F is present. The physical
        # anchor used during candidate construction is stored separately in anchor_pid.
        ct=sorted(x.text() for x in self.contacts)
        ctext=','.join(ct)
        if self.action_type=='spawn':
            return a + ((' @ '+ctext) if self.contacts else '') + q
        if self.action_type=='move':
            return a+' → '+ctext+q
        if self.action_type=='cover':
            return a+' ↑ '+ctext
        if self.action_type=='relocation':
            return a+': '+self.changed.text()+' → '+ctext+q
        raise ValueError(self.action_type)

class Translator:
    def __init__(self):
        self.board=Board()

    def visual_pid(self,pid:str)->str:
        p=self.board.spawned[pid]; return p.visual()

    def pre_neighbors(self,pid:str)->List[str]:
        c=self.board.positions[pid]; out=[]
        for n in neighbors(c):
            if self.board.occupied(n): out.append(self.board.top(n).id)
        return out

    def desc_matches_pid(self,desc:PieceDesc,pid:str)->bool:
        if pid not in self.board.spawned: return False
        if self.visual_pid(pid)!=desc.base: return False
        if not desc.contacts: return True
        cnt=Counter(self.visual_pid(x) for x in self.pre_neighbors(pid))
        req=Counter(desc.contacts)
        return all(cnt[k]>=v for k,v in req.items())

    def descriptor_for_piece(self,pid:str, forbidden_contact_bases:Optional[Set[str]]=None)->PieceDesc:
        base=self.visual_pid(pid)
        same=[x for x in self.board.spawned if self.visual_pid(x)==base]
        if len(same)<=1: return PieceDesc(base)
        forbidden_contact_bases = forbidden_contact_bases or set()
        # When a locator symbol is structurally guaranteed by an action (notably
        # the acting P/Mᴾ in a relocation), it carries no useful destination
        # information and is forbidden inside a destination piece locator.
        vals=[self.visual_pid(x) for x in self.pre_neighbors(pid)
              if self.visual_pid(x) not in forbidden_contact_bases]
        # Search true contact multisets shortest-first. Duplicates are meaningful.
        for r in range(1,len(vals)+1):
            seen=set()
            for inds in combinations(range(len(vals)),r):
                tup=tuple(sorted(vals[i] for i in inds))
                if tup in seen: continue
                seen.add(tup)
                d=PieceDesc(base,tup)
                matches=[x for x in same if self.desc_matches_pid(d,x)]
                if matches==[pid] or (len(matches)==1 and matches[0]==pid):
                    return d
        return PieceDesc(base)

    def target_descriptor_for_actions(self,pid:str,cands:List[Action], forbidden_contact_bases:Optional[Set[str]]=None)->PieceDesc:
        """Describe a target after Stage-3 legality filtering.

        A parenthetical target locator is unnecessary when, among the resolved
        actor/action legal actions, only one physical piece of that visual type
        can serve as a target.  Only if multiple same-type reachable targets
        survive do we fall back to PRE-MOVE contact descriptors.
        """
        base=self.visual_pid(pid)
        reachable=set()
        for x in cands:
            if x.type=='cover':
                if self.board.occupied(x.dest):
                    q=self.board.top(x.dest).id
                    if self.visual_pid(q)==base:
                        reachable.add(q)
            else:
                for q in self.dest_contact_pids(x,exclude_actor_for_relocation=False):
                    if self.visual_pid(q)==base:
                        reachable.add(q)
        if reachable=={pid}:
            return PieceDesc(base)
        return self.descriptor_for_piece(pid, forbidden_contact_bases)

    def actor_desc(self,a:Action,legal:Optional[List[Action]]=None)->PieceDesc:
        if a.type=='spawn':
            return PieceDesc(a.actor[:2])

        base=self.visual_pid(a.actor)
        if legal is not None:
            # Actor identity is legality-first and must not use destination/target
            # information.  Consider physical actors of the same visual piece type
            # that can legally perform the resolved action type anywhere on this
            # PRE-MOVE board.  If only one remains, the bare actor symbol is enough.
            capable=set()
            for x in legal:
                if x.type != a.type:
                    continue
                if x.actor not in self.board.spawned:
                    continue
                if self.visual_pid(x.actor) != base:
                    continue
                capable.add(x.actor)
            if capable == {a.actor}:
                return PieceDesc(base)

        return self.descriptor_for_piece(a.actor)

    def changed_desc(self,a:Action)->PieceDesc:
        return self.descriptor_for_piece(a.changed)

    def action_base_candidates(self,a:Action,legal:List[Action])->List[Action]:
        if a.type=='spawn':
            return [x for x in legal if x.type=='spawn' and x.actor[:2]==a.actor[:2]]
        if a.type=='relocation':
            return [x for x in legal if x.type=='relocation' and x.actor==a.actor and x.changed==a.changed and x.power==a.power]
        return [x for x in legal if x.type==a.type and x.actor==a.actor and x.power==a.power]

    def lifted_for_action(self,x:Action)->Board:
        b=self.board.clone()
        if x.type!='spawn': b.lift(x.changed)
        return b

    def dest_contact_pids(self,x:Action, exclude_actor_for_relocation=False)->List[str]:
        b=self.lifted_for_action(x); out=[]
        for n in neighbors(x.dest):
            if b.occupied(n):
                pid=b.top(n).id
                if exclude_actor_for_relocation and x.type=='relocation' and pid==x.actor: continue
                out.append(pid)
        return out

    def action_contact_assignments(self,x:Action,descs:Tuple[PieceDesc,...]):
        # The first destination descriptor is the target anchor. For relocation,
        # the acting P/Mᴾ may serve as that target itself, but may not be reused
        # as an additional destination contact.
        pids=self.dest_contact_pids(x,exclude_actor_for_relocation=False)
        results=[]
        def rec(i,used,cur):
            if i==len(descs): results.append(tuple(cur)); return
            for pid in pids:
                if pid in used: continue
                if x.type=='relocation' and pid==x.actor and i>0:
                    continue
                if self.desc_matches_pid(descs[i],pid):
                    rec(i+1,used|{pid},cur+[pid])
        rec(0,set(),[])
        return results

    def base_form_filter(self,form:Form,legal:List[Action]):
        out=[]
        for x in legal:
            if x.type!=form.action_type: continue
            if form.action_type=='spawn':
                if x.actor[:2]!=form.actor.base: continue
            else:
                if x.actor not in self.board.spawned or not self.desc_matches_pid(form.actor,x.actor): continue
                if x.power!=form.power: continue
            if form.action_type=='relocation':
                if not self.desc_matches_pid(form.changed,x.changed): continue
            assigns=self.action_contact_assignments(x,form.contacts)
            if form.contacts and not assigns: continue
            if not form.contacts: assigns=[tuple()]
            out.append((x,assigns))
        return out

    def on_opening_line(self,c:Coord)->bool:
        if len(self.board.first_two)<2: return False
        a,b=self.board.first_two; d=sub(b,a); x=sub(c,a)
        return d[0]*x[1]==d[1]*x[0]

    def center_dest(self,dests:Set[Coord])->Optional[Coord]:
        if len(dests)<3: return None
        ds=list(dests); graph={d:{e for e in ds if e!=d and hex_dist(d,e)==1} for d in ds}
        # unique graph center by eccentricity on connected candidate graph
        ecc={}
        for s in ds:
            dist={s:0}; q=deque([s])
            while q:
                u=q.popleft()
                for v in graph[u]:
                    if v not in dist: dist[v]=dist[u]+1;q.append(v)
            if len(dist)!=len(ds): continue
            ecc[s]=max(dist.values())
        if not ecc: return None
        m=min(ecc.values()); centers=[d for d,v in ecc.items() if v==m]
        return centers[0] if len(centers)==1 else None

    def nf_results(self,target_pid:str,candidate_dests:Set[Coord]):
        """Return list of (N/F, reference pid) valid for authoritative dest later; dict per dest via caller.
        Computes first distinguishing reference in each direction for the whole candidate set.
        """
        tc=self.board.positions[target_pid]; occ=set(self.board.stacks)
        # target-side edge index for each candidate destination
        edge_info={}
        for d in candidate_dests:
            delta=sub(d,tc)
            if delta not in DIRS: continue
            side=dir_index(delta)
            try: edges,cyc,idx=edge_cycle_index(occ,tc,side)
            except Exception: continue
            edge_info[d]=(edges,cyc,idx)
        if len(edge_info)!=len(candidate_dests) or not edge_info: return []
        # canonical cycle from first; boundary helper should return same cycle ordering set, but cycles may rotate.
        first=next(iter(edge_info.values())); edges0,cyc0,_=first
        # Build key->cycle index for canonical cycle
        keyidx={(edges0[ei]['cell'],edges0[ei]['side']):j for j,ei in enumerate(cyc0)}
        cand_idx={d:keyidx[(tc,dir_index(sub(d,tc)))] for d in candidate_dests}
        n=len(cyc0)
        out=[]
        for step in (1,-1):
            start_idx=cand_idx[next(iter(candidate_dests))]  # only to discover refs? must start from authoritative target edge varies.
            # Reference discovery should begin from the authoritative landing edge, supplied later. We instead enumerate
            # a path per possible authoritative dest and caller chooses. So return function-like records below.
        return []

    def nf_for_authoritative(self,target_pid:str,candidate_dests:Set[Coord],auth_dest:Coord):
        """Return valid N/F references for the authoritative destination.

        Reference discovery still walks the exposed outer perimeter in both
        directions, but a physical reference piece is tested only once.
        Its distance from each candidate edge is the SHORTEST exposed
        outer-perimeter edge count to any exposed boundary edge of that
        reference piece.  If the authoritative candidate ties any competitor,
        the reference is invalid and search continues outward.
        """
        tc=self.board.positions[target_pid]; occ=set(self.board.stacks)
        side_auth=dir_index(sub(auth_dest,tc))
        edges,cyc,auth_idx=edge_cycle_index(occ,tc,side_auth)
        keyidx={(edges[ei]['cell'],edges[ei]['side']):j for j,ei in enumerate(cyc)}
        cand_idx={}
        for d in candidate_dests:
            delta=sub(d,tc)
            if delta not in DIRS: return []
            key=(tc,dir_index(delta))
            if key not in keyidx: return []
            cand_idx[d]=keyidx[key]
        n=len(cyc)
        # All exposed cycle indexes for each physical piece.
        ref_indexes={}
        for j,ei in enumerate(cyc):
            cell=edges[ei]['cell']
            if cell==tc: continue
            ref_indexes.setdefault(cell,[]).append(j)

        def perimeter_distance(ci, indexes):
            # Number of exposed boundary-edge steps around the cycle; direction
            # is not part of N/F distance. Use the shorter way around.
            best=None
            for rj in indexes:
                cw=(rj-ci) % n
                ccw=(ci-rj) % n
                d=min(cw,ccw)
                if best is None or d<best: best=d
            return best

        results=[]
        tested_cells=set()
        # Search outward from the authoritative target edge in both directions.
        # A tied/non-distinguishing piece is skipped; then continue farther.
        for direction in (1,-1):
            i=(auth_idx+direction)%n; last_cell=tc; visited=0
            while visited<n:
                e=edges[cyc[i]]; cell=e['cell']
                if cell!=tc and cell!=last_cell:
                    last_cell=cell
                    if cell in tested_cells:
                        i=(i+direction)%n; visited+=1; continue
                    tested_cells.add(cell)
                    indexes=ref_indexes.get(cell,[])
                    distances={d:perimeter_distance(ci,indexes) for d,ci in cand_idx.items()}
                    av=distances[auth_dest]
                    vals=list(distances.values())
                    # Equal count to any surviving candidate => invalid reference.
                    if vals.count(av)==1:
                        ref_pid=self.board.top(cell).id
                        # N/F references must be readable as a bare physical piece.
                        # If this same-type reference would require a parenthetical
                        # locator, reject it as a reference and continue outward.
                        if self.descriptor_for_piece(ref_pid).contacts:
                            i=(i+direction)%n; visited+=1; continue
                        if av==min(vals):
                            results.append(('N',ref_pid)); break
                        if av==max(vals):
                            results.append(('F',ref_pid)); break
                    # failed reference: continue outward in this direction
                i=(i+direction)%n; visited+=1
        # de-dupe rendered semantics
        uniq=[]; seen=set()
        for k,pid in results:
            key=(k,pid)
            if key not in seen:
                seen.add(key); uniq.append((k,pid))
        return uniq

    def effective_dest_contact_pids(self,x:Action)->List[str]:
        """Destination contacts available to Visual notation.

        For relocation, adjacency to the acting P/Mᴾ is structurally guaranteed
        and is excluded whenever another true contact exists.  If the actor is
        the sole physical contact, it may serve as the target anchor.
        """
        physical=self.dest_contact_pids(x,exclude_actor_for_relocation=False)
        if x.type!='relocation':
            return physical
        non_actor=[p for p in physical if p!=x.actor]
        if non_actor:
            return non_actor
        return [x.actor] if x.actor in physical else []

    def candidate_actions_touching_pid(self,cands:List[Action],pid:str)->List[Action]:
        # Target anchors are tested against the contacts that are semantically
        # available to destination notation.  This preserves the relocation
        # actor-as-sole-target exception while excluding the acting P/Mᴾ when
        # other real contacts exist.
        out=[]
        for x in cands:
            if pid in self.effective_dest_contact_pids(x): out.append(x)
        return out

    def candidate_actions_touching_all(self,cands:List[Action],pids:Iterable[str])->List[Action]:
        pids=set(pids); out=[]
        for x in cands:
            cp=set(self.dest_contact_pids(x,exclude_actor_for_relocation=True))
            if pids<=cp: out.append(x)
        return out

    def choose_contact_subsets(self,branch:List[Action],others:List[str],auth_dest:Coord):
        """Return (unique subsets, fallback subsets with minimum survivors)."""
        # The empty other-contact set is the shortest possible description.
        # If the fixed target alone leaves exactly one legal landing, stop here:
        # every extra destination contact or locator is redundant noise.
        branch_dests={x.dest for x in branch}
        if auth_dest in branch_dests and len(branch_dests)==1:
            return [()],[]
        unique=[]
        for r in range(1,len(others)+1):
            for subp in combinations(others,r):
                filt=self.candidate_actions_touching_all(branch,subp)
                dests={x.dest for x in filt}
                if auth_dest in dests and len(dests)==1:
                    unique.append(tuple(subp))
            if unique: return unique,[]
        # no unique contact list: choose shortest subsets that minimize surviving dests (and actually reduce if possible)
        bestn=len({x.dest for x in branch}); best=[]
        for r in range(0,len(others)+1):
            cur=[]; minn=10**9
            subs=[()] if r==0 else combinations(others,r)
            for subp in subs:
                filt=self.candidate_actions_touching_all(branch,subp)
                dests={x.dest for x in filt}
                if auth_dest not in dests: continue
                n=len(dests)
                if n<minn: minn=n;cur=[tuple(subp)]
                elif n==minn: cur.append(tuple(subp))
            if minn<bestn:
                bestn=minn;best=cur
            # prefer shortest subset achieving current global minimum; keep looking only if later can reduce further
        if not best: best=[()]
        # keep minimum length among best with bestn
        ml=min(len(x) for x in best); best=[x for x in best if len(x)==ml]
        return [],best

    def branch_forms(self,a:Action,legal:List[Action],auth_contacts:List[str])->List[Form]:
        actor=self.actor_desc(a,legal); changed=self.changed_desc(a) if a.type=='relocation' else None
        base=self.action_base_candidates(a,legal)
        # Destination-description locators may not use the acting relocation
        # piece. The actor itself MAY still be the target anchor; it is only
        # forbidden as a locator or redundant additional contact.
        forbidden_dest_locator_bases={self.visual_pid(a.actor)} if a.type=='relocation' else set()
        def dest_desc(pid:str)->PieceDesc:
            return self.descriptor_for_piece(pid, forbidden_dest_locator_bases)
        def target_desc(pid:str)->PieceDesc:
            return self.target_descriptor_for_actions(pid,base,forbidden_dest_locator_bases)
        if a.type=='cover':
            # Immediate piece underneath destination before cover. Apply Stage-3
            # legality filtering before retaining any target locator.
            target=self.board.top(a.dest)
            return [Form('cover',actor,None,(target_desc(target.id),),power=a.power,anchor_pid=target.id)]
        forms=[]
        if not auth_contacts:
            return []
        # single-contact priority
        if len(auth_contacts)==1:
            t=auth_contacts[0]
            # First keep the ordinary single-contact candidate set: legal landings
            # whose effective destination-contact set is exactly this target.
            touching=self.candidate_actions_touching_pid(base,t)
            exact=[]
            for x in touching:
                if set(self.effective_dest_contact_pids(x))=={t}:
                    exact.append(x)

            # If the ordinary exact-single-contact branch already has multiple
            # candidate edges, positional resolution is already required; keep
            # that established candidate set.  The human-readability problem
            # arises specifically when target-alone would otherwise be emitted.
            exact_dests={x.dest for x in exact}
            branch=exact
            if len(exact_dests)==1:
                # SINGLE-CONTACT SUBSET READABILITY GUARD: if another legal
                # landing also touches the target but has additional contacts,
                # bare target notation is technically inclusive and can look
                # ambiguous to a human.  Include those superset landings solely
                # for positional N/F resolution so a reference is emitted.
                superset=[x for x in touching if set(self.effective_dest_contact_pids(x))!={t}]
                if superset:
                    branch=touching

            descs=(target_desc(t),)
            forms += self.resolve_positional(a,actor,changed,branch,t,descs)
            return forms
        # Multi-contact: each true target branch independently.
        for t in auth_contacts:
            branch=self.candidate_actions_touching_pid(base,t)
            if not branch: continue
            others=[p for p in auth_contacts if p!=t and not (a.type=='relocation' and p==a.actor)]
            uniq,fallback=self.choose_contact_subsets(branch,others,a.dest)
            if uniq:
                for subp in uniq:
                    ds=(target_desc(t),)+tuple(dest_desc(p) for p in subp)
                    forms.append(Form(a.type,actor,changed,ds,power=a.power,anchor_pid=t))
            else:
                for subp in fallback:
                    filt=self.candidate_actions_touching_all(branch,subp)
                    ds=(target_desc(t),)+tuple(dest_desc(p) for p in subp)
                    forms += self.resolve_positional(a,actor,changed,filt,t,ds)
        return forms

    def resolve_positional(self,a:Action,actor:PieceDesc,changed:Optional[PieceDesc],branch:List[Action],target_pid:str,contacts:Tuple[PieceDesc,...])->List[Form]:
        dests={x.dest for x in branch}
        if a.dest not in dests: return []
        if len(dests)==1:
            return [Form(a.type,actor,changed,contacts,power=a.power,anchor_pid=target_pid)]
        # opening I/O
        if len(self.board.first_two)>=2:
            if self.on_opening_line(a.dest):
                hits={d for d in dests if self.on_opening_line(d)}
                if hits=={a.dest}:
                    return [Form(a.type,actor,changed,contacts,('I',None),a.power,target_pid)]
            elif not self.board.opening_o_used:
                # [O] is the one-time opening symmetry break. It may collapse the mirror pair.
                return [Form(a.type,actor,changed,contacts,('O',None),a.power,target_pid)]
        # positional
        if len(dests)>=3:
            c=self.center_dest(dests)
            if c==a.dest:
                return [Form(a.type,actor,changed,contacts,('C',None),a.power,target_pid)]
        forms=[]
        for k,refpid in self.nf_for_authoritative(target_pid,dests,a.dest):
            forms.append(Form(a.type,actor,changed,contacts,(k,self.descriptor_for_piece(refpid)),a.power,target_pid))
        return forms

    def render_move(self,sm:SourceMove,a:Action,legal:List[Action])->Tuple[List[Form],Optional[str]]:
        # Relocation actor-target exception. The acting P/Mᴾ is normally
        # redundant destination information and is excluded whenever any other
        # true destination contact exists. If it is the SOLE physical contact,
        # however, it may serve as the target anchor (move 37 regression).
        physical_contacts=self.dest_contact_pids(a,exclude_actor_for_relocation=False)
        auth_contacts=self.effective_dest_contact_pids(a)
        if sm.turn == 1:
            forms=[Form('spawn',self.actor_desc(a,legal),None,(),power=a.power)]
        elif sm.turn == 2 and len(auth_contacts)==1:
            forms=[Form('spawn',self.actor_desc(a,legal),None,(self.descriptor_for_piece(auth_contacts[0]),),power=a.power,anchor_pid=auth_contacts[0])]
        else:
            forms=self.branch_forms(a,legal,auth_contacts)
        if not forms:
            return [], 'TARGET' if a.type=='relocation' and not auth_contacts else 'EDGE'
        # Stage-6 actor minimization.  A PRE-MOVE actor locator may be needed
        # to identify the actor initially, but later destination information can
        # make it redundant.  Remove it whenever the completed form with the
        # bare actor already matches exactly the authoritative legal action.
        minimized_actor_forms=[]
        for f in forms:
            if f.actor.contacts and f.action_type != 'spawn':
                bare=replace(f, actor=PieceDesc(f.actor.base))
                if f.action_type == 'cover':
                    # Cover notation names the occupied piece UNDER the actor,
                    # not an adjacent lifted-board destination contact.
                    matches=[]
                    for x in legal:
                        if x.type != 'cover' or x.power != f.power: continue
                        if x.actor not in self.board.spawned or self.visual_pid(x.actor) != bare.actor.base: continue
                        if not self.board.occupied(x.dest): continue
                        target_pid=self.board.top(x.dest).id
                        if f.contacts and not self.desc_matches_pid(f.contacts[0],target_pid): continue
                        matches.append(x)
                else:
                    matches=[x for x,_assigns in self.base_form_filter(bare,legal)]
                if len(matches)==1:
                    x=matches[0]
                    same=(x.type==a.type and x.actor==a.actor and x.changed==a.changed
                          and x.dest==a.dest and x.power==a.power)
                    if same:
                        f=bare
            minimized_actor_forms.append(f)
        forms=minimized_actor_forms

        # Destination target/contact locator minimization for completed forms
        # that need no positional qualifier.  Re-test the WHOLE contact set,
        # not the target descriptor in isolation.  If a parenthetical locator
        # can be replaced by the bare piece symbol and the completed notation
        # still matches exactly the authoritative legal action, the locator is
        # redundant.  (Qualified forms require qualifier-aware verification and
        # are left untouched here.)
        minimized_destination_forms=[]
        for f in forms:
            cur=f
            if cur.qualifier is None and cur.action_type!='cover':
                changed=True
                while changed:
                    changed=False
                    for i,d in enumerate(cur.contacts):
                        if not d.contacts:
                            continue
                        new_contacts=list(cur.contacts)
                        new_contacts[i]=PieceDesc(d.base)
                        bare=replace(cur,contacts=tuple(new_contacts))
                        matches=[x for x,_assigns in self.base_form_filter(bare,legal)]
                        if len(matches)==1:
                            x=matches[0]
                            same=(x.type==a.type and x.actor==a.actor and x.changed==a.changed
                                  and x.dest==a.dest and x.power==a.power)
                            if same:
                                cur=bare
                                changed=True
                                break
            minimized_destination_forms.append(cur)
        forms=minimized_destination_forms

        # de-dupe by text; branch physical identity can produce same notation
        uniq=[];seen=set()
        for f in forms:
            s=f.text()
            if s not in seen: seen.add(s);uniq.append(f)

        # Actor-locator minimality preference. All forms here describe the same
        # authoritative action. If any verified final form can use a bare actor,
        # locator-bearing actor forms are strictly less readable/minimal and lose.
        if any(not f.actor.contacts for f in uniq):
            uniq = [f for f in uniq if not f.actor.contacts]

        # Destination-contact readability preference. A parenthetical locator
        # inside a destination contact list is a fallback, not a preferred form.
        # If the same authoritative action has any valid final form whose
        # destination contacts are all bare piece symbols, discard final forms
        # that use parenthetical destination-contact locators. This lets extra
        # true contacts do the disambiguation before nested locators are used.
        has_locator_free_contacts = any(
            f.contacts and all(not d.contacts for d in f.contacts)
            for f in uniq
        )
        if has_locator_free_contacts:
            uniq = [f for f in uniq if all(not d.contacts for d in f.contacts)]

        # N/F readability preference: once legality, verification, and
        # minimization have produced otherwise valid final forms, Near wins
        # over Far.  This does not affect reference discovery or distance.
        has_near=any(f.qualifier and f.qualifier[0]=='N' for f in uniq)
        has_far=any(f.qualifier and f.qualifier[0]=='F' for f in uniq)
        if has_near and has_far:
            uniq=[f for f in uniq if not (f.qualifier and f.qualifier[0]=='F')]

        # GLOBAL DESTINATION-CONTACT MINIMALITY.  All surviving forms here
        # describe the same authoritative action and have already passed the
        # readability preferences above.  The form(s) using the fewest
        # destination contacts are strictly more minimal, even when they came
        # from different target branches.  Preserve ties; discard every form
        # with a larger destination-contact count.
        if uniq:
            min_contacts=min(len(f.contacts) for f in uniq)
            uniq=[f for f in uniq if len(f.contacts)==min_contacts]

        # FINAL DETERMINISTIC TIEBREAK. If every written rule above leaves
        # multiple equally canonical forms for the same authoritative action,
        # they are semantically indistinguishable. Choose the alphabetically
        # first rendered notation so translation is deterministic and emits
        # exactly one final form.
        if len(uniq) > 1:
            uniq=sorted(uniq,key=lambda f: f.text())[:1]

        return uniq,None

    def translate_moves(self,moves:List[SourceMove]):
        outputs=[]
        for sm in moves:
            dest,legal,matches=matching_authoritative_actions(self.board,sm)
            if len(matches)!=1:
                outputs.append((sm.turn,[],f'ACTION ({len(matches)} authoritative legal actions)'))
                break
            a=matches[0]
            forms,err=self.render_move(sm,a,legal)
            if err:
                outputs.append((sm.turn,[],err)); break
            outputs.append((sm.turn,[f.text() for f in forms],None))
            # track O when authoritative landing is first off-axis and emitted form uses O
            if any(f.qualifier and f.qualifier[0]=='O' for f in forms): self.board.opening_o_used=True
            self.board.apply_action(a,authoritative_piece_id=sm.piece if a.type=='spawn' else None)
        return outputs

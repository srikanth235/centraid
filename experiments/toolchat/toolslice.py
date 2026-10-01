"""The ontology slice, shared by the training export (scratchpad final/export.py) and
agent.py's `hf` mode, so the prompt at inference is byte-for-byte the training prefix.

A tool observation gets, prepended, one `[kind: …]` line for each row kind that
appears on one of its `#n kind "…"` lines for the FIRST time in the session, in
order of first appearance. Each kind's line is fixed (the builder derived it from
the ontology + the executor's EDGES; it came out identical in every training world).
"""
import re

SLICES = {
    'event': '[event: dtstart · links: parties]',
    'task': '[task: due_at, status (needs-action|in-process|completed|cancelled), effort_min · links: tasks]',
    'note': '[note: updated_at, notebooks]',
    'journal note': '[journal note: updated_at, notebooks]',
    'document': '[document: updated_at, folder]',
    'party': '[party: owed_to_me_minor (cents), owed_to_them_minor (cents), role · links: obligations, '
             'important dates, contact channels, activities, events, photos]',
    'member': '[member: owed_to_me_minor (cents), owed_to_them_minor (cents), role · links: obligations, '
              'important dates, contact channels, activities, events, photos]',
    'important date': '[important date: next_occurrence]',
    'contact channel': '[contact channel: kind (phone|email|address|handle), value]',
    'group': '[group: owes_me, i_owe (cents) · links: expenses, settlements, members]',
    'expense': '[expense: spent_on, amount_minor (cents), paid_by · links: groups]',
    'photo': '[photo: album_titles, favorite · links: places, albums, parties]',
    'locker item': '[locker item: type]',
    'album': '[album: · links: photos]',
    'activity': '[activity: started_at, kind (call|message|visit|coffee)]',
    'settlement': '[settlement: paid_on, amount_minor (cents)]',
    'obligation': '[obligation: · links: parties]',
    'place': '[place: · links: photos]',
    'transaction': '[transaction: direction (debit|credit)]',
}
HLINE = re.compile(r'^#(\d+) (.*)$')


class Slicer:
    """one per session"""
    def __init__(self):
        self.done = set()

    def kinds(self, obs):
        out = []
        for ln in obs.split('\n'):
            m = HLINE.match(ln)
            if m:
                out.append(m.group(2).split(' "')[0])
        return out

    def head(self, obs):
        new = []
        for kw in self.kinds(obs):
            if kw not in self.done:
                self.done.add(kw)
                if kw in SLICES:
                    new.append(SLICES[kw])
        return '\n'.join(new)

    def observe(self, obs):
        """the tool message content for this observation"""
        h = self.head(obs)
        return (h + '\n' + obs) if h else obs

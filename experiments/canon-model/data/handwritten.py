# -*- coding: utf-8 -*-
"""Hand-written `same?` rows.

`same?` is the one construct whose surface I could not realise honestly from
fragments: people ask it with a lot of prior context and almost never name both
sets in the sentence.  These forty rows are written turn by turn, each as a
FOLLOW-UP whose antecedent supplies the two sets the question compares.  The
cast is the synthetic one from literals.py.

GRAMMAR.md 1.1: an intersection over sets of UNRELATED KINDS is `clarify`,
never `no` — so most of these put a Tally member beside the parties an Agenda
event names, which is exactly the case the construct exists for.  The target
is still the `same?` turn; the declination is the executor's.

Each row: (previous canonical, what the member says, the canonical).
"""

ROWS = [
    # --- a Tally member beside the people on a diary row ---------------------
    ('show expenses of (groups called "Flat 7B") during last week',
     "hang on, is that the same Perpetua as my supper on Tuesday?",
     'same? (members called "Perpetua Blount") (parties of (events called "Tuesday supper"))'),
    ('show members of (groups called "Tuesday supper club")',
     "wait — is that the Ondrej from the rowing time trial?",
     'same? (members called "Ondrej Vasquez") (parties of (events called "Rowing time trial"))'),
    ('show expenses of (groups called "Rowing eight") during this month',
     "is the Kaz on that the same one who's coming to the choir call?",
     'same? (members called "Kaz Thirlwell") (parties of (events called "Choir committee call"))'),
    ('show members of (groups called "Allotment syndicate")',
     "sorry, which Ingrid is that — the one from the work morning?",
     'same? (members called "Ingrid Solvang") (parties of (events called "Allotment work morning"))'),
    ('show expenses of (groups called "Flat 7B")',
     "umm is that Bartholomew the same bloke as the one at the house meeting?",
     'same? (members called "Bartholomew Okiro") (parties of (events called "Flat 7B house meeting"))'),
    ('show members of (groups called "Book swap crew")',
     "is that the same Lucienne I'm seeing at the studio handover?",
     'same? (members called "Lucienne Farrow") (parties of (events called "Studio handover"))'),
    ('show expenses of (groups called "Office coffee fund") during this week',
     "same Teodor as the piano tuning one?",
     'same? (members called "Teodor Mazzanti") (parties of (events called "Piano tuning"))'),
    ('show members of (groups called "Choir committee")',
     "hold on — is Rhoswen there the Rhoswen from the vestry thing?",
     'same? (members called "Rhoswen Pike") (parties of (events called "Choir committee call"))'),

    # --- two rosters over the same table (parties vs members) ---------------
    ('show parties called "Anselm Drury"',
     "is that the same Anselm I split the ferry with?",
     'same? (it) (members called "Anselm Drury")'),
    ('show members called "Ottoline Krabbe"',
     "is she in my actual contacts, or just in the group?",
     'same? (it) (parties called "Ottoline Krabbe")'),
    ('show parties called "Fenwick Adeyemi"',
     "and is that the Fenwick who owes me for the grit?",
     'same? (it) (members called "Fenwick Adeyemi")'),
    ('show members of (groups called "Cycling splinter group")',
     "are any of those the people in my contacts called Josipa?",
     'same? (them) (parties called "Josipa Vrancic")'),
    ('show parties called "Sabela Montrose"',
     "same Sabela as the one in the allotment lot?",
     'same? (it) (members called "Sabela Montrose")'),
    ('show members called "Pelle Ingerson"',
     "is that a real contact of mine or just a name in a group?",
     'same? (it) (parties called "Pelle Ingerson")'),

    # --- a face in a photo beside a name in the diary -----------------------
    ('show parties of (photos called "Committee in the vestry")',
     "is that the same lot I'm seeing at the choir call?",
     'same? (them) (parties of (events called "Choir committee call"))'),
    ('show parties of (photos called "Boat shed at dawn")',
     "hang on, is that Wilhelmina the one from the time trial?",
     'same? (them) (parties called "Wilhelmina Drax")'),
    ('show photos of (albums called "Rowing season")',
     "are the people in those the same as the rowing eight?",
     'same? (parties of (photos of (albums called "Rowing season"))) (members of (groups called "Rowing eight"))'),
    ('show parties of (photos called "Amp in the back of the car")',
     "is that Casimir, the same Casimir I lent the amp to?",
     'same? (them) (parties called "Casimir Odum")'),

    # --- a task and an event that share a title -----------------------------
    ('show tasks called "Book the piano tuner"',
     "is that the same thing as the piano tuning in my diary?",
     'same? (it) (events called "Piano tuning")'),
    ('show tasks called "Chase the chimney sweep"',
     "wait — have I got that twice, once as a job and once in the calendar?",
     'same? (it) (events called "Chimney sweep visit")'),
    ('show events called "Boiler service"',
     "is that the same as the boiler thing on my list?",
     'same? (it) (tasks called "File the boiler warranty")'),
    ('show tasks called "Return the loaner amp"',
     "same as the drop-off in the diary?",
     'same? (it) (events called "Amp return drop-off"))'.replace("))", ")")),

    # --- a place and a group that share a name ------------------------------
    ('show places called "Skerrit Point"',
     "is that the same Skerrit Point as the weekend group?",
     'same? (it) (groups called "Skerrit Point weekend")'),
    ('show photos of (places called "Vellum Cove")',
     "is that spot the one the long weekend group is named after?",
     'same? (places called "Vellum Cove") (groups called "Vellum Cove long weekend")'),
    ('show groups called "Hollowgate ski week"',
     "and is that the Hollowgate in my photos?",
     'same? (it) (places called "Hollowgate")'),

    # --- a locker entry beside a document or a contact ----------------------
    ('show locker items called "Rowing club members area"',
     "is that login for the same club as the constitution I've got filed?",
     'same? (it) (documents called "Rowing club constitution")'),
    ('show locker items called "Boiler support login"',
     "same outfit as the warranty document?",
     'same? (it) (documents called "Boiler warranty 2026")'),
    ('show locker items called "Piano tuner booking account"',
     "is that the tuner I've got in my contacts?",
     'same? (it) (parties called "Emeric Tavistock"))'.replace("))", ")")),

    # --- deixis into an answer, with no name said at all --------------------
    ('show parties of (events called "Flat 7B house meeting")',
     "hang on, is that the same one?",
     'same? (them) (members of (groups called "Flat 7B"))'),
    ('show members of (groups called "Studio sublet")',
     "are those the same people as on the agreement?",
     'same? (them) (parties of (documents called "Studio sublet agreement"))'),
    ('show parties of (expenses called "Ferry crossing")',
     "is that who I think it is — the one from the crossing trip?",
     'same? (them) (members of (groups called "Stormcote Bay crossing"))'),
    ('show obligations of (parties called "Beatrix Nwankwo")',
     "and is that the same Beatrix that's in the supper club?",
     'same? (parties called "Beatrix Nwankwo") (members of (groups called "Tuesday supper club"))'),
    ('show contact channels of (parties called "Thaddeus Lomax")',
     "umm is that the same Thaddeus who paid for the seed potatoes?",
     'same? (parties called "Thaddeus Lomax") (parties of (expenses called "Seed potatoes"))'),
    ('show journal notes of (parties called "Solveig Brannigan")',
     "is that the Solveig from the walking trip?",
     'same? (parties called "Solveig Brannigan") (members of (groups called "Cairnmuir walking trip"))'),
    ('show activities of (parties called "Philippa Ruzicka")',
     "sorry — same Philippa as the one in the rota?",
     'same? (parties called "Philippa Ruzicka") (members of (groups called "Choir committee"))'),
    ('show important dates of (parties called "Cornelius Baptiste")',
     "is that the same Cornelius I share the allotment with?",
     'same? (parties called "Cornelius Baptiste") (members of (groups called "Allotment syndicate"))'),
    ('show tasks of (parties called "Antonina Feld")',
     "hang on — same Antonina as the one at the handover?",
     'same? (parties called "Antonina Feld") (parties of (events called "Studio handover"))'),
    ('show notes of (parties called "Leontine Haverkamp")',
     "is that her, the one from the book swap?",
     'same? (parties called "Leontine Haverkamp") (members of (groups called "Book swap crew"))'),
    ('show expenses of (members called "Oswin Pertwee")',
     "right, and is that the Oswin who's coming to the work morning?",
     'same? (members called "Oswin Pertwee") (parties of (events called "Allotment work morning"))'),
    ('show settlements of (groups called "Flat 7B")',
     "are those between the same two as the ones in my contacts called Radomir?",
     'same? (parties of (settlements of (groups called "Flat 7B"))) (parties called "Radomir Selk")'),
]

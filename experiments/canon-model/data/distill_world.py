# -*- coding: utf-8 -*-
"""The SECOND synthetic world.

`train.jsonl` is instantiated over the literals in `literals.py`; the eval
corpora are instantiated over a third cast this module has never seen and must
never see.  Distillation rows are instantiated over the cast below, so a
paraphrase corpus cannot teach a model the names of either other world.

Every name, title, place and date here is invented for this file.  The mapping
is 1:1 and deterministic, so a canonical and its previous canonical stay
consistent inside a session.
"""
import datetime as _dt
import re

import literals as L

# --- the cast ---------------------------------------------------------------

FIRST = [
    "Marisol", "Dagfinn", "Oyelaran", "Petronella", "Haruki", "Zivile",
    "Bertrand", "Nkechi", "Solveig", "Emeric", "Tamsin", "Ruslan",
    "Aoife", "Kwabena", "Isolde", "Matthias", "Yerlan", "Philippa",
    "Cosimo", "Adaeze", "Hrafn", "Beatriu", "Sandor", "Nuala",
    "Thaddeus", "Mireille", "Obinna", "Linnea", "Arvydas", "Ottilie",
    "Rashida", "Gundula", "Ferran", "Chidubem", "Sunniva", "Lorcan",
    "Valentina", "Eamonn", "Zsofia", "Babajide", "Rosalind", "Anselm",
    "Keturah", "Drazen", "Meropi", "Ulrike", "Tobias", "Amarachi",
    "Sigrun", "Casimir", "Delphine", "Nikodem", "Yusra", "Guthrie",
    "Fenella", "Osvaldo", "Bronwen", "Ilkka", "Temperance", "Jaromir",
]
LAST = [
    "Brackenridge", "Ostrowska", "Adeyinka", "Vandermeer", "Tsukahara",
    "Kazlauskas", "Lefevre", "Onyekwere", "Haugland", "Szabolcs",
    "Penhallow", "Voronin", "Kinsella", "Mensah", "Wolstenholme",
    "Steinhauer", "Zhumabek", "Cartwright", "Bellandini", "Chukwuma",
    "Skarsgard", "Montserrat", "Karolyi", "Fitzmaurice", "Radcliffe",
    "Beauchamp", "Nwachukwu", "Lindqvist", "Pranauskas", "Hollingworth",
    "Bensalem", "Reinhardt", "Puigdemont", "Okonjo", "Lindholm",
    "Tremayne", "Castellanos", "Donnelly", "Halasz", "Olatunji",
    "Fairweather", "Achterberg", "Massoud", "Petrovic", "Stavrakis",
    "Klingbeil", "Marchetti", "Ezenwa", "Ingvarsdottir", "Zielinski",
    "Rochefort", "Wisniewski", "Al-Bakri", "Pemberton", "Trelawney",
    "Quintanilla", "Aberforth", "Juntunen", "Sedgemoor", "Havlicek",
]
PEOPLE = ["%s %s" % (FIRST[i], LAST[i]) for i in range(60)]

PLACES = [
    "Wrackmere Spit", "Dunlaggan Fell", "Copperhaugh", "Nine Elms Cut",
    "Saltbarrow Point", "Merrowgate Sands", "Fairlight Brow", "Tanner's Gill",
    "Kestrel Hollow", "Bramblewick Quay", "Stonemoor Edge", "Cinderbeck",
    "Havershaw Bay", "Linnet Carr", "Owlsworth Hill", "Maple Drift",
    "Ravensgarth", "Pennywhistle Lane", "Gorsecombe", "Applerow Wharf",
    "Silverloe Marsh", "Brightwater Ford", "Cloudsley Down", "Netherby Tarn",
    "Harrowvale", "Thistledown Green", "Marlbrook Weir", "Vaneport Steps",
    "Elderfold Wood", "Corvine Crag",
]
GROUPS = [
    "Unit 14C", "Thursday curry night", "Badminton four", "Orchard co-op",
    "Cheese club", "Workshop sublet", "Ceilidh band fund", "Beach hut share",
    "Pottery kiln crew", "Gardening rota",
]
TRIPS = [
    "Wrackmere Spit weekend", "Dunlaggan ski week", "Saltbarrow reunion",
    "Kestrel Hollow walking trip", "Havershaw Bay long weekend",
    "Marlbrook road trip", "Cinderbeck cottage break", "Linnet Carr retreat",
    "Ravensgarth New Year", "Gorsecombe cycling tour",
]
TASK_TITLES = [
    "Reseal the bathroom window", "Chase the gutter cleaner",
    "File the washing machine guarantee", "Plane the back door",
    "Replace the carbon monoxide alarm", "Take the borrowed trailer back",
    "Order a new kiln shelf", "Book the bike service",
    "Photograph the meter reading", "Write up the co-op minutes",
]
EVENT_TITLES = [
    "Gutter cleaning visit", "Washing machine repair", "Cello lesson",
    "Badminton ladder night", "Orchard co-op call", "Kiln firing morning",
    "Dentist check-up", "Trailer pick-up", "Ceilidh rehearsal",
    "Meter reader appointment",
]
NOTE_TITLES = [
    "Questions for the gutter man", "Window sealing method",
    "Kiln schedules that worked", "Orchard grafting order",
    "What the cello teacher said", "Sublet handover list",
    "Badminton ladder rules", "Bread recipe that finally worked",
    "Stuff to price up for the workshop", "Where the stopcock is",
]
DOC_TITLES = [
    "Washing machine guarantee 2027", "Workshop sublet agreement",
    "Badminton club constitution", "Orchard plot plan",
    "Borrowed trailer receipt", "Unit 14C inventory",
    "Kiln safety certificate", "Bike service history",
    "Meter reading log", "Co-op accounts summary",
]
PHOTO_TITLES = [
    "Terns over the cut", "Ice on the water butt", "Kiln shed at dusk",
    "The mended sill", "Co-op in the barn", "Cello in the hallway",
    "Frost on the orchard gate", "Trailer loaded up",
]
ALBUM_TITLES = [
    "Wrackmere Spit weekend", "Orchard year", "Badminton season",
    "Workshop rebuild", "Dunlaggan snow", "Kitchen before and after",
]
LOCKER_TITLES = [
    "Orchard co-op portal", "Badminton club members area",
    "Washing machine support login", "Workshop gate code",
    "Ceilidh booking site", "Cello teacher payment account",
]
NOTEBOOKS = ["Home", "Co-op", "Workshop", "Orchard"]
FOLDERS = ["House", "Club papers", "Workshop", "Orchard"]
CATEGORIES = ["groceries", "transport", "utilities", "supplies", "fees"]
EXPENSES = [
    "Bark chip for the beds", "Bus fares", "New drum belt",
    "Kiln shelf levy", "Onion sets", "Minutes photocopying",
]
DATELABELS = ["anniversary", "name day", "moving-in day", "graduation",
              "first met"]
CHANNELS = ["07700 900871", "07700 900204", "post@example.invalid",
            "9 Cinderbeck Row"]
ACTIVITIES = ["call", "visit", "message", "coffee"]
REASONS = ["bus fares", "coach ticket", "shared bark chip",
           "spare fob programming", "kiln shelf levy"]
USERNAMES = ["m.brackenridge", "d.ostrowska", "haru.t", "solveig.h",
             "n.adeyinka", "petronella", "emeric.s", "tamsin.k"]
MONTHDAYS = ["01-22", "02-08", "03-30", "04-17", "05-05", "06-28",
             "08-19", "09-03", "10-26", "11-14", "12-21"]

# --- the date shift ---------------------------------------------------------
# The first world sits in June 2026; this one sits eight months later, so no
# absolute date is shared either.
SHIFT = 243


def _shift(day):
    return (_dt.date.fromisoformat(day) + _dt.timedelta(days=SHIFT)).isoformat()


def _build():
    pairs = {}

    def zip_map(old, new):
        for index, value in enumerate(old):
            pairs[value] = new[index % len(new)]

    zip_map(L.PEOPLE, PEOPLE)
    for index, person in enumerate(L.PEOPLE):
        pairs[person.split()[0]] = PEOPLE[index].split()[0]
    zip_map(L.PLACES, PLACES)
    zip_map(L.GROUPS, GROUPS)
    zip_map(L.TRIPS, TRIPS)
    zip_map(L.TASK_TITLES, TASK_TITLES)
    zip_map(L.EVENT_TITLES, EVENT_TITLES)
    zip_map(L.NOTE_TITLES, NOTE_TITLES)
    zip_map(L.DOC_TITLES, DOC_TITLES)
    zip_map(L.PHOTO_TITLES, PHOTO_TITLES)
    zip_map(L.ALBUM_TITLES, ALBUM_TITLES)
    zip_map(L.LOCKER_TITLES, LOCKER_TITLES)
    zip_map(L.NOTEBOOKS, NOTEBOOKS)
    zip_map(L.FOLDERS, FOLDERS)
    zip_map(["Grit for the path", "Ferry crossing", "New kettle element",
             "Boat shed levy", "Seed potatoes", "Rota printing"], EXPENSES)
    zip_map(["07700 900412", "07700 900318", "hello@example.invalid",
             "14 Skerrit Row"], CHANNELS)
    zip_map(["train fare", "ferry ticket", "shared grit",
             "spare key cutting", "boat shed levy"], REASONS)
    zip_map(["o.vasquez", "p.blount", "kaz.t", "ingrid.s", "b.okiro",
             "lucienne", "teo.m", "rhoswen.p"], USERNAMES)
    zip_map(["01-09", "02-23", "03-14", "04-02", "05-30", "07-18",
             "08-07", "09-25", "10-11", "11-29", "12-06"], MONTHDAYS)
    # check-in / check-out are grammar furniture (the anchored window), not a
    # name: they stay.
    for keep in ("check-in", "check-out"):
        pairs[keep] = keep
    return pairs


MAP = _build()

_LIT = re.compile(r'"([^"]*)"')
_DATE = re.compile(r"\b(2026-\d{2}-\d{2})(T\d{2}:\d{2})?(\.\.(2026-\d{2}-\d{2}))?\b")
_MONTH = re.compile(r"(?<![-\d])2026-(0[1-9]|1[0-2])(?![-\d:])")


def _lit(match):
    value = match.group(1)
    return '"%s"' % MAP.get(value, value)


def _date(match):
    out = _shift(match.group(1)) + (match.group(2) or "")
    if match.group(4):
        out += ".." + _shift(match.group(4))
    return out


def _month(match):
    day = _dt.date.fromisoformat("%s-15" % match.group(0)) + \
        _dt.timedelta(days=SHIFT)
    return day.strftime("%Y-%m")


def reworld(text):
    """Re-instantiate a canonical over the second world."""
    text = _LIT.sub(_lit, text)
    text = _DATE.sub(_date, text)
    text = _MONTH.sub(_month, text)
    return text

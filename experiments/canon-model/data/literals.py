"""Synthetic literal vocabulary for the canon-model training corpus.

Nothing in here is drawn from the evaluation corpora or from any real world.
Every name, place, trip, title and amount below was invented for this file.
The world's day is Monday 2026-06-15 (the published calendar convention);
dates are chosen relative to it.
"""

# --- people -----------------------------------------------------------------
# 60 invented full names.  Deliberately unlike anything a personal-vault demo
# would reach for; no name from the banned list, and no first name shared with
# one.
PEOPLE = [
    "Ondrej Vasquez", "Perpetua Blount", "Kaz Thirlwell", "Ingrid Solvang",
    "Bartholomew Okiro", "Lucienne Farrow", "Teodor Mazzanti", "Rhoswen Pike",
    "Anselm Drury", "Ottoline Krabbe", "Fenwick Adeyemi", "Josipa Vrancic",
    "Hieronymus Quill", "Sabela Montrose", "Pelle Ingerson", "Wilhelmina Drax",
    "Casimir Odum", "Beatrix Nwankwo", "Thaddeus Lomax", "Solveig Brannigan",
    "Emeric Tavistock", "Philippa Ruzicka", "Cornelius Baptiste", "Antonina Feld",
    "Leontine Haverkamp", "Oswin Pertwee", "Marguerite Ashby-Vale", "Radomir Selk",
    "Clementina Ford", "Aurelio Banning", "Hedwig Thorne", "Mattias Verhoeven",
    "Rosalind Crake", "Gideon Applewhite", "Xiomara Petrov", "Nikolaj Brandt",
    "Evangeline Oduya", "Ferdinand Klasse", "Aoibheann Marchetti", "Hilbert Sang",
    "Zorica Newlands", "Augustin Peary", "Delphine Okonkwo", "Roderic Hallmark",
    "Serafina Bracken", "Ludovic Ostrander", "Petronella Sway", "Emlyn Carbajal",
    "Bronislava Keene", "Alaric Fenn", "Imogene Stroud", "Vasily Redgrove",
    "Cressida Malouf", "Osvaldo Pinner", "Theodora Lindqvist", "Barnaby Osei",
    "Griselda Vance", "Matteus Ahlgren", "Coralie Winterbourne", "Dashiell Prout",
]

# The first name is what a member actually says out loud.
FIRST_NAMES = [name.split()[0] for name in PEOPLE]

# --- places -----------------------------------------------------------------
PLACES = [
    "Skerrit Point", "Thornwell Basin", "Pallas Head", "Ivory Reach",
    "Cold Marrow Ridge", "Fenwater Sands", "Hollowgate", "Bracken Spit",
    "Quiltern Falls", "Arrowsmith Bluff", "Lantern Rock", "Wraithmoor",
    "Saltcombe Narrows", "Peregrine Steps", "Kestrel Shelf", "Underhay",
    "Vellum Cove", "Shrike Hollow", "Cairnmuir", "Gullhaven Pier",
    "Osprey Flats", "Birchmere Landing", "Tessellate Gardens", "Nettlebed Quay",
    "Amberline Junction", "Cloudwhistle Pass", "Farrowdeep", "Quintal Harbourless",
    "Stormcote Bay", "Wicklow Salt Flats",
]

# --- trips and groups -------------------------------------------------------
TRIPS = [
    "Skerrit Point weekend", "Hollowgate ski week", "Pallas Head reunion",
    "Cairnmuir walking trip", "Vellum Cove long weekend", "Amberline road trip",
    "Nettlebed summer house", "Wraithmoor birthday trip", "Stormcote Bay crossing",
    "Quiltern Falls hike",
]
GROUPS = [
    "Flat 7B", "Tuesday supper club", "Rowing eight", "Allotment syndicate",
    "Book swap crew", "Studio sublet", "Choir committee", "Cycling splinter group",
    "The Wednesday lot", "Office coffee fund",
]

# --- titles -----------------------------------------------------------------
TASK_TITLES = [
    "Re-grout the shower", "Chase the chimney sweep", "File the boiler warranty",
    "Sand the hall door", "Swap the smoke alarm batteries", "Return the loaner amp",
    "Book the piano tuner", "Descale the kettle", "Cancel the magazine standing order",
    "Reglaze the greenhouse pane",
]
EVENT_TITLES = [
    "Chimney sweep visit", "Boiler service", "Piano tuning", "Rowing time trial",
    "Choir committee call", "Allotment work morning", "Studio handover",
    "Amp return drop-off", "Flat 7B house meeting", "Glasses refit appointment",
]
DOC_TITLES = [
    "Boiler warranty 2026", "Studio sublet agreement", "Rowing club constitution",
    "Allotment plot map", "Loaner amp receipt", "Flat 7B inventory",
    "Greenhouse glazing quote", "Chimney survey report", "Piano appraisal",
    "Kettle descaling guide",
]
NOTE_TITLES = [
    "Things to ask the sweep", "Shower regrout method", "Amp settings that worked",
    "Allotment sowing order", "What the tuner said", "Sublet handover checklist",
    "Ideas for the choir programme", "Rowing split targets",
    "Greenhouse pane measurements", "Boiler fault codes",
]
ALBUM_TITLES = [
    "Skerrit Point weekend", "Allotment year", "Rowing season", "Greenhouse rebuild",
    "Hollowgate snow", "Studio before and after",
]
PHOTO_TITLES = [
    "Gulls over the spit", "Frost on the cold frame", "Boat shed at dawn",
    "The repaired pane", "Committee in the vestry", "Amp in the back of the car",
]
LOCKER_TITLES = [
    "Allotment society portal", "Rowing club members area", "Boiler support login",
    "Studio door code", "Choir rota site", "Piano tuner booking account",
]
FOLDERS = ["Household", "Club papers", "Studio", "Allotment"]
NOTEBOOKS = ["Household", "Club", "Making", "Garden"]
CATEGORIES = ["groceries", "transport", "utilities", "supplies", "fees"]

TITLES = (TASK_TITLES + EVENT_TITLES + DOC_TITLES + NOTE_TITLES
          + ALBUM_TITLES + PHOTO_TITLES + LOCKER_TITLES)

# --- numbers, money, time ---------------------------------------------------
AMOUNTS_MINOR = [450, 1200, 1875, 2400, 3150, 4000, 5225, 6800, 9950, 12500]
AMOUNTS_MAJOR = ["4.50", "12.00", "18.75", "24.00", "31.50", "40.00",
                 "52.25", "68.00", "99.50", "125.00"]
SMALL_NUMS = [1, 2, 3, 4, 5]
EFFORTS = [15, 30, 45, 60, 90, 120]
CADENCES = [7, 14, 30, 60, 90]

# --- dates, relative to Monday 2026-06-15 -----------------------------------
DATES = [
    "2026-06-11", "2026-06-12", "2026-06-14", "2026-06-15", "2026-06-16",
    "2026-06-17", "2026-06-18", "2026-06-19", "2026-06-20", "2026-06-23",
    "2026-06-25", "2026-06-30", "2026-07-02", "2026-07-09", "2026-05-28",
]
DATETIMES = [
    "2026-06-16T09:00", "2026-06-17T14:30", "2026-06-18T18:00",
    "2026-06-19T11:15", "2026-06-23T08:45", "2026-06-25T19:30",
]
MONTHS = ["2026-04", "2026-05", "2026-06", "2026-07"]
RANGES = ["2026-06-16..2026-06-19", "2026-06-20..2026-06-21",
          "2026-06-22..2026-06-28", "2026-07-01..2026-07-05"]
DURATIONS = ["+1d", "+2d", "+1h", "-1h", "+30m", "+7d"]

# Weekday word -> the date it resolves to in the world of 2026-06-15.
WEEKDAYS = {
    "Monday": "2026-06-15", "Tuesday": "2026-06-16", "Wednesday": "2026-06-17",
    "Thursday": "2026-06-18", "Friday": "2026-06-19", "Saturday": "2026-06-20",
    "Sunday": "2026-06-21",
}

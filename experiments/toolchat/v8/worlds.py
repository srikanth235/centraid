#!/usr/bin/env python3
"""v8 synthetic TRAINING vault worlds, seeded through the vault's command plane.

    python3 worlds.py --n 40 --out v8/worlds/            # w01.json … w40.json
    python3 worlds.py --n 40 --out v8/worlds/ --verify   # also build + probe each
    python3 worlds.py --n 40 --stats                     # vocabulary spread only

Each world is a spec for `tool-loop serve --world spec:<file>`
(crates/candidates/src/bin/tool-loop.rs `training_world`): `{"now_ms", "seed",
"writes"}`, every write a real command (`{"cmd", "body", "as"}`), a canonical
line (`{"canon"}`, used for locker items so the seat seals the content), or a
field-door read (`{"field": [entity, id, column], "as"}`, used to learn the
place a photograph's coordinates minted so it can be named). `meta` is ignored
by tool-loop and is the manifest trajectory generation reads.

Why v8 (after v7's 16 worlds): a model trained on v7 memorised the worlds'
vocabulary (it rewrote "Tahoe" as "Taxes"), so here recall is made useless:

  * 40 households, each with its own "now", home region (coordinates, currency,
    phone format), cast, places, trips, groups and themes.
  * Every keyword is drawn from a large pool through one ALLOCATOR shared by the
    worlds in order: least-used first, capped (names, places, themes, trips:
    3 worlds; ordinary title nouns and activities: 4), so no keyword is a
    constant of the training set. The pools mix real names and places from many
    cultures (~40%), ordinary nouns (~30%), and rare or invented words (~30%:
    odd hobbies and a syllable generator — "Vrellow Cove").
  * Every pool word is checked against the evaluation corpora's vocabulary
    (crates/evalsuite/*.json, as v7/subnames.py reads it) and the pools5
    forbidden check (`P5.bad_token`, the distillation world's labels); nothing
    from an evaluation world is drawn, and every string in a spec is re-checked.
  * Every skill has material in every world (see `verify` for the probes), and
    ambiguity is planted on purpose: shared first names, two events and two
    tasks sharing a keyword, a trashed row whose keyword only matches in the
    trash, locker items sharing a keyword with other kinds.

Two keys beyond a plain command, both honoured by tool-loop's `training_world`:
  * `"at": ISO` on every write that creates a row (and on most later changes):
    the seeding clock for that write alone. Creations are spread over the
    world's past (people years ago, a task days before its due date, an event
    before it starts, a photo shortly after it was captured); a later change
    (complete, trash, settle, star, add to an album) is always after the
    creation of every row it names — `Spec.when` enforces it. A write with no
    `at` runs at `now`.
  * `"faces": ["$pNN.party_id", …]` on a `media.add_asset` write — the people
    whose faces are in the frame, so `photos of (#person)` has rows.

Deterministic from --seed (worlds are built in order; the allocator is shared).
"""
import argparse
import datetime as dt
import json
import os
import random
import re
import subprocess
import sys
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(HERE, "..", "v5"))
sys.path.insert(0, os.path.join(HERE, "..", "v7"))
import pools5 as P5  # noqa: E402  (also puts v3/ on the path)
import vault as V  # noqa: E402
import subnames as SN  # noqa: E402  (REAL_FIRST/REAL_LAST/REAL_PLACES/NOUNS, eval_vocab, PROTECT)

# ---------------------------------------------------------------------------
# v8 pools (every entry filtered below: eval vocabulary, forbidden tokens)
# ---------------------------------------------------------------------------

EXTRA_FIRST = """
Abena Adwoa Akosua Kojo Yaw Efe Ifeoma Nkechi Chinwe Temitope Yetunde Babatunde Kunle Olumide Uchenna Obinna
Tendai Tariro Rudo Farai Sipho Lindiwe Bongani Zanele Themba Nomvula Wambui Njeri Kamau Otieno Achieng Tesfaye
Selam Hiwot Mekdes Ayaan Hodan Aarti Bhavna Chetan Deepika Ganesh Harshita Ishaan Jyoti Kavitha Lakshmi Madhav
Nandini Omkar Pallavi Rohit Sanjana Tanvi Umesh Yamini Anjali Farhan Rukhsana Tahmina Shafiq Nirmala Senthil
Meenakshi Dilani Kasun Nuwan Ruwani Akiko Daisuke Emiko Kazuo Mayumi Noriko Ryota Sachiko Takeshi Meilin Xinyi
Yufei Zhen Hyejin Jiwoo Minseo Seojun Taeyang Yejin Huong Linh Minh Thanh Quang Maricel Rhodora Jomar Arnel
Luzviminda Somchai Kanya Niran Wulan Budi Ketut Hemi Mereana Tamati Rawiri Losa Sefo Keoni Leilani Aylin Burak
Cemre Emre Gulsen Hakan Kerem Nesrin Ozan Selin Tugba Ardeshir Bahareh Dariush Farnaz Golnar Kourosh Mahsa
Parisa Anwar Bushra Fadi Ghada Hisham Jamila Khalil Mounir Nour Rania Samir Widad Avital Eliyahu Shira Yael
Oren Anastasios Chrysanthi Dimitra Evangelos Kalliope Leonidas Panagiota Spyros Vasiliki Dragana Snezana Zoran
Bozena Dariusz Grazyna Jadwiga Malgorzata Przemek Wojciech Blanka Jirina Libor Vaclav Zdenka Bence Csilla
Laszlo Reka Zsofia Anatoly Lyudmila Nadezhda Oksana Svetlana Taras Vadim Yaroslava Zinaida Aivars Egle Tonu
Kadri Almudena Benicio Consuelo Dolores Esteban Fermin Guadalupe Jimena Leandro Macarena Nicanor Rigoberto
Soledad Xochitl Yesenia Anselmo Itzel Emiliano Afonso Conceicao Gilberto Heloisa Iara Leonor Moacir Rosalina
Vanderlei Ubirajara Bastien Cecile Etienne Fabrice Gaelle Jerome Laetitia Mathilde Noemie Remi Sandrine
Thierry Yvette Alessandra Beppe Carlotta Donatella Emanuele Fiorella Giacomo Ludovica Massimo Ornella Pietro
Raffaella Salvatore Tiziana Vittorio Cosimo Benedetta Annelie Bernd Dieter Elke Friedrich Jurgen Karsten
Matthias Ulrike Wolfgang Daan Femke Joost Maartje Pieter Sanne Wouter Luuk Frode Gudrun Haldor Kjell Maren
Njal Oddny Sigrun Ylva Aino Eino Kaisa Lauri Minna Riikka Tuomas Veikko Angharad Bethan Gethin Iestyn Llinos
Meinir Sioned Bronagh Ciaran Declan Fionnuala Grainne Padraig Tadhg Callum Euan Fraser Morag Rhona Struan
Clemency Digby Edwina Hattie Ivor Jemima Lionel Marjorie Neville Prudence Reginald Sybil Verity Agatha
""".split()

EXTRA_LAST = """
Chukwu Eze Nwosu Okeke Asante Boateng Mensah Owusu Appiah Kariuki Mwangi Njoroge Odhiambo Wanjala Tadesse
Bekele Girma Abdi Dlamini Khumalo Ndlovu Nkosi Mokoena Moyo Chikwanha Acharya Banerjee Deshpande Gokhale Iyer
Joshi Menon Nair Pillai Reddy Trivedi Venkatesan Bhattacharya Chowdhury Hossain Siddiqui Qureshi Jayasuriya
Perera Wickramasinghe Subramaniam Krishnan Aoki Hayashi Ishikawa Kobayashi Matsuda Nishimura Ogawa Sakamoto
Ueda Yoshida Huang Liang Tang Zhang Guo Choi Jung Kang Yoon Nguyen Tran Pham Hoang Dang Bautista Macapagal
Wongsakul Srisai Wibowo Setiawan Kusuma Ngata Parata Tuilagi Faleolo Kahananui Akana Aksoy Celik Demir Kaya
Ozturk Sahin Yildiz Arslan Abboud Bishara Darwish Farouk Ghanem Hamdan Jaber Khoury Mansour Nasser Saleh Tawfik
Zaki Ahmadi Behzadi Farahani Ghorbani Karimi Rahimi Sadeghi Tehrani Katz Mizrahi Peretz Shapiro Antonopoulos
Christodoulou Georgiou Karagiannis Papadakis Stavrou Vlachos Markovic Nikolic Adamczyk Borkowski Czarnecki
Grabowski Krawczyk Mazur Nowicki Pawlak Sikora Wozniak Dvorak Horak Kucera Prochazka Svoboda Balogh Farkas
Kovacs Nagy Toth Belova Fedorov Ivanenko Kovalenko Lebedev Morozova Orlov Shevchenko Volkov Zhukova Berzins
Kalnins Jankauskas Tamm Saar Aguilar Barrios Cordero Echeverria Fuentes Gallardo Iglesias Montoya Ocampo
Quiroga Rivas Solis Trujillo Zapata Albuquerque Barbosa Figueiredo Magalhaes Teixeira Valadares Brandao Aubert
Beaulieu Chevalier Fournier Gauthier Lefebvre Marchand Perrin Rousseau Thibodeau Vasseur Boucher Leclerc
Mercier Albanese Bellucci Caruso Fabbri Galli Mancini Ricci Santoro Tedesco Vitale Zanetti Colombo Brandauer
Dietrich Eichhorn Feuerstein Grunewald Hoffstetter Kranz Lindemann Oberhauser Pfeiffer Schwarzkopf Tiedemann
Vogelsang Bakker Hoekstra Jansen Kuipers Meijer Visser Brouwer Aasen Bakke Ekstrom Fjeld Grondahl Haugland
Isaksen Jokinen Korhonen Lehtonen Mattila Sandvik Tveit Virtanen Wikstrom Arnarsson Breathnach Cairncross
Farquharson Guthrie Lamont Munro Sinclair Pryce Llewellyn Gwynne Vaughan Bevan Ashbury Carrow Drinkwater
Goodenough Hatherley Lightfoot Nettleship Oldroyd Pennyfeather Rowntree Sowerby Braddock Cheetham Durrant
Entwistle Fitchett Garside Inchbald Jowett Lamplugh Mossop Ormerod Pickersgill Scrivener Tunnicliffe Uttley
Vosper
""".split()

# trip destinations, beyond SN.REAL_PLACES (mostly British and European)
WORLD_DESTS = """
Oaxaca Zanzibar Essaouira Chefchaouen Lamu Jinja Swakopmund Knysna Hermanus Pondicherry Hampi Munnar Galle
Kandy Dalat Kampot Ubud Siargao Takayama Hakone Kanazawa Onomichi Gyeongju Jeonju Yangshuo Hokitika Kaikoura
Raglan Noosa Tofino Lunenburg Taos Marfa Cusco Paraty Olinda Valparaiso Mompox Bacalar Cartagena Salento
Byblos Plovdiv Nafplio Hydra Tbilisi Kazbegi Samarkand Bukhara Ljubljana Bled Piran Visby Ystad Aarhus Husavik
Akureyri Tromsdalen Bergamo Trieste Mantua Ferrara Sibiu Brasov Kalambaka Monemvasia Gjirokaster Berat Budva
Trogir Opatija Bohinj Kotka Porvoo Turku Gdansk Torun Olomouc Telc Eger Pecs Kaunas Tartu Cuenca Ayacucho
Arequipa Sucre Chiloe Ushuaia Bariloche Colonia Pirenopolis Tiradentes Ouro Merida Campeche Valladolid Puebla
Antigua Granada Leon Rotorua Wanaka Dunedin Hobart Broome Margaret Esperance Fremantle Queenstown
""".split()

PLACE_TYPES = ["Cove", "Quay", "Market", "Gardens", "Heath", "Point", "Ridge", "Lane", "Square", "Falls", "Pier",
               "Mill", "Hollow", "Wharf", "Terrace", "Marsh", "Springs", "Crossing", "Arcade", "Row", "Fields",
               "Sands", "Lido", "Common", "Reservoir", "Yard", "Green", "Brook", "Cliffs", "Dunes", "Wood",
               "Harbour", "Hill", "Rise", "Steps", "Walk", "Downs", "Bridge", "Island", "Lighthouse", "Viewpoint",
               "Quarry", "Orchard", "Moor", "Pool", "Gorge", "Headland", "Jetty", "Meadows", "Pavilion"]
VENUE_T = ["Cafe {P}", "Café {P}", "{P} Bakery", "{P} Library", "{P} Lido", "{P} Community Hall", "{P} Deli",
           "The {N} and {N2}", "The Old {N}", "{P} Leisure Centre", "{P} Allotments", "{P} Tearooms",
           "{P} Food Hall", "{P} Garden Centre", "{P} Climbing Wall", "{P} Arts Centre"]

# rare / odd pastimes: themes (single words) and activities
HOBBIES = """
falconry marquetry bookbinding kintsugi lacemaking orienteering bouldering beekeeping calligraphy letterpress
bonsai origami macrame tatting glassblowing blacksmithing stargazing birding foraging whittling quilting
canyoning geocaching kombucha kefir petanque croquet kabaddi capoeira tango flamenco ikebana batik raku shibori
taiko gamelan didgeridoo bagpipes theremin harpsichord dulcimer sitar tabla oud koto shamisen fencing curling
hurling lacrosse korfball bocce mahjong backgammon crochet embroidery weaving felting woodturning bushcraft
paragliding snorkelling freediving longboarding unicycling juggling ventriloquism puppetry cartography
astrophotography mycology entomology genealogy numismatics philately horology spinning candlemaking soapmaking
cheesemaking pickling brewing mead sourdough fermenting archery sculling kitesurfing windsurfing bodyboarding
coasteering caving abseiling skijoring snowshoeing handball squash badminton pickleball racquetball netball
bowls darts snooker billiards chess draughts cribbage bridge canasta rummy dominoes shogi xiangqi carrom
harmonica accordion banjo mandolin ukulele cello viola oboe bassoon trombone euphonium marimba steelpan
""".split()

ROLES8 = sorted(set(P5.ROLES + [
    "Tutor", "Coach", "Surveyor", "Architect", "Midwife", "Barber", "Locksmith", "Tailor", "Beekeeper",
    "Chiropodist", "Decorator", "Tiler", "Joiner", "Glazier", "Farrier", "Caterer", "Photographer",
    "Driving instructor", "Swimming coach", "Yoga teacher", "GP", "Therapist", "Nanny", "Upholsterer",
    "Piano tuner", "Osteopath", "Acupuncturist", "Dog walker", "Cleaner", "Babysitter", "Carpenter",
    "Financial adviser", "Notary", "Translator", "Speech therapist", "Orthodontist", "Podiatrist"]))
FAMILY_ROLES = ["Partner", "Son", "Daughter", "Mum", "Dad", "Sister", "Brother", "Cousin", "Aunt", "Uncle",
                "Grandmother", "Grandfather", "Sister-in-law", "Brother-in-law", "Niece", "Nephew", "Stepdad",
                "Stepmum", "Godson", "Goddaughter"]
FRIEND_ROLES = ["Friend", "Old school friend", "University friend", "Book club friend", "Climbing partner",
                "Running club friend", "Choir friend", "Friend from the allotment", "Godparent", "Best friend",
                "Friend from yoga", "Old flatmate", "Friend from antenatal", "Pen pal", "Friend from the gym",
                "Dog-walking friend", "Friend from the market"]
WORK_ROLES = ["Colleague", "Manager", "Team lead", "Former colleague", "Client", "Mentor", "Intern", "Supplier",
              "Business partner", "Director"]
NEIGHBOUR_ROLES = ["Neighbour", "Neighbour upstairs", "Neighbour across the road", "Landlord", "Neighbour next door",
                   "Caretaker"]
ORG_SUFFIX = [("Dental", "Dentist"), ("Motors", "Mechanic"), ("Vets", "Vet"), ("Plumbing", "Plumber"),
              ("Builders", "Builder"), ("Opticians", "Optician"), ("Physio", "Physio"), ("Electrics", "Electrician"),
              ("Roofing", "Roofer"), ("Lettings", "Estate agent"), ("Accountants", "Accountant"),
              ("Garden Care", "Gardener"), ("Pharmacy", "Pharmacist"), ("Glazing", "Glazier"),
              ("Removals", "Removals"), ("Joinery", "Joiner"), ("Tyres", "Mechanic"), ("Pet Care", "Dog groomer"),
              ("Clinic", "Doctor"), ("Legal", "Solicitor"), ("Locksmiths", "Locksmith"), ("Nursery", "Childminder")]
EMAIL_DOMAINS = ["example.com", "example.org", "example.net", "mail.example", "post.example", "inbox.example"]
KINDS_OF_TALK = {
    "call": ["Rang about {topic}", "Quick call about {topic}", "Long call, mostly {topic}", "Called back about {topic}",
             "Video call; {topic}"],
    "coffee": ["Coffee at {place}; talked about {topic}", "Coffee and a walk round {place}", "Tea at {place}"],
    "visit": ["Popped round with the {thing}", "Visited for the afternoon; {topic}", "Dropped off the {thing}",
              "Stayed for dinner; {topic}"],
    "message": ["Sent the photos from {place}", "Messaged about {topic}", "Shared the {thing} details",
                "Voice note about {topic}"],
}
CATEGORIES = ["groceries", "travel", "transport", "food", "fun", "rent", "utilities", "shopping", "general"]
GROUP_ICONS = ["🏕️", "🏠", "🛶", "♟️", "🎻", "🚲", "🍷", "⛵", "🎿", "🌷", "🏖️", "🎉", "🧺", "🎲", "🏔️", "🍜"]
GROUP_TAILS = ["crew", "kitty", "fund", "club", "gang", "pot", "share", "circle", "collective", "syndicate"]
CARD_WORDS = ["joint", "travel", "savings", "credit", "debit", "business", "household", "holiday"]
CARD_BRANDS = ["Visa", "Mastercard", "Amex"]
LOCKER_SVC = ["broadband", "bank", "gym", "library", "pharmacy", "school", "council", "water", "energy", "parking",
              "rail", "airline", "mobile", "pension", "insurance", "alarm", "garage", "cloud", "payroll",
              "streaming", "grocery", "tax", "mortgage", "savings", "vet", "dentist"]
LOGIN_TAILS = ["login", "account", "portal", "app"]
NOTE_TAILS = ["PIN", "door code", "backup codes", "alarm code", "safe code", "gate code"]
SECRET_WORDS = ["heron", "quartz", "lantern", "meadow", "copper", "pebble", "willow", "saffron", "juniper",
                "cobalt", "fennel", "marble", "orchid", "tundra", "velvet", "ember", "falcon", "harbor"]
JOURNAL_MOODS = ["good", "tired", "calm", "happy", "busy", "low", "grateful", "restless", "hopeful", "flat",
                 "content", "anxious"]
DATE_LABELS = ["Wedding anniversary", "Name day", "Graduation", "Work anniversary", "Adoption day", "Memorial",
               "Retirement", "Citizenship day", "First date", "Moving day", "Engagement", "Christening"]
FOLDERS8 = ["Travel", "Taxes", "House", "Car", "Medical", "Work", "Insurance", "Kids", "Pets", "Receipts",
            "Finance", "School", "Warranty", "Legal", "Energy", "Pension", "Bank", "Utilities", "Council",
            "Mortgage", "Tenancy", "Visas", "Health", "Dental", "Payslips", "Contracts", "Manuals", "Certificates",
            "Recipes", "Renovation", "Wedding", "Volunteering", "Charity", "Side business", "University",
            "Scans", "Invoices", "Subscriptions", "Vehicle", "Garden", "Bills", "Letters", "Tickets", "Hobbies"]
DOC_TAILS = ["receipt", "invoice", "contract", "warranty", "quote", "certificate", "statement", "letter", "manual",
             "policy", "form", "scan", "renewal", "bill", "agreement", "booking", "permit", "voucher", "report"]
NOTE_TAILS8 = ["ideas", "list", "notes", "plan", "checklist", "measurements", "log", "budget", "draft", "questions",
               "shopping list", "tips", "contacts", "wishlist", "timeline", "packing list"]
EXP_TAILS = ["deposit", "refund", "hire", "fee", "repair", "tickets", "top-up", "parts", "delivery", "subscription",
             "lessons", "kit", "supplies"]
PHOTO_TAILS = ["at {place}", "in the garden", "at dusk", "close-up", "from above", "in the snow", "after the rain",
               "with {first}", "by the window", "at night", "on the table", "at sunrise"]
VERBS8 = ["Book", "Fix", "Clean", "Order", "Return", "Replace", "Check", "Paint", "Renew", "Cancel", "Collect",
          "Measure", "Sort out", "Pay for", "Chase", "Post", "Print", "Service", "Repair", "Recycle", "Label", "Oil",
          "Buy", "Sell", "Insure", "Photograph", "Empty", "Tidy", "Move", "Research", "Quote for", "Wrap", "Sand",
          "Varnish", "Lend", "Borrow", "Mend", "Sharpen", "Unpack", "Weigh"]
FAMILY_EVENT = ["Swimming lesson", "Choir practice", "Running club", "Spanish class", "Pilates", "Five-a-side",
                "Guitar lesson", "Scouts", "Coding club", "Art class", "Karate", "Drama club", "Brass band",
                "Chess club", "Book club", "Aqua aerobics"]
FAMILY_TASK = ["Weekly shop", "Put the bins out", "Water the plants", "Pay the cleaner", "Top up the lunch account",
               "Change the bedding", "Meal prep", "Walk the dog", "Check the post", "Clean the fish tank"]
FAMILY_NOTE = ["Meal plan", "Training log", "Reading notes", "Shopping list", "Weekly review", "Budget check"]
FAMILY_DOC = ["Payslip", "Energy bill", "Bank statement", "Water bill", "Phone bill", "Council tax bill", "Rent receipt"]
FAMILY_EXP = ["Groceries", "Petrol", "Takeaway", "Coffee run", "Market shop", "Bakery run", "Pizza night"]
YEARS = ["2019", "2020", "2021", "2022", "2023", "2024", "2025", "2026", "2027"]

# home regions: centre lat/lng, currency, phone format
REGIONS = [
    ("England", 52.2, -1.2, "GBP", "+44 7700 900%03d"), ("Scotland", 56.3, -3.6, "GBP", "+44 7700 900%03d"),
    ("Wales", 52.1, -3.8, "GBP", "+44 7700 900%03d"), ("Ireland", 53.1, -7.6, "EUR", "+353 85 555 0%03d"),
    ("Portugal", 39.4, -8.4, "EUR", "+351 912 345 %03d"), ("Netherlands", 52.2, 5.3, "EUR", "+31 6 1234 5%03d"),
    ("Germany", 50.9, 9.8, "EUR", "+49 151 2345 6%03d"), ("France", 46.6, 2.3, "EUR", "+33 6 12 34 5%03d"),
    ("Spain", 40.2, -3.6, "EUR", "+34 612 345 %03d"), ("Italy", 43.3, 11.9, "EUR", "+39 312 345 6%03d"),
    ("Sweden", 59.4, 15.2, "SEK", "+46 70 123 4%03d"), ("Norway", 60.4, 8.8, "NOK", "+47 412 34 %03d"),
    ("Denmark", 55.9, 10.1, "DKK", "+45 20 12 3%03d"), ("Poland", 52.0, 19.3, "PLN", "+48 512 345 %03d"),
    ("Canada", 45.4, -75.7, "CAD", "+1 613 555 0%03d"), ("United States", 39.9, -86.1, "USD", "+1 317 555 0%03d"),
    ("Australia", -33.8, 150.9, "AUD", "+61 491 570 %03d"), ("New Zealand", -41.2, 174.8, "NZD", "+64 21 555 %03d"),
    ("South Africa", -33.9, 18.5, "ZAR", "+27 82 555 0%03d"), ("Kenya", -1.3, 36.8, "KES", "+254 712 345 %03d"),
    ("Nigeria", 6.5, 3.4, "NGN", "+234 803 555 0%03d"), ("India", 12.9, 77.6, "INR", "+91 98450 1%04d"),
    ("Singapore", 1.35, 103.8, "SGD", "+65 8123 4%03d"), ("Brazil", -23.5, -46.6, "BRL", "+55 11 91234 5%03d"),
    ("Mexico", 19.4, -99.1, "MXN", "+52 55 1234 5%03d"), ("Switzerland", 46.9, 7.5, "CHF", "+41 79 123 4%03d"),
]

# invented words: a small, pleasant syllable generator (fixed seed, filtered)
_ON = ["b", "br", "c", "cr", "d", "dr", "f", "fl", "g", "gr", "h", "j", "k", "l", "m", "n", "p", "pr", "qu", "r",
       "s", "t", "tr", "th", "v", "vr", "w", "z", "sh", ""]
_V = ["a", "e", "i", "o", "u", "a", "e", "o", "ai", "ea", "ou", "y"]
_C = ["", "", "n", "r", "l", "s", "m", "th", "nd", "ll", "v", "rr", "nn", "st", "sk"]
_L = ["b", "d", "f", "g", "k", "l", "m", "n", "p", "r", "s", "t", "v", "z"]
_LV = ["a", "e", "i", "o", "u"]
MADE_ENDS = {
    "first": ["a", "ia", "el", "en", "is", "ette", "ine", "ara", "eth", "o", "ya", "ir", "wyn", "ie", "ou", "an"],
    "last": ["by", "wick", "ow", "ley", "mere", "holt", "ridge", "acre", "ington", "sen", "ani", "ova", "ez", "ard",
             "ham", "dale", "ett", "ino", "escu", "ak"],
    "place": ["ow", "wick", "mere", "by", "stead", "holm", "ness", "garth", "ay", "wen", "ton", "ford", "combe",
              "haven", "thorpe", "dale", "oe"],
    "noun": ["le", "et", "in", "ock", "um", "ash", "ery", "ling", "ice"],
    "brand": ["o", "ix", "ly", "a", "ora", "eo", "up", "va", "io", "ex"],
}
MADE_N = {"first": 220, "last": 230, "place": 170, "noun": 70, "brand": 90}


def _made_words(protect):
    r = random.Random("v8-made-words")
    seen = set()
    out = {}
    for role in ("first", "last", "place", "noun", "brand"):
        got = []
        while len(got) < MADE_N[role]:
            w = r.choice(_ON) + r.choice(_V) + r.choice(_C)
            if r.random() < 0.4:
                w += r.choice(_L) + r.choice(_LV)
            w += r.choice(MADE_ENDS[role])
            if (re.search(r"[^aeiouy]{3}|[aeiouy]{3}|(.)\1\1|ii|uu|aa|yy|ao|uo|ue|eu|ui|oi|ei|oo|ee|[aeiou]y|"
                          r"y[aeiou]|[aeiou]o[wea]|[aeiou]e[wy]|[aeiou]{2}[^aeiouy]{2}", w) or not 4 <= len(w) <= 9
                    or w in seen or w in protect):
                continue
            seen.add(w)
            got.append(w.capitalize())
        out[role] = got
    return out


# ---------------------------------------------------------------------------
# the forbidden check
# ---------------------------------------------------------------------------

_W, _OLD = P5.old_world()
OLD_LOWER = {x.lower() for x in _OLD}
OLD_NAMES = {x.lower() for x in set(_W.FIRST) | set(_W.LAST)}
EVAL_VOCAB = SN.eval_vocab()  # every word of the evaluation corpora, lowercased
STRUCTURAL = set()  # filled below: template words every world shares on purpose
TEMPLATE_WORDS = """
wifi villa trip trips ferry card ask this things gift ideas viewing last img again sale membership meetup fitting
workshop portal comes before app party new session login fair winter summer boat home find visit pick appointment
path quiz number lesson club class night check call delivery repair collect look close up dusk from above table
brunch drinks meet lunch dinner walk coffee with about week at the and for of on in to rain sunrise tide mist
low walks round best highlights progress house flat share guest studio router password villa alarm bike lock
safe garage shed booking confirmation receipt voucher permit form notes packing list trip holiday weekend
recipes work travel reading health ideas admin kids money garden log
""".split()


class Forbidden(Exception):
    pass


def bad_text(text):
    """why `text` may not appear in a training world, or None"""
    if text.lower() in OLD_LOWER:
        return "is a distillation-world label"
    for tok in re.findall(r"[a-z]+", text.lower()):
        if P5.bad_token(tok):
            return "has forbidden token %r" % tok
    return None


def _word_ok(w):
    toks = re.findall(r"[a-z]+", w.lower())
    return (bool(toks) and not bad_text(w) and not any(t in EVAL_VOCAB or t in OLD_NAMES for t in toks)
            and not any(t in SN.PROTECT for t in toks))


def _clean(words):
    out = []
    for w in dict.fromkeys(words):
        if _word_ok(w):
            out.append(w)
    return out


_MADE = _made_words(EVAL_VOCAB | SN.PROTECT | OLD_NAMES)
# The pools, disjoint across roles (a word is a name OR a place OR a noun), eval-filtered.
_taken = set()


def _disjoint(words):
    out = []
    for w in _clean(words):
        k = w.lower()
        if k not in _taken:
            _taken.add(k)
            out.append(w)
    return out


POOL = {}
POOL["first_real"] = _disjoint(SN.REAL_FIRST + EXTRA_FIRST + P5.X_FIRST)
POOL["first_made"] = _disjoint(_MADE["first"])
POOL["last_real"] = _disjoint(SN.REAL_LAST + EXTRA_LAST + P5.X_LAST)
POOL["last_made"] = _disjoint(_MADE["last"])
POOL["hobby"] = _disjoint(HOBBIES)
POOL["dest_real"] = _disjoint(WORLD_DESTS + [p for p in SN.REAL_PLACES])
POOL["place_made"] = _disjoint(_MADE["place"])
POOL["noun"] = _disjoint(SN.NOUNS)
POOL["noun_made"] = _disjoint(_MADE["noun"])
POOL["brand"] = _disjoint(_MADE["brand"])
PLACE_TYPES = _clean(PLACE_TYPES)
CATEGORY = {}  # word -> real / noun / made, for the vocabulary report
for k in ("first_real", "last_real", "dest_real"):
    CATEGORY.update({w.lower(): "real" for w in POOL[k]})
for k in ("noun", "hobby"):
    CATEGORY.update({w.lower(): "noun" if k == "noun" else "rare" for w in POOL[k]})
for k in ("first_made", "last_made", "place_made", "noun_made", "brand"):
    CATEGORY.update({w.lower(): "made" for w in POOL[k]})


def _pool_check():
    fixed = (ROLES8 + FAMILY_ROLES + FRIEND_ROLES + WORK_ROLES + NEIGHBOUR_ROLES + [a for a, _ in ORG_SUFFIX] +
             [b for _, b in ORG_SUFFIX] + FOLDERS8 + DATE_LABELS + FAMILY_EVENT + FAMILY_TASK + FAMILY_NOTE +
             FAMILY_DOC + FAMILY_EXP + VERBS8 + DOC_TAILS + NOTE_TAILS8 + EXP_TAILS + LOCKER_SVC + NOTE_TAILS +
             SECRET_WORDS + JOURNAL_MOODS + VENUE_T + CARD_WORDS + GROUP_TAILS +
             [x for v in KINDS_OF_TALK.values() for x in v])
    bad = [x for x in fixed if bad_text(x)]
    if bad:
        raise Forbidden("v8 fixed pools: %s" % bad)
    for k, v in POOL.items():
        bad = [w for w in v if not _word_ok(w)]
        if bad:
            raise Forbidden("pool %s: %s" % (k, bad[:10]))
    for x in fixed:
        STRUCTURAL.update(re.findall(r"[a-z]+", x.lower()))
    STRUCTURAL.update(re.findall(r"[a-z]+", " ".join(PLACE_TYPES + CARD_BRANDS + PHOTO_TAILS + YEARS +
                                                     TEMPLATE_WORDS).lower()))


_pool_check()


def spec_strings(spec):
    """every human-readable string in a spec's writes (data URIs decoded, refs skipped)"""
    out = []

    def walk(v):
        if isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, str):
            if v.startswith("$"):
                return
            if v.startswith("data:"):
                out.append(urllib.parse.unquote(v.split(",", 1)[1]))
            else:
                out.append(v)

    walk(spec["writes"])
    return out


def check_spec(spec, where):
    for t in spec_strings(spec):
        why = bad_text(t)
        if why:
            raise Forbidden("%s: %r %s" % (where, t, why))


# ---------------------------------------------------------------------------
# the allocator: keywords spread over the worlds
# ---------------------------------------------------------------------------

class Alloc:
    """Hands out pool words to worlds, least-used first, never past `cap` worlds
    while any word under the cap is left (an overflow is recorded)."""

    def __init__(self):
        self.used = {}
        self.overflow = []

    def take(self, r, pool, k, cap, avoid=(), items=None):
        items = POOL[pool] if items is None else items
        cnt = self.used.setdefault(pool, {})
        avoid = {a.lower() for a in avoid}
        cands = [x for x in items if x.lower() not in avoid]
        r.shuffle(cands)
        cands.sort(key=lambda x: cnt.get(x, 0))
        out = [x for x in cands if cnt.get(x, 0) < cap][:k]
        if len(out) < k:
            more = [x for x in cands if x not in out][:k - len(out)]
            self.overflow.append((pool, len(more)))
            out += more
        for x in out:
            cnt[x] = cnt.get(x, 0) + 1
        return out


# ---------------------------------------------------------------------------
# time
# ---------------------------------------------------------------------------

UTC = dt.timezone.utc


def iso(t):
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def pick_now(i, r):
    """weekday i % 7 (0 = Monday), a month in 2025-2027, a daytime hour"""
    while True:
        year = r.choice([2025, 2026, 2027])
        month = r.randint(1, 12)
        day = r.randint(1, 28)
        d = dt.date(year, month, day)
        d += dt.timedelta(days=(i % 7 - d.weekday()) % 7)
        if d.year == year:
            break
    return dt.datetime(d.year, d.month, d.day, r.randint(8, 17), r.choice([0, 10, 15, 25, 30, 40, 45, 50]),
                       tzinfo=UTC)


def day_at(now, days, hour, minute=0):
    d = (now + dt.timedelta(days=days)).date()
    return dt.datetime(d.year, d.month, d.day, hour, minute, tzinfo=UTC)


def week_no(t):
    return t.isocalendar()[1]


# ---------------------------------------------------------------------------
# the spec builder
# ---------------------------------------------------------------------------

class Spec:
    """The writes, each with its own instant.

    Every CREATING write (one with `kind` or `as_`) must name `at`, the instant
    it should run at; a write that changes a row later names one too, or runs
    at `now` (tool-loop's clock outside an `at`). An `at` is only a wish: it is
    pushed past the creation of every row the body refers to (`$ref.…`) and
    clamped to a minute before `now`, so no row is ever changed — or linked —
    before it exists. `born` keeps each named row's creation instant."""

    def __init__(self, now, tr):
        self.writes = []
        self.count = {}
        self.now = now
        self.latest = now - dt.timedelta(minutes=1)
        self.tr = tr
        self.born = {}

    def dep(self, v):
        """the latest creation among the rows a body refers to"""
        out = None
        if isinstance(v, dict):
            for x in v.values():
                d = self.dep(x)
                out = d if out is None or (d and d > out) else out
        elif isinstance(v, list):
            for x in v:
                d = self.dep(x)
                out = d if out is None or (d and d > out) else out
        elif isinstance(v, str) and v.startswith("$"):
            out = self.born.get(v[1:].split(".")[0])
        return out

    def when(self, want, body, what):
        t = want.replace(second=0, microsecond=0)
        if t.hour < 7:  # people do their admin awake
            t = t.replace(hour=self.tr.randint(7, 11))
        dep = self.dep(body)
        if dep and t <= dep:
            t = dep + dt.timedelta(minutes=self.tr.randint(2, 90))
        t = min(t, self.latest)
        if dep and t < dep:
            raise RuntimeError("%s would run before a row it names exists" % what)
        return t

    def cmd(self, name, body, kind=None, as_=None, at=None, faces=None):
        w = {"cmd": name, "body": body}
        if as_:
            w["as"] = as_
        if at is None and (kind or as_):
            raise RuntimeError("creating write %s has no `at`" % name)
        if at is not None:
            at = self.when(at, body, name)
            w["at"] = iso(at)
        if faces:
            w["faces"] = faces      # confirmed at `now`, after the photo exists
        self.writes.append(w)
        if kind:
            self.count[kind] = self.count.get(kind, 0) + 1
        if as_:
            self.born[as_] = at
        return at if at is not None else self.now

    def canon(self, line, kind=None, at=None):
        if at is None:
            raise RuntimeError("canonical write has no `at`")
        at = min(at.replace(second=0, microsecond=0), self.latest)
        self.writes.append({"canon": line, "at": iso(at)})
        if kind:
            self.count[kind] = self.count.get(kind, 0) + 1
        return at

    def field(self, entity, id_ref, column, as_):
        self.writes.append({"field": [entity, id_ref, column], "as": as_})
        self.born[as_] = self.born.get(id_ref[1:].split(".")[0])  # minted with that row
        return as_

    def ago(self, dmin, dmax):
        return self.now - dt.timedelta(days=self.tr.uniform(dmin, dmax))

    def plus(self, t, dmin, dmax):
        return t + dt.timedelta(days=self.tr.uniform(dmin, dmax))


def cap(s):
    return s[:1].upper() + s[1:]


class Labels:
    """unique, checked labels per kind for one world; every label is kept for the manifest"""

    def __init__(self, r):
        self.r = r
        self.used = {}
        self.all = {}

    def take(self, kind, gen, tries=300):
        used = self.used.setdefault(kind, set())
        for _ in range(tries):
            x = re.sub(r"\s+", " ", gen()).strip()
            if not x or x.lower() in used or bad_text(x):
                continue
            used.add(x.lower())
            self.all.setdefault(kind, []).append(x)
            return x
        raise RuntimeError("no fresh %s label" % kind)

    def force(self, kind, x):
        why = bad_text(x)
        if why:
            raise Forbidden("%s label %r %s" % (kind, x, why))
        if x.lower() in self.used.setdefault(kind, set()):
            raise RuntimeError("duplicate %s label %r" % (kind, x))
        self.used[kind].add(x.lower())
        self.all.setdefault(kind, []).append(x)
        return x


def toks(s):
    return set(re.findall(r"[a-z]+", s.lower()))


# ---------------------------------------------------------------------------
# one world
# ---------------------------------------------------------------------------

def build_world(i, seed, A):
    r = random.Random("%s/w%02d" % (seed, i))
    now = pick_now(i, r)
    tr = random.Random("%s/w%02d/clock" % (seed, i))  # every write's instant: its own stream
    S = Spec(now, tr)
    L = Labels(r)
    ex = {}  # one example row per probe, for verification

    # -- this world's vocabulary, from the allocator ----------------------------
    region = A.take(r, "region", 1, 2, items=[x[0] for x in REGIONS])[0]
    _, base_lat, base_lng, currency, phone_fmt = next(x for x in REGIONS if x[0] == region)
    themes = (A.take(r, "noun", 2, 3) + A.take(r, "hobby", 2, 3) + A.take(r, "noun_made", 1, 3))
    r.shuffle(themes)
    themes = [t.lower() for t in themes]
    nouns = [n.lower() for n in A.take(r, "noun", 24, 4, avoid=themes)]
    trash_words = [n.lower() for n in A.take(r, "noun", 4, 3, avoid=themes + nouns)]
    hobbies = [h for h in A.take(r, "hobby", 7, 4, avoid=themes)]
    acts = [cap(h) + " " + r.choice(["class", "club", "session", "workshop", "night", "lesson", "meetup"])
            for h in hobbies]
    brands = A.take(r, "brand", 6, 3)
    placew = A.take(r, "dest_real", 5, 3) + A.take(r, "place_made", 5, 3)
    r.shuffle(placew)
    dest_real = A.take(r, "dest_real", 1, 2, avoid=placew)
    dest_made = A.take(r, "place_made", 1, 2, avoid=placew)
    dests = dest_real + dest_made
    r.shuffle(dests)
    tripw = A.take(r, "place_made", 1, 3, avoid=placew + dests) + A.take(r, "dest_real", 1, 3, avoid=placew + dests)
    n_first_made = r.randint(12, 16)
    firsts = A.take(r, "first_real", 40 - n_first_made, 3) + A.take(r, "first_made", n_first_made, 3)
    lasts = A.take(r, "last_real", 24, 3) + A.take(r, "last_made", 16, 3)
    r.shuffle(firsts)
    r.shuffle(lasts)
    folders = A.take(r, "folder", r.randint(3, 4), 6, items=FOLDERS8)
    vocab = {"themes": themes, "nouns": nouns, "trash_words": trash_words, "hobbies": hobbies, "brands": brands,
             "place_words": placew, "destinations": dests, "trip_place_words": tripw, "firsts": firsts, "lasts": lasts}

    # -- cast ----------------------------------------------------------------
    fi = iter(firsts)
    li = iter(lasts)
    home_last = next(li)
    partner_last = r.choice([home_last, next(li)])
    people = []  # dicts: name, first, last, role, group, ref

    def person(first, last, role, group):
        name = "%s %s" % (first, last)
        people.append({"name": L.force("parties", name), "first": first, "last": last, "role": role,
                       "group": group})

    person(next(fi), partner_last, "Partner", "family")
    for _ in range(r.randint(1, 3)):
        person(next(fi), home_last, r.choice(["Son", "Daughter"]), "family")
    person(next(fi), home_last, "Mum", "family")
    if r.random() < 0.6:
        person(next(fi), home_last, "Dad", "family")
    person(next(fi), r.choice([home_last, next(li)]), r.choice(["Sister", "Brother"]), "family")
    for _ in range(r.randint(1, 3)):
        person(next(fi), r.choice([home_last, partner_last, next(li)]),
               r.choice(["Cousin", "Aunt", "Uncle", "Grandmother", "Grandfather", "Sister-in-law", "Brother-in-law",
                         "Niece", "Nephew"]), "family")
    n_org = r.randint(3, 5)
    n_service = r.randint(5, 7)
    n_work = r.randint(4, 6)
    n_neigh = r.randint(2, 4)
    n_friend = r.randint(9, 12)
    for _ in range(n_friend):
        person(next(fi), next(li), r.choice(FRIEND_ROLES), "friend")
    for _ in range(n_work):
        person(next(fi), next(li), r.choice(WORK_ROLES), "work")
    for _ in range(n_neigh):
        person(next(fi), next(li), r.choice(NEIGHBOUR_ROLES), "neighbour")
    for role in r.sample(ROLES8, n_service):
        person(next(fi), next(li), role, "service")
    # shared first names: two (sometimes three) pairs, different surnames and roles
    pool = [p for p in people if p["group"] in ("friend", "work", "neighbour", "service")]
    twins_src = r.sample(pool, r.choice([2, 2, 3]))
    for src in twins_src:
        twin_group = r.choice([g for g in ("friend", "work", "neighbour", "service") if g != src["group"]])
        role = {"friend": r.choice(FRIEND_ROLES), "work": r.choice(WORK_ROLES),
                "neighbour": r.choice(NEIGHBOUR_ROLES), "service": r.choice(ROLES8)}[twin_group]
        person(src["first"], next(li), role, twin_group)
    for suffix, role in r.sample(ORG_SUFFIX, n_org):
        name = L.take("parties", lambda: "%s %s" % (r.choice(placew + brands), suffix))
        people.append({"name": name, "first": None, "last": None, "role": role, "group": "org"})
    for k, p in enumerate(people):
        p["ref"] = "p%02d" % (k + 1)
        S.cmd("people.add_person", {"display_name": p["name"], "role": p["role"],
                                    "cadence_days": r.choice([0, 7, 14, 30, 60, 90])
                                    if p["group"] != "org" else 0},
              kind="parties", as_=p["ref"], at=S.ago(250, 1500))
    by_group = {}
    for p in people:
        by_group.setdefault(p["group"], []).append(p)
    humans = [p for p in people if p["group"] != "org"]
    social = by_group["family"] + by_group["friend"]
    partner = by_group["family"][0]

    def pid(p):
        return "$%s.party_id" % p["ref"]

    # contact channels: several people carry a phone, an email, or both
    phone_n = iter(r.sample(range(1000), 400))
    both = set(p["ref"] for p in r.sample(social, 4))
    channels = {}
    for p in people:
        if p["group"] == "org":
            S.cmd("people.save_contact_channel", {"party_id": pid(p), "kind": "phone", "label": "office",
                                                  "value": phone_fmt % next(phone_n)}, kind="contact channels",
                  at=S.plus(S.born[p["ref"]], 0, 40))
            slug = re.sub(r"[^a-z]", "", p["name"].lower())
            S.cmd("people.save_contact_channel", {"party_id": pid(p), "kind": "email", "label": "work",
                                                  "value": "hello@%s.example" % slug}, kind="contact channels",
                  at=S.plus(S.born[p["ref"]], 0, 40))
            channels[p["name"]] = ["phone", "email"]
            continue
        got = []
        if p["ref"] in both or r.random() < 0.55:
            S.cmd("people.save_contact_channel", {"party_id": pid(p), "kind": "phone",
                                                  "label": r.choice(["mobile", "mobile", "home", "work"]),
                                                  "value": phone_fmt % next(phone_n)}, kind="contact channels",
                  at=S.plus(S.born[p["ref"]], 0, 200))
            got.append("phone")
        if p["ref"] in both or r.random() < 0.4:
            S.cmd("people.save_contact_channel", {
                "party_id": pid(p), "kind": "email", "label": r.choice(["personal", "work"]),
                "value": "%s.%s@%s" % (re.sub(r"[^a-z]", "", p["first"].lower()),
                                       re.sub(r"[^a-z]", "", p["last"].lower()), r.choice(EMAIL_DOMAINS))},
                kind="contact channels", at=S.plus(S.born[p["ref"]], 0, 200))
            got.append("email")
        if got:
            channels[p["name"]] = got
    ex["channel_party"] = next(p["name"] for p in social if p["ref"] in both)

    # important dates: birthdays (three soon), and non-birthdays
    soon = r.sample(social, 3)
    ex["date_party"] = soon[0]["name"]
    dates = []
    for p in humans:
        if p in soon:
            d = (now + dt.timedelta(days=[2, r.randint(4, 10), r.randint(15, 28)][soon.index(p)])).date()
        elif p["group"] in ("family", "friend") and r.random() < 0.5:
            d = dt.date(2001, r.randint(1, 12), r.randint(1, 28))
        elif r.random() < 0.08:
            d = dt.date(2001, r.randint(1, 12), r.randint(1, 28))
        else:
            continue
        S.cmd("people.add_important_date", {"party_id": pid(p), "label": "Birthday",
                                            "month_day": "%02d-%02d" % (d.month, d.day),
                                            "reminder_on": r.random() < 0.5}, kind="important dates",
              at=S.plus(S.born[p["ref"]], 0, 120))
        dates.append(("Birthday", p["name"]))
    d = now.date() + dt.timedelta(days=r.randint(-40, 40))
    S.cmd("people.add_important_date", {"party_id": pid(partner), "label": "Anniversary",
                                        "month_day": "%02d-%02d" % (d.month, min(d.day, 28)),
                                        "reminder_on": True}, kind="important dates",
          at=S.plus(S.born[partner["ref"]], 0, 30))
    dates.append(("Anniversary", partner["name"]))
    for p, label in zip(r.sample(humans[1:], 3), r.sample(DATE_LABELS, 3)):
        S.cmd("people.add_important_date", {"party_id": pid(p), "label": label,
                                            "month_day": "%02d-%02d" % (r.randint(1, 12), r.randint(1, 28)),
                                            "reminder_on": r.random() < 0.3}, kind="important dates",
              at=S.plus(S.born[p["ref"]], 0, 200))
        dates.append((label, p["name"]))
    ex["nonbirthday_date"] = dates[-1]

    # -- places: home places (named through their first photograph) and a trip ----
    home = []
    for k in range(r.randint(5, 8)):
        if k < 3:
            name = L.take("places", lambda: r.choice(VENUE_T).format(
                P=r.choice(placew), N=cap(r.choice(nouns)), N2=cap(r.choice(nouns))))
        else:
            name = L.take("places", lambda: "%s %s" % (r.choice(placew), r.choice(PLACE_TYPES)))
        home.append(name)
    trip_dest = dests[0]
    past_dest = dests[1]
    subs = []  # places at the past trip's destination
    for _ in range(r.randint(2, 3)):
        subs.append(L.take("places", lambda: r.choice([
            "%s %s" % (past_dest, r.choice(PLACE_TYPES)),
            "%s %s" % (r.choice(tripw), r.choice(PLACE_TYPES))])))
    places = []
    far_lat, far_lng = base_lat + r.choice([-1, 1]) * r.uniform(2.0, 5.0), base_lng + r.choice([-1, 1]) * r.uniform(
        2.0, 5.0)
    for k, name in enumerate(home + subs):
        lat0, lng0 = (base_lat, base_lng) if name in home else (far_lat, far_lng)
        places.append({"name": name, "ref": "pl%02d" % (k + 1), "trip": name in subs,
                       "lat": round(lat0 + (k % 4) * 0.021 + r.uniform(0, 0.004), 5),
                       "lng": round(lng0 + (k // 4) * 0.027 + r.uniform(0, 0.004), 5)})
    home_places = [p for p in places if not p["trip"]]
    trip_places = [p for p in places if p["trip"]]
    venue = home_places[0]  # its words are shared with a locker wifi item and an event

    def plid(pl):
        return "$%s.value" % pl["ref"]

    def fmt(t):
        return t.format(first=r.choice(humans)["first"], place=r.choice(home_places)["name"],
                        year=r.choice(YEARS[-4:] + [str(now.year - 1), str(now.year)]),
                        noun=cap(r.choice(nouns)), n=r.choice(nouns), act=r.choice(acts))

    # -- photos, places, albums -----------------------------------------------
    photos = []
    th_photo = ["{W} at {place}", "{W} close-up", "The {w} at dusk", "{W} from above", "New {w}",
                "{first} with the {w}", "{W} on the table"]
    for k, w in enumerate(themes):
        photos.append({"title": L.take("photos", lambda: fmt(r.choice(th_photo).replace("{w}", w).replace(
            "{W}", cap(w)))), "place": home_places[k % len(home_places)] if k < 2 else None,
            "back": r.randint(1, 60)})
    for pl in home_places:
        photos.append({"title": L.take("photos", lambda: r.choice(["%s %s" % (pl["name"], r.choice(
            ["at dusk", "in the rain", "at sunrise", "in winter", "from the path"])), fmt("{noun} at %s" % pl["name"]),
            fmt("{first} at %s" % pl["name"])])), "place": pl, "back": r.randint(1, 200)})
    trip_back = r.randint(40, 160)
    for pl in trip_places:
        for _ in range(r.randint(1, 2)):
            photos.append({"title": L.take("photos", lambda: r.choice([
                "%s %s" % (pl["name"], r.choice(["at sunrise", "at low tide", "from the boat", "in the mist"])),
                fmt("{first} at %s" % pl["name"]), fmt("{noun} at %s" % pl["name"])])), "place": pl,
                "back": trip_back - r.randint(0, 3)})
    for _ in range(r.randint(14, 22)):
        roll = r.random()
        if roll < 0.12:
            title = L.take("photos", lambda: "IMG_%04d" % r.randint(1000, 9999))
        elif roll < 0.35:
            title = L.take("photos", lambda: fmt(r.choice(["{act} {year}", "{first}'s {n}", "{noun} and {n}"])))
        else:
            title = L.take("photos", lambda: "%s %s" % (cap(r.choice(nouns)), fmt(r.choice(PHOTO_TAILS))))
        photos.append({"title": title, "place": r.choice(home_places) if r.random() < 0.3 else None,
                       "back": r.randint(1, 45) if r.random() < 0.72 else r.randint(46, 1100)})
    # the trash-only photo: its keyword is nowhere else in the world
    tw_photo = trash_words[0]
    photos.append({"title": L.force("photos", "%s %s" % (cap(tw_photo), r.choice(["on the shelf", "close-up",
                                                                                   "at dusk"]))),
                   "place": None, "back": r.randint(2, 30), "trash": True})
    for ph in photos:
        ph["when"] = day_at(now, -ph["back"], r.randint(7, 20), r.randint(0, 59))
    base = r.choice([p for p in photos if not p["title"].startswith("IMG_") and not p.get("trash")])
    burst_when = day_at(now, -r.randint(1, 20), r.randint(9, 18), r.randint(0, 50))
    for j in range(1, r.randint(3, 4) + 1):
        photos.append({"title": L.force("photos", "%s (%02d)" % (base["title"], j)), "place": base["place"],
                       "when": burst_when + dt.timedelta(minutes=j)})
    photos.sort(key=lambda p: p["when"])
    # faces: a few frames name the people in them (see the module doc)
    face_pool = [p for p in photos if not p["title"].startswith("IMG_") and not p.get("trash")]
    faces = {}
    for ph in r.sample(face_pool, min(len(face_pool), r.randint(5, 8))):
        named = [p for p in humans if p["first"] and re.search(r"\b%s\b" % re.escape(p["first"]), ph["title"])]
        faces[ph["title"]] = (named[:1] or []) + r.sample(social, r.randint(1, 2))
        faces[ph["title"]] = list({p["ref"]: p for p in faces[ph["title"]]}.values())
    named_pl = set()
    for k, ph in enumerate(photos):
        ph["ref"] = "ph%02d" % (k + 1)
        body = {"data_uri": "data:text/plain,%s" % urllib.parse.quote("photo %s/w%02d/%d %s" % (seed, i, k,
                                                                                                ph["title"])),
                "kind": "photo", "title": ph["title"], "captured_at": iso(ph["when"]),
                "width": r.choice([3024, 4032, 1080]), "height": r.choice([3024, 2268, 1920])}
        pl = ph["place"]
        if pl:
            body["latitude"] = round(pl["lat"] + r.uniform(-0.0004, 0.0004), 6) if pl["ref"] in named_pl else pl["lat"]
            body["longitude"] = round(pl["lng"] + r.uniform(-0.0004, 0.0004), 6) if pl["ref"] in named_pl else pl["lng"]
        ph["at"] = S.cmd("media.add_asset", body, kind="photos", as_=ph["ref"],
                         faces=[pid(p) for p in faces.get(ph["title"], [])],
                         at=ph["when"] + dt.timedelta(minutes=tr.randint(1, 3 * 24 * 60)))
        if pl and pl["ref"] not in named_pl:
            S.field("core.content_item", "$%s.asset_id" % ph["ref"], "place_id", pl["ref"])
            S.cmd("media.name_place", {"place_id": plid(pl), "name": pl["name"]}, kind="places",
                  at=ph["at"] + dt.timedelta(minutes=tr.randint(2, 600)))
            named_pl.add(pl["ref"])
    live_photos = [p for p in photos if not p.get("trash")]
    favs = r.sample(live_photos, r.randint(3, 6))
    for ph in favs:
        S.cmd("media.update_asset", {"asset_id": "$%s.asset_id" % ph["ref"], "favorite": 1},
              at=S.plus(ph["at"], 0, 30))
    albums = []
    trip_year = (now - dt.timedelta(days=trip_back)).year
    albums.append((L.force("albums", "%s %s" % (past_dest, trip_year)),
                   [p for p in live_photos if p["place"] and p["place"]["trip"]]))
    albums.append((L.take("albums", lambda: r.choice(["{P}", "Walks round {P}", "{P} {Y}"]).format(
        P=home_places[1]["name"], Y=now.year)), [p for p in live_photos if p["place"] is home_places[1]]))
    albums.append((L.force("albums", cap(themes[0]) + r.choice(["", " " + str(now.year), " progress"])), []))
    for _ in range(r.randint(1, 3)):
        albums.append((L.take("albums", lambda: fmt(r.choice(["{act}", "{first}'s {n}", "Best of {year}",
                                                             "{noun} {year}", "Summer {year}", "Winter {year}",
                                                             "{act} highlights"]))), []))
    album_titles = []
    for k, (title, members) in enumerate(albums):
        ref = "al%02d" % (k + 1)
        album_titles.append(title)
        al_at = S.cmd("media.create_album", {"title": title}, kind="albums", as_=ref, at=S.ago(1, 400))
        members = list(members)
        members += r.sample([p for p in live_photos if p not in members], r.randint(2, 6) if members else
                            r.randint(3, 8))
        for ph in members:
            S.cmd("media.add_to_album", {"album_id": "$%s.album_id" % ref, "asset_id": "$%s.asset_id" % ph["ref"]},
                  at=S.plus(max(al_at, ph["at"]), 0, 10))
    trash_photo = next(p for p in photos if p.get("trash"))
    S.cmd("media.delete_asset", {"asset_id": "$%s.asset_id" % trash_photo["ref"]},
          at=S.plus(trash_photo["at"], 0, 20))

    # -- calendar ---------------------------------------------------------------
    busy = []

    def slot(day, dur, hours=None):
        hs = list(hours or range(7, 21))
        r.shuffle(hs)
        for h in hs:
            for m in r.sample([0, 15, 30, 45], 4):
                s = day_at(now, day, h, m)
                e = s + dt.timedelta(minutes=dur)
                if e.date() != s.date():
                    continue
                if all(e <= b0 or s >= b1 for b0, b1 in busy):
                    busy.append((s, e))
                    return s, e
        return None

    monday = -now.weekday()
    sat = (5 - now.weekday()) % 7
    weekend = [sat, sat + 1] if now.weekday() != 6 else [0, 6]
    days = [monday + d for d in range(7) if r.random() < 0.9]
    days += [monday + d for d in r.sample(range(7), r.randint(2, 4))]
    days += [weekend[0]] * r.randint(2, 3) + [weekend[1]] * r.randint(1, 2)
    days += [monday + 7 + d for d in r.sample(range(7), 3)]  # next week
    n_events = r.randint(26, 38)
    while len(days) < n_events:
        days.append(r.randint(-30, 30))
    r.shuffle(days)
    near = list(range(max(monday, -2), monday + 14))  # this week and next: never inside a trip
    events = []
    ev_theme = ["{W} lesson", "{W} club", "Look at the {w}", "{W} viewing", "{W} fair", "{W} workshop",
                "{W} meetup", "Pick up the {w}"]
    # two events share themes[0]; one each for the next two themes
    for w in [themes[0], themes[0], themes[1], themes[2]]:
        events.append({"title": L.take("events", lambda: r.choice(ev_theme).replace("{w}", w).replace(
            "{W}", cap(w))), "day": r.choice(near)})
    events.append({"title": L.take("events", lambda: r.choice(["Brunch at {v}", "Drinks at {v}", "Quiz at {v}",
                                                                 "Meet {f} at {v}"]).format(
        v=venue["name"], f=r.choice(social)["first"])), "day": r.choice(near), "place": venue})
    svc = r.sample(by_group["service"], 2)
    for p in svc:
        events.append({"title": L.take("events", lambda: "%s %s" % (p["role"], r.choice(
            ["appointment", "visit", "check-up", "call"]))), "day": r.choice(near), "att": [p]})
    for d in days:
        roll = r.random()
        if roll < 0.35:
            title = L.take("events", lambda: fmt(r.choice(["{act}", "{act} with {first}", "{act} at {place}"])))
        elif roll < 0.6:
            title = L.take("events", lambda: fmt(r.choice(["Lunch with {first}", "Dinner with {first}",
                                                           "Walk with {first}", "Coffee with {first}",
                                                           "Call {first} about the {n}",
                                                           "{first}'s {n} party"])))
        else:
            title = L.take("events", lambda: fmt(r.choice(["{noun} delivery", "{noun} fitting", "{noun} repair",
                                                           "Collect the {n}", "{noun} sale at {place}",
                                                           "{noun} viewing"])))
        events.append({"title": title, "day": d})
    # a weekly family: "<act> (week NN)"
    fam_ev = L.take("event-family", lambda: r.choice(FAMILY_EVENT))
    wd = r.randint(0, 6)
    for j in range(4):
        events.append({"title": None, "family": fam_ev, "day": monday - 21 + wd + 7 * j})
    ev_n = 0
    trips = []
    # multi-day trips: one coming up (to trip_dest), one past (past_dest, where the trip photos are)
    trip_people = r.sample(social, r.randint(2, 4))
    for dest, start, length in [(trip_dest, monday + 14 + r.randint(0, 25), r.randint(2, 6)),
                                (past_dest, -trip_back - 1, r.randint(3, 6))]:
        s = day_at(now, start, r.choice([7, 8, 9, 10]))
        e = day_at(now, start + length, r.choice([17, 18, 19]))
        title = L.take("events", lambda: r.choice(["Trip to {d}", "{d} weekend", "{d} holiday", "{d} trip"]).format(
            d=dest) if length < 4 else r.choice(["Trip to {d}", "{d} holiday", "{d} trip"]).format(d=dest))
        busy.append((s, e))
        ev_n += 1
        S.cmd("schedule.propose_event", {"calendar_id": "$me.calendar_id", "summary": title, "dtstart": iso(s),
                                         "dtend": iso(e), "attendee_party_ids": [pid(p) for p in trip_people]},
              kind="events", as_="ev%02d" % ev_n, at=S.plus(s, -60, -5))
        trips.append({"title": title, "destination": dest, "start": iso(s), "end": iso(e),
                      "people": [p["name"] for p in trip_people]})

    for ev in events:
        dur = r.choice([30, 45, 60, 60, 90, 120, 180])
        got = slot(ev["day"], dur)
        if not got:
            continue
        s, e = got
        if ev.get("family"):
            ev["title"] = L.force("events", "%s (week %02d)" % (ev["family"], week_no(s)))
        body = {"calendar_id": "$me.calendar_id", "summary": ev["title"], "dtstart": iso(s), "dtend": iso(e)}
        if ev.get("att"):
            att = ev["att"]
        elif r.random() < 0.8:
            grp = r.choice([social, social, by_group["work"], by_group["neighbour"], humans])
            att = r.sample(grp, min(len(grp), r.choice([1, 1, 2, 2, 3, 4])))
        else:
            att = []
        if att:
            body["attendee_party_ids"] = [pid(p) for p in att]
            ex.setdefault("event_with_attendees", ev["title"])
        pl = ev.get("place") or (r.choice(home_places) if r.random() < 0.3 else None)
        if pl:
            body["location_place_id"] = plid(pl)
            ex.setdefault("event_place", pl["name"])
        if r.random() < 0.3:
            body["description"] = r.choice(["Bring the {thing}.", "Parking behind {place}.", "Confirm with {first}.",
                                            "Deposit already paid.", "Remember the {thing} for {first}."]).format(
                thing=r.choice(nouns), place=r.choice(home_places)["name"], first=r.choice(humans)["first"])
        ev_n += 1
        S.cmd("schedule.propose_event", body, kind="events", as_="ev%02d" % ev_n, at=S.plus(s, -30, -0.5))
    # -- tasks --------------------------------------------------------------------
    tasks = []
    th_task = ["{V} the {w}", "{V} the {w} before {first} comes", "Ask {first} about the {w}", "{V} the {w} again",
               "Find a {w} for {first}", "{V} the {w} at {place}"]
    for w in [themes[0], themes[0], themes[1], themes[3], themes[4]]:
        tasks.append({"title": L.take("tasks", lambda: fmt(r.choice(th_task).replace("{w}", w).replace(
            "{V}", r.choice(VERBS8))))})
    tasks.append({"title": L.take("tasks", lambda: "%s the %s ferry" % (r.choice(["Book", "Check", "Pay for"]),
                                                                        trip_dest))})
    for _ in range(r.randint(18, 28)):
        tasks.append({"title": L.take("tasks", lambda: fmt(r.choice([
            "%s the {n}" % r.choice(VERBS8), "%s the {n} for {first}" % r.choice(VERBS8),
            "%s {first}'s {n}" % r.choice(VERBS8), "Ask {first} about the {n}",
            "%s the {n} at {place}" % r.choice(VERBS8), "%s the {n} this week" % r.choice(VERBS8)])))})
    # guaranteed texture: undated, 45-minute, done-last-week
    for t in r.sample(tasks[6:], 3):
        t["due"] = None
    for t in r.sample(tasks, 3):
        t["effort"] = 45
    done_last_week = r.sample([t for t in tasks[6:] if "due" not in t], 3)
    for t in done_last_week:
        t["status"] = "completed"
        t["done_at"] = day_at(now, monday - 7 + r.randint(0, 6), r.randint(9, 20))
    # ticked off today, before now (at least one, every world)
    midnight = day_at(now, 0, 0)
    done_today = r.sample([t for t in tasks[6:] if t not in done_last_week], 2)
    for t in done_today:
        t["status"] = "completed"
        t["done_at"] = midnight + (now - midnight) * tr.uniform(0.2, 0.95)
        t["made_before"] = midnight - dt.timedelta(hours=tr.randint(2, 200))
    fam_task = L.take("task-family", lambda: r.choice(FAMILY_TASK))
    for j in range(r.randint(3, 5)):
        t = day_at(now, monday - 14 + 7 * j + r.randint(0, 1), 9)
        tasks.append({"title": L.force("tasks", "%s (wk %02d)" % (fam_task, week_no(t))), "due": t,
                      "status": "completed" if t < now else None, "done_at": t + dt.timedelta(hours=3)
                      if t < now else None})
    # the trash-only task
    tw_task = trash_words[1]
    trash_task = {"title": L.force("tasks", "%s the %s" % (r.choice(VERBS8), tw_task)), "trash": True}
    tasks.append(trash_task)
    t_n = 0

    def add_task(t, parent=None, defer=False):
        nonlocal t_n
        t_n += 1
        ref = "t%02d" % t_n
        t["ref"] = ref
        body = {"title": t["title"]}
        due = t.get("due", "unset")
        if due == "unset":
            due = None if r.random() < 0.12 else day_at(now, r.randint(-30, 30), r.choice([9, 9, 12, 17, 18]))
        if due:
            body["due_at"] = iso(due)
        if t.get("effort"):
            body["effort_min"] = t["effort"]
        elif r.random() < 0.45:
            body["effort_min"] = r.choice([10, 15, 20, 30, 60, 90, 120, 180])
        if r.random() < 0.5:
            body["priority"] = r.randint(1, 9)
        if parent:
            body["parent_task_id"] = "$%s.task_id" % parent
        want = S.plus(due, -21, -0.5) if due else S.ago(1, 45)
        if t.get("done_at"):
            want = min(want, t["done_at"] - dt.timedelta(days=tr.uniform(0.5, 10)))
        if t.get("made_before"):
            want = min(want, t["made_before"])
        created = S.cmd("schedule.add_task", body, kind="tasks", as_=ref, at=want)
        status = t.get("status")
        at = t.get("done_at")
        if status is None and "status" not in t:
            if due and due < now:
                status = r.choice(["completed", "completed", "completed", None, "in-process"])
            else:
                status = r.choice([None] * 7 + ["completed", "in-process"])
            if r.random() < 0.04:
                status = "cancelled"
            if status == "completed":
                end = min(due, now) if due else now
                at = created + (end - created) * tr.uniform(0.1, 1.0) if end > created else created
                at = min(at, midnight - dt.timedelta(minutes=tr.randint(5, 600)))  # "today" is planted, not drawn
        if status and defer:
            return ref, (status, at)
        if status:
            S.cmd("schedule.set_task_status", {"task_id": "$%s.task_id" % ref, "status": status},
                  at=at if status == "completed" else None)
        return ref, None

    parents = set(r.sample([k for k in range(6, len(tasks) - 1)
                            if tasks[k] not in done_last_week and tasks[k] not in done_today], 3))
    for k, t in enumerate(tasks):
        # a parent must be open while its subtasks are added; its own status comes after
        ref, later = add_task(t, defer=k in parents)
        if k in parents:
            ex.setdefault("parent_task", t["title"])
            for _ in range(r.randint(2, 3)):
                sub = {"title": L.take("tasks", lambda: "%s the %s" % (r.choice(VERBS8), r.choice(nouns)))}
                if r.random() < 0.5:
                    sub["due"] = None
                add_task(sub, parent=ref)
            if later and later[0] != "completed":
                S.cmd("schedule.set_task_status", {"task_id": "$%s.task_id" % ref, "status": later[0]})
        if t.get("trash"):
            S.cmd("schedule.delete_task", {"task_id": "$%s.task_id" % ref}, at=S.plus(S.born[ref], 0.2, 20))

    # -- notes ----------------------------------------------------------------------
    nb_names = [L.force("notebooks", cap(themes[1]))]
    nb_names.append(L.take("notebooks", lambda: r.choice([cap(hobbies[0]), "%s trips" % trip_dest,
                                                          "%s house" % r.choice(placew)])))
    while len(nb_names) < r.randint(3, 5):
        nb_names.append(L.take("notebooks", lambda: r.choice(["Recipes", "Work", "Travel", "Reading", "Health",
                                                              "Ideas", "Home admin", "Kids", "Money", "Garden log",
                                                              cap(r.choice(nouns)), cap(r.choice(hobbies))])))
    for k, nb in enumerate(nb_names):
        S.cmd("knowledge.create_notebook", {"name": nb}, kind="notebooks", as_="nb%02d" % (k + 1),
              at=S.ago(60, 700))
    notes = []
    for w in themes:
        notes.append(L.take("notes", lambda: "%s %s" % (cap(w), r.choice(NOTE_TAILS8))))
    notes.append(L.force("notes", "%s packing list" % trip_dest))
    for _ in range(r.randint(13, 20)):
        notes.append(L.take("notes", lambda: fmt(r.choice([
            "{noun} %s" % r.choice(NOTE_TAILS8), "{act} %s" % r.choice(NOTE_TAILS8), "Things to ask {first}",
            "Notes from {place}", "{first}'s {n} %s" % r.choice(NOTE_TAILS8), "Gift ideas for {first}"]))))
    fam_note = L.take("note-family", lambda: r.choice(FAMILY_NOTE))
    note_at = {}
    for j in range(r.randint(3, 4)):
        notes.append(L.force("notes", "%s (wk %02d)" % (fam_note, week_no(now - dt.timedelta(days=7 * j)))))
        note_at[notes[-1]] = now - dt.timedelta(days=7 * j + tr.uniform(0, 1.5))
    tw_note = trash_words[2]
    trash_notes = {len(notes)}
    notes.append(L.force("notes", "%s %s" % (cap(tw_note), r.choice(NOTE_TAILS8))))
    trash_notes.add(r.randrange(6, len(notes) - 5))
    for at, title in enumerate(notes):
        lines = [title, "", "- %s" % cap(r.choice(nouns)), "- ask %s" % r.choice(humans)["first"],
                 "- %s" % r.choice(home_places)["name"]]
        body = {"title": title, "body_text": "\n".join(lines), "format": "markdown"}
        if themes[1] in title.lower():
            body["notebook_id"] = "$nb01.notebook_id"
        elif trip_dest in title:
            body["notebook_id"] = "$nb02.notebook_id"
        elif r.random() < 0.8:
            body["notebook_id"] = "$nb%02d.notebook_id" % (r.randrange(len(nb_names)) + 1)
        made = S.cmd("knowledge.create_note", body, kind="notes", as_="n%02d" % (at + 1),
                     at=note_at.get(title) or S.ago(1, 150))
        if at in trash_notes:
            S.cmd("knowledge.delete_note", {"note_id": "$n%02d.note_id" % (at + 1)}, at=S.plus(made, 0.2, 15))

    # -- documents ------------------------------------------------------------------
    folders = [L.force("folders", f) for f in folders]
    folders.append(L.take("folders", lambda: r.choice(["%s trip" % trip_dest, cap(themes[2]),
                                                       "%s flat" % r.choice(placew)])))
    for k, f in enumerate(folders):
        S.cmd("core.create_folder", {"name": f}, kind="folders", as_="fo%02d" % (k + 1), at=S.ago(60, 900))
    docs = []
    for w in themes:
        docs.append(L.take("documents", lambda: "%s %s" % (cap(w), r.choice(DOC_TAILS))))
    docs.append(L.force("documents", "%s booking %s" % (trip_dest, r.choice(["confirmation", "receipt",
                                                                             "voucher"]))))
    for _ in range(r.randint(9, 15)):
        docs.append(L.take("documents", lambda: fmt(r.choice([
            "{noun} %s" % r.choice(DOC_TAILS), "{noun} %s {year}" % r.choice(DOC_TAILS),
            "%s %s %s" % (r.choice(brands), r.choice(LOCKER_SVC), r.choice(DOC_TAILS)),
            "{place} %s" % r.choice(["permit", "booking", "membership form", "receipt"])]))))
    fam_doc = L.take("doc-family", lambda: r.choice(FAMILY_DOC))
    for j in range(r.randint(3, 4)):
        docs.append(L.force("documents", "%s (%02d)" % (fam_doc, j + 1)))
    tw_doc = trash_words[3]
    docs.append(L.force("documents", "%s %s" % (cap(tw_doc), r.choice(DOC_TAILS))))
    trash_docs = {len(docs) - 1}
    starred = set(r.sample(range(len(docs) - 1), r.randint(3, 5)))
    trash_docs.add(r.choice([k for k in range(6, len(docs) - 5) if k not in starred]))
    doc_folder = {}
    for k, title in enumerate(docs):
        text = "# %s\n\nRef %s-%04d. Contact: %s. Filed %s." % (
            title, re.sub(r"[^A-Z]", "", title.upper())[:3] or "DOC", r.randint(0, 9999),
            r.choice(people)["name"], (now - dt.timedelta(days=r.randint(1, 400))).date().isoformat())
        body = {"title": title, "data_uri": "data:text/markdown," + urllib.parse.quote(text)}
        if trip_dest in title and folders[-1].startswith(trip_dest):
            body["folder_id"] = "$fo%02d.folder_id" % len(folders)
        elif k == 0 or r.random() < 0.85:
            body["folder_id"] = "$fo%02d.folder_id" % (1 if k == 0 else r.randrange(len(folders)) + 1)
        if "folder_id" in body:
            doc_folder[title] = folders[int(body["folder_id"][3:5]) - 1]
        ref = "d%02d" % (k + 1)
        made = S.cmd("core.add_document", body, kind="documents", as_=ref, at=S.ago(1, 400))
        if k not in starred and k not in trash_docs:
            # add_document's own `SET current_revision_id` fires the touch trigger, which
            # stamps updated_at from the WALL clock; a same-title rename puts the
            # seeding clock back on the row (starring and trashing do it themselves)
            S.cmd("core.rename_document", {"document_id": "$%s.document_id" % ref, "title": title},
                  at=made + dt.timedelta(minutes=1))
        if k in starred:
            S.cmd("core.star_document", {"document_id": "$%s.document_id" % ref}, at=S.plus(made, 0, 30))
        elif k in trash_docs:
            S.cmd("core.trash_document", {"document_id": "$%s.document_id" % ref}, at=S.plus(made, 0.2, 30))

    # -- people's ledger: interactions (0, 1 or several per person), debts ----------------
    talk = r.sample(humans, r.randint(9, 14))
    act_count = {}
    for k, p in enumerate(talk):
        n = r.randint(2, 4) if k < 3 else 1
        for _ in range(n):
            kind = r.choice(list(KINDS_OF_TALK))
            text = r.choice(KINDS_OF_TALK[kind]).format(topic=r.choice(["the %s" % r.choice(nouns),
                                                                        r.choice(acts).lower(),
                                                                        "the %s trip" % trip_dest]),
                                                         place=r.choice(home_places)["name"],
                                                         thing=r.choice(nouns))
            off = r.choice([-r.randint(0, 6), monday - 7 + r.randint(0, 6), -r.randint(8, 40)])
            when = min(day_at(now, off, r.randint(8, 21), r.choice([0, 15, 30, 45])), now - dt.timedelta(hours=1))
            S.cmd("people.log_interaction", {"party_id": pid(p), "kind": kind, "text": text}, kind="activities",
                  at=when)
            act_count[p["name"]] = act_count.get(p["name"], 0) + 1
    ex["interaction_party"] = talk[0]["name"]  # several
    ex["interaction_single"] = talk[-1]["name"]
    debts = []
    debtors = r.sample(social + by_group["work"], r.randint(6, 9))
    for k, p in enumerate(debtors):
        direction = ["owe", "owed"][k % 2] if k < 4 else r.choice(["owe", "owed"])
        reason = L.take("obligations", lambda: r.choice([
            cap(r.choice(nouns)) + " " + r.choice(EXP_TAILS), "%s %s" % (trip_dest, r.choice(EXP_TAILS)),
            cap(r.choice(themes)) + " " + r.choice(EXP_TAILS), "Dinner at %s" % venue["name"],
            "%s %s" % (r.choice(acts), r.choice(EXP_TAILS))]))
        ref = "db%02d" % (k + 1)
        S.cmd("people.add_debt", {"party_id": pid(p), "direction": direction,
                                  "amount_minor": r.choice([500, 1200, 2000, 2500, 3500, 4800, 7500, 15000]),
                                  "reason": reason}, kind="obligations", as_=ref, at=S.ago(12, 120))
        debts.append({"ref": ref, "party": p["name"], "direction": direction, "reason": reason, "settled": False})
    for d in r.sample(debts[4:], min(2, len(debts) - 4)):
        S.cmd("people.settle_debt", {"debt_id": "$%s.debt_id" % d["ref"]}, at=S.ago(1, 10))
        d["settled"] = True
    ex["debt_party"] = debts[0]["party"]

    # -- tally ------------------------------------------------------------------------------
    groups = []
    gspecs = [("%s trip" % past_dest, trip_people),
              ("%s %s" % (cap(themes[2]), r.choice(GROUP_TAILS)), r.sample(social + by_group["neighbour"],
                                                                         r.randint(2, 4))),
              (r.choice(["%s house share" % r.choice(placew), "Number %d %s" % (r.randint(2, 90), r.choice(
                  ["house", "flat", "kitty"])), "%s %s" % (r.choice(hobbies).capitalize(), r.choice(GROUP_TAILS))]),
               r.sample(social + by_group["neighbour"] + by_group["work"], r.randint(2, 5)))]
    for k, (name, members) in enumerate(gspecs[:r.randint(2, 3)] if r.random() < 0.3 else gspecs):
        name = L.force("groups", name)
        ref = "g%02d" % (k + 1)
        S.cmd("tally.create_group", {"name": name, "icon": r.choice(GROUP_ICONS), "currency": currency,
                                     "member_ids": [pid(p) for p in members]}, kind="groups", as_=ref,
              at=S.ago(trip_back + 5, trip_back + 40) if k == 0 else S.ago(40, 400))
        groups.append({"ref": ref, "members": members, "name": name})
    fam_exp = L.take("exp-family", lambda: r.choice(FAMILY_EXP))
    fam_left = r.randint(3, 4)
    n_exp = r.randint(18, 32)
    for k in range(n_exp):
        g = groups[k % len(groups)] if k < len(groups) * 2 else r.choice(groups)
        spent = (now - dt.timedelta(days=r.randint(0, 38))).date()
        if g is groups[0]:
            spent = (now - dt.timedelta(days=trip_back - r.randint(0, 3))).date()
            desc = L.take("expenses", lambda: r.choice(["%s %s" % (past_dest, r.choice(EXP_TAILS)),
                                                        "%s %s" % (r.choice(trip_places)["name"],
                                                                   r.choice(EXP_TAILS)),
                                                        "Ferry to %s" % past_dest, "Car hire",
                                                        "Dinner on the last night", "%s %s" % (
                                                            cap(r.choice(nouns)), r.choice(EXP_TAILS))]))
        elif fam_left and k % 5 == 1 and ("%s (wk %02d)" % (fam_exp, week_no(spent))).lower() not in \
                L.used.get("expenses", set()):
            desc = L.force("expenses", "%s (wk %02d)" % (fam_exp, week_no(spent)))
            fam_left -= 1
        elif k < 9:
            desc = L.take("expenses", lambda: "%s %s" % (cap(themes[k % 5]), r.choice(EXP_TAILS)))
        else:
            desc = L.take("expenses", lambda: fmt(r.choice(["{noun} %s" % r.choice(EXP_TAILS),
                                                            "{act} %s" % r.choice(EXP_TAILS),
                                                            "Dinner at {place}", "{noun}"])))
        everyone = ["$me.party_id"] + [pid(p) for p in g["members"]]
        payer = r.choice(everyone[:1] * 2 + everyone[1:])
        split = [x for x in everyone if x == payer or r.random() < 0.8]
        if len(split) < 2:
            split = everyone[:2] if payer in everyone[:2] else [payer, everyone[0]]
        amount = r.choice([r.randint(3, 60) * 100 + r.choice([0, 50, 99]), r.randint(300, 25000)])
        base_share = amount // len(split)
        rest = amount - base_share * len(split)
        splits = [{"party_id": x, "share_minor": base_share + (rest if x == payer else 0)} for x in split]
        S.cmd("tally.add_expense", {"group_id": "$%s.group_id" % g["ref"], "description": desc,
                                    "amount_minor": amount, "paid_by": payer,
                                    "category": r.choice(CATEGORIES), "spent_on": spent.isoformat(),
                                    "splits": splits}, kind="expenses",
              at=dt.datetime(spent.year, spent.month, spent.day, tr.randint(8, 22), tr.randint(0, 59), tzinfo=UTC))
    g = groups[-1]
    paid = now - dt.timedelta(days=r.randint(1, 6))
    S.cmd("tally.settle_up", {"from_party": pid(g["members"][0]), "to_party": "$me.party_id",
                              "amount_minor": r.choice([500, 1000, 1500]), "group_id": "$%s.group_id" % g["ref"],
                              "paid_on": paid.date().isoformat()}, at=paid)

    # -- locker (canonical lines: the seat seals the content) -------------------------------
    items = [("login", L.take("locker", lambda: "%s club %s" % (cap(themes[3]), r.choice(LOGIN_TAILS)))),
             ("wifi", L.force("locker", "%s wifi" % venue["name"])),
             ("wifi", L.take("locker", lambda: r.choice(["Home wifi", "%s house wifi" % r.choice(placew),
                                                         "Guest wifi", "Studio wifi"]))),
             ("card", L.take("locker", lambda: "%s %s card" % (cap(r.choice(CARD_WORDS)), r.choice(CARD_BRANDS)))),
             ("note", L.take("locker", lambda: "%s villa %s" % (trip_dest, r.choice(NOTE_TAILS))))]
    while len(items) < r.randint(9, 14):
        roll = r.random()
        if roll < 0.45:
            items.append(("login", L.take("locker", lambda: "%s %s %s" % (r.choice(brands), r.choice(LOCKER_SVC),
                                                                          r.choice(LOGIN_TAILS)))))
        elif roll < 0.6:
            items.append(("card", L.take("locker", lambda: "%s %s card" % (r.choice(brands), r.choice(
                CARD_WORDS)))))
        elif roll < 0.75:
            items.append(("membership", L.take("locker", lambda: "%s membership" % r.choice(acts))))
        elif roll < 0.85:
            items.append(("password", L.take("locker", lambda: "%s router password" % r.choice(brands))))
        else:
            items.append(("note", L.take("locker", lambda: "%s %s" % (r.choice(
                ["Alarm", "Bike lock", "Safe", "Garage", "Shed", cap(r.choice(nouns))]), r.choice(NOTE_TAILS)))))
    for typ, title in items:
        p = r.choice(humans)
        if typ in ("login", "password", "membership"):
            content = "username %s.%s · password %s-%s-%d" % (
                re.sub(r"[^a-z]", "", p["first"].lower()), p["last"].lower()[:1], r.choice(SECRET_WORDS),
                r.choice(SECRET_WORDS), r.randint(10, 99))
        elif typ == "card":
            content = "card number 4%03d %04d %04d %04d · expires %02d/%02d · cvc %03d" % (
                r.randint(0, 999), r.randint(0, 9999), r.randint(0, 9999), r.randint(0, 9999), r.randint(1, 12),
                (now.year + r.randint(1, 4)) % 100, r.randint(0, 999))
        elif typ == "wifi":
            content = "network %s-%d · key %s%d" % (cap(r.choice(SECRET_WORDS)), r.randint(1, 9),
                                                    r.choice(SECRET_WORDS), r.randint(100, 999))
        else:
            content = r.choice(["PIN %04d" % r.randint(0, 9999), "code %06d" % r.randint(0, 999999)])
        S.canon('locker.add_item{type: "%s", title: "%s", content: "%s"}' % (typ, title, content), kind="locker items",
                at=S.ago(3, 700))

    # -- the People journal -------------------------------------------------------
    # One entry always lands last week and one earlier this week (when there is one).
    back = set(r.sample(range(1, 22), r.randint(5, 8)))
    back.add(now.weekday() + r.randint(1, 7))
    if now.weekday() > 0:
        back.add(r.randint(1, now.weekday()))
    journal = []
    for d in sorted(back, reverse=True):
        t = day_at(now, -d, 12)
        text = r.choice(["Long day; mostly {x}", "Thinking about {x}", "Good news about {x}", "Worried about {x}",
                         "Sorted out {x} at last", "Quiet evening after {x}"]).format(
            x=r.choice(["the %s" % r.choice(nouns), r.choice(acts).lower(), "the %s trip" % trip_dest]))
        mood = r.choice(JOURNAL_MOODS)
        S.cmd("people.add_journal_entry", {"mood": mood, "text": text, "entry_date": t.strftime("%Y-%m-%d")},
              kind="journal notes", at=t + dt.timedelta(hours=9, minutes=tr.randint(0, 120)))
        journal.append({"date": t.strftime("%Y-%m-%d"), "mood": mood})

    # -- the manifest -------------------------------------------------------------
    live = {k: set(v) for k, v in L.all.items()}
    trashed = [("photos", trash_photo["title"], tw_photo), ("tasks", trash_task["title"], tw_task),
               ("notes", notes[max(trash_notes)], tw_note), ("documents", docs[max(trash_docs)], tw_doc),
               ("notes", notes[min(trash_notes)], None), ("documents", docs[min(trash_docs)], None)]
    for kind, title, _ in trashed:
        live[kind].discard(title)
    # the trash-only words really are nowhere else
    for kind, title, w in trashed:
        if w and any(w in toks(x) for v in live.values() for x in v):
            raise RuntimeError("w%02d: trash word %r is also live" % (i, w))
    # keywords shared across kinds (live labels)
    kinds_of = {}
    for kind, labels in live.items():
        k8 = {"event-family": "events", "task-family": "tasks", "note-family": "notes", "doc-family": "documents",
              "exp-family": "expenses", "locker": "locker items"}.get(kind, kind)
        for x in labels:
            for t in toks(x):
                if t not in STRUCTURAL and len(t) > 2:
                    kinds_of.setdefault(t, set()).add(k8)
    shared = {t: sorted(k) for t, k in sorted(kinds_of.items()) if len(k) >= 2}
    firsts_clash = {}
    for p in humans:
        firsts_clash.setdefault(p["first"], []).append(p["name"])
    firsts_clash = {f: n for f, n in firsts_clash.items() if len(n) > 1}
    live_locker = [(typ, title) for typ, title in items]
    ex.update(album=album_titles[0], photo_place=trip_places[0]["name"], home_place=home_places[1]["name"],
              group=groups[0]["name"], theme_event=themes[0], theme_task=themes[0], venue=venue["name"],
              trip=trips[0]["title"], shared_first=sorted(firsts_clash)[0],
              locker_shared=themes[3], trash_only=[{"kind": k, "title": t, "word": w} for k, t, w in trashed if w],
              face_photo=next(iter(faces)) if faces else None,
              face_person=next(iter(faces.values()))[0]["name"] if faces else None)
    meta = {
        "now": iso(now), "weekday": now.strftime("%A"), "region": region, "currency": currency,
        "themes": themes, "vocab": vocab, "counts": S.count,
        "people": [{"name": p["name"], "first": p["first"], "last": p["last"], "role": p["role"],
                    "group": p["group"], "channels": channels.get(p["name"], []),
                    "activities": act_count.get(p["name"], 0)} for p in people],
        "shared_first_names": sorted(firsts_clash), "first_name_clashes": firsts_clash,
        "important_dates": [{"label": a, "party": b} for a, b in dates],
        "debts": [{k: v for k, v in d.items() if k != "ref"} for d in debts],
        "groups": [{"name": g["name"], "members": [p["name"] for p in g["members"]]} for g in groups],
        "albums": album_titles, "places": [p["name"] for p in home_places],
        "trip_places": [p["name"] for p in trip_places], "trips": trips,
        "folders": folders, "document_folders": doc_folder, "notebooks": nb_names,
        "locker": [{"type": a, "title": b} for a, b in live_locker],
        "favorites": [p["title"] for p in favs], "starred": [docs[k] for k in sorted(starred)],
        "trashed": [{"kind": k, "title": t, "only_in_trash": w} for k, t, w in trashed],
        "tasks_done_last_week": [t["title"] for t in done_last_week],
        "undated_tasks": [t["title"] for t in tasks if t.get("due", "unset") is None],
        "journal": journal,
        "faces_intended": [{"photo": t, "people": [p["name"] for p in ps]} for t, ps in faces.items()],
        "shared_keywords": shared,
        "labels": {k: sorted(v) for k, v in sorted(live.items()) if not k.endswith("-family")},
        "examples": ex,
    }
    spec = {"now_ms": int(now.timestamp() * 1000), "seed": "v8-trainworld/%s/w%02d" % (seed, i), "writes": S.writes,
            "meta": meta}
    check_spec(spec, "w%02d" % i)
    return spec


# ---------------------------------------------------------------------------
# vocabulary spread over the worlds
# ---------------------------------------------------------------------------

def vocab_stats(specs):
    """content keywords (label tokens minus the shared template words) and how many
    worlds each appears in"""
    per = {}
    for name, spec in specs.items():
        words = set()
        for labels in spec["meta"]["labels"].values():
            for x in labels:
                words |= {t for t in toks(x) if t not in STRUCTURAL and len(t) > 2}
        for t in words:
            per.setdefault(t, set()).add(name)
    spread = sorted(((len(v), t) for t, v in per.items()), reverse=True)
    hist = {}
    for n, _ in spread:
        hist[n] = hist.get(n, 0) + 1
    cats = {}
    for t in per:
        c = CATEGORY.get(t, "other")
        cats[c] = cats.get(c, 0) + 1
    return {"distinct_keywords": len(per), "max_worlds": spread[0][0] if spread else 0,
            "worlds_histogram": dict(sorted(hist.items())), "over_3": [(t, n) for n, t in spread if n > 3],
            "categories": cats}


# ---------------------------------------------------------------------------
# verification: build each world with tool-loop and probe it
# ---------------------------------------------------------------------------

BIN = os.path.join(REPO, "target", "release", "tool-loop")


class Server:
    def __init__(self, path):
        t0 = time.time()
        self.p = subprocess.Popen([BIN, "serve", "--world", "spec:" + path], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        self.today = self.send({"op": "open"})
        self.build_s = time.time() - t0

    def send(self, msg):
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        if not line:
            raise RuntimeError("tool-loop exited: " + self.p.stderr.read())
        return json.loads(line)

    def call(self, line):
        """one call in a fresh turn (a refused or clarifying call ends its turn)"""
        self.send({"op": "turn", "request": "verify"})
        return self.send({"op": "call", "line": line}).get("obs", "")

    def peek(self, line):
        return self.send({"op": "peek", "line": line})

    def close(self):
        try:
            self.p.stdin.write(json.dumps({"op": "quit"}) + "\n")
            self.p.stdin.flush()
        except Exception:
            pass
        self.p.wait()


ROW = re.compile(r'^#(\d+) ([a-z]+(?: [a-z]+)?) "([^"]*)"', re.M)


def rows_of(obs):
    return [(n, k) for n, k, _ in ROW.findall(obs)]


def count_of(obs):
    m = re.search(r"… (\d+) rows in all", obs)
    return int(m.group(1)) if m else len(ROW.findall(obs))


def number_of(obs):
    m = re.match(r"= (-?\d+)", obs.strip())
    return int(m.group(1)) if m else None


def q(s):
    return s.replace('"', '\\"')


def walk(sv, source, label, link):
    """`show (<source> called "<label>")`, then `show (<link> of (#n))` on its rows until one answers"""
    sv.send({"op": "open"})
    for n, _ in rows_of(sv.call('show (%s called "%s")' % (source, q(label))))[:6]:
        got = sv.call("show (%s of (#%s))" % (link, n))
        if rows_of(got):
            return count_of(got)
    return 0


# probes allowed to come back empty (none since tool-loop honours `at` and `faces`)
KNOWN_EMPTY = set()


def verify(path, spec):
    sv = Server(path)
    meta, ex = spec["meta"], spec["meta"]["examples"]
    out = {"build_s": round(sv.build_s, 2), "today": sv.today.get("today")}
    kinds = ["parties", "events", "tasks", "notes", "journal notes", "documents", "photos", "albums", "places",
             "groups", "members", "expenses", "locker items", "notebooks", "contact channels", "important dates",
             "activities", "obligations"]
    out["counts"] = {k: len(sv.peek("show (%s)" % k).get("rows", [])) for k in kinds}
    checks = {}
    for k, w in enumerate(meta["themes"]):
        got = sorted({kd for _, kd in rows_of(sv.call('search "%s"' % w))})
        out.setdefault("theme_kinds", {})[w] = got
        checks["search <theme %d> (3+ kinds)" % (k + 1)] = int(len(got) >= 3)
    walks = [("parties of (#event)", "events", ex.get("event_with_attendees"), "parties"),
             ("parties of (#trip event)", "events", ex["trip"], "parties"),
             ("photos of (#album)", "albums", ex["album"], "photos"),
             ("photos of (#trip place)", "places", ex["photo_place"], "photos"),
             ("photos of (#home place)", "places", ex["home_place"], "photos"),
             ("expenses of (#group)", "groups", ex["group"], "expenses"),
             ("members of (#group)", "groups", ex["group"], "members"),
             ("contact channels of (#party)", "parties", ex["channel_party"], "contact channels"),
             ("important dates of (#party)", "parties", ex["date_party"], "important dates"),
             ("activities of (#party) several", "parties", ex["interaction_party"], "activities"),
             ("activities of (#party) one", "parties", ex["interaction_single"], "activities"),
             ("obligations of (#party)", "parties", ex["debt_party"], "obligations"),
             ("tasks of (#task) (subtasks)", "tasks", ex["parent_task"], "tasks")]
    for label, source, name, link in walks:
        checks[label] = walk(sv, source, name, link) if name else 0
    checks["activities of (#party) several"] = int(checks["activities of (#party) several"] >= 2)
    sv.send({"op": "open"})
    tw = {t["kind"]: t for t in ex["trash_only"]}
    for label, line in [
        ("documents that (folder = …)", 'show (documents that (folder = "%s"))' % q(meta["folders"][0])),
        ("notes that (notebooks contains …)", 'show (notes that (notebooks contains "%s"))' % q(meta["notebooks"][0])),
        ('locker items that (type = "login")', 'show (locker items that (type = "login"))'),
        ('locker items that (type = "wifi")', 'show (locker items that (type = "wifi"))'),
        ('locker items that (type = "card")', 'show (locker items that (type = "card"))'),
        ('locker items that (type = "note")', 'show (locker items that (type = "note"))'),
        ('tasks that (status != "completed")', 'show (tasks that (status != "completed"))'),
        ('tasks that (status = "completed")', 'show (tasks that (status = "completed"))'),
        ("tasks that (due_at is null)", "show (tasks that (due_at is null))"),
        ("tasks that (effort_min = 45)", "show (tasks that (effort_min = 45))"),
        ("tasks that (completed_at during last week)", "show (tasks that (completed_at during last week))"),
        ("tasks that (completed_at during today)", "show (tasks that (completed_at during today))"),
        ("things during this weekend", "show (things during this weekend)"),
        ("events during this week", "show (events during this week)"),
        ("events during next week", "show (events during next week)"),
        ('photos that (favorite = true)', 'show (photos that (favorite = "true"))'),
        ('documents that (starred = true)', 'show (documents that (starred = "true"))'),
        ('parties called <shared first>', 'show (parties called "%s")' % q(ex["shared_first"])),
        ('events called <theme> (2+)', 'show (events called "%s")' % q(ex["theme_event"])),
        ('tasks called <theme> (2+)', 'show (tasks called "%s")' % q(ex["theme_task"])),
        ("important dates", "show (important dates)"),
        ('important dates that (label != "Birthday")', 'show (important dates that (label != "Birthday"))'),
        ("important dates during next 2 weeks", "show (important dates during next 2 weeks)"),
        ("activities during last week", "show (activities during last week)"),
        ("parties that (owed_to_me_minor > 0)", "show (parties that (owed_to_me_minor > 0))"),
        ("parties that (owed_to_them_minor > 0)", "show (parties that (owed_to_them_minor > 0))"),
        ("journal notes", "show (journal notes)"),
        ("journal notes during last week", "show (journal notes during last week)"),
        ("notes that (deleted_at is not null)", "show (notes that (deleted_at is not null))"),
        ("documents that (deleted_at is not null)", "show (documents that (deleted_at is not null))"),
        ("photos that (deleted_at is not null)", "show (photos that (deleted_at is not null))"),
        ("tasks that (deleted_at is not null)", "show (tasks that (deleted_at is not null))"),
        ('events called <trip> (multi-day)', 'show (events called "%s")' % q(ex["trip"])),
        ('(contact channels) that (kind = "phone")', 'show ((contact channels) that (kind = "phone"))'),
        ('(contact channels) that (kind = "email")', 'show ((contact channels) that (kind = "email"))'),
    ]:
        checks[label] = count_of(sv.call(line))
    for label in ('events called <theme> (2+)', 'tasks called <theme> (2+)', 'parties called <shared first>'):
        checks[label] = int(checks[label] >= 2)
    # a trashed row whose keyword only matches in the trash
    ok = 0
    for kind, t in tw.items():
        live_n = count_of(sv.call('show (%s called "%s")' % (kind, q(t["word"]))))
        dead_n = count_of(sv.call('show (%s called "%s") that (deleted_at is not null)' % (kind, q(t["word"]))))
        ok += int(live_n == 0 and dead_n >= 1)
    checks["trash-only keyword (of %d kinds)" % len(tw)] = int(ok == len(tw))
    # the shared locker keyword reaches the locker and another kind
    got = {k for _, k in rows_of(sv.call('search "%s"' % q(ex["locker_shared"])))}
    checks["search <locker keyword> (locker + other)"] = int("locker item" in got and len(got) >= 2)
    got = {k for _, k in rows_of(sv.call('search "%s"' % q(ex["venue"])))}
    checks["search <venue> (locker + place + other)"] = int("locker item" in got and "place" in got)
    # a non-zero balance inside the first group
    sv.send({"op": "open"})
    g = [n for n, k, t in ROW.findall(sv.call("show (groups)")) if t == ex["group"]]
    nz = 0
    if g:
        for n, k, t in ROW.findall(sv.call("show (members of (#%s))" % g[0])):
            if t != "You":
                v = number_of(sv.call("balance of (#%s) in (#%s)" % (n, g[0])))
                if v:
                    nz += 1
    checks["balance of (#member) in (#group) != 0"] = nz
    # faces
    checks["photos of (#party) (faces)"] = 0
    if ex.get("face_photo"):
        sv.send({"op": "open"})
        for n, _ in rows_of(sv.call('show (photos called "%s")' % q(ex["face_photo"])))[:1]:
            checks["photos of (#party) (faces)"] = count_of(sv.call("show (parties of (#%s))" % n))
    checks["photos of (#person) (faces)"] = walk(sv, "parties", ex["face_person"], "photos") \
        if ex.get("face_person") else 0
    # every change after its row's creation: a trashed row's own date is its
    # trash date, a completed task's completed_at is after it was added
    out["checks"] = checks
    out["failed"] = [k for k, v in checks.items() if k not in KNOWN_EMPTY and not v]
    out["known_empty"] = sorted(k for k in KNOWN_EMPTY if not checks.get(k))
    first = dump(sv)
    sv.close()
    # two builds of the world answer byte for byte the same
    sv2 = Server(path)
    second = dump(sv2)
    sv2.close()
    checks["two builds byte-identical"] = int(first == second)
    if first != second:
        out["failed"].append("two builds byte-identical")
    return out


DUMP_KINDS = ["parties", "events", "tasks", "notes", "journal notes", "documents", "photos", "albums", "places",
              "groups", "members", "expenses", "settlements", "locker items", "notebooks",
              "contact channels", "important dates", "activities", "obligations"]


def dump(sv):
    """every row of every kind (live and trashed) as JSON, plus numbered observations and `get`s"""
    sv.send({"op": "open"})
    out = []
    for k in DUMP_KINDS:
        out.append(json.dumps(sv.peek("show (%s)" % k), sort_keys=True))
        out.append(json.dumps(sv.peek("show (%s that (deleted_at is not null))" % k), sort_keys=True))
    for k in DUMP_KINDS:
        obs = sv.call("show (%s)" % k)
        out.append(obs)
        for n, _ in rows_of(obs)[:3]:
            out.append(sv.call("get #%s" % n))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--out", default=os.path.join(HERE, "worlds"))
    ap.add_argument("--seed", default="v8")
    ap.add_argument("--verify", action="store_true", help="build each world with tool-loop and probe it")
    ap.add_argument("--stats", action="store_true", help="print the vocabulary spread")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    A = Alloc()
    specs = {}
    report = {}
    for i in range(1, a.n + 1):
        spec = build_world(i, a.seed, A)
        specs["w%02d" % i] = spec
        path = os.path.abspath(os.path.join(a.out, "w%02d.json" % i))
        with open(path, "w", encoding="utf-8") as f:
            json.dump(spec, f, ensure_ascii=False, indent=0)
        m = spec["meta"]
        print("w%02d %s %-9s %-13s writes=%d %s" % (i, m["now"], m["weekday"], m["region"], len(spec["writes"]),
                                                    json.dumps(m["counts"])), flush=True)
        if a.verify:
            for attempt in range(3):
                try:
                    report["w%02d" % i] = verify(path, spec)
                    break
                except (RuntimeError, BrokenPipeError, json.JSONDecodeError) as e:  # a parallel rebuild of the binary
                    if attempt == 2 or ": write " in str(e):
                        raise
                    print("retry w%02d: %s" % (i, str(e)[:200]), flush=True)
                    time.sleep(20)
            print(json.dumps({k: v for k, v in report["w%02d" % i].items() if k != "checks"}), flush=True)
    stats = vocab_stats(specs)
    stats["allocator_overflow"] = A.overflow
    with open(os.path.join(a.out, "vocab.json"), "w") as f:
        json.dump(stats, f, indent=1)
    if a.stats or a.verify:
        print(json.dumps({k: v for k, v in stats.items() if k != "over_3"}))
        print("over 3 worlds:", stats["over_3"][:40])
    if a.verify:
        summary = {}
        for w, rep in report.items():
            for k, v in rep["checks"].items():
                passed = bool(v)
                summary.setdefault(k, 0)
                summary[k] += int(passed)
        report["_summary"] = {"worlds": len(specs), "pass_counts": summary,
                              "build_s": sorted(rep["build_s"] for w, rep in report.items() if w.startswith("w"))}
        with open(os.path.join(a.out, "verify.json"), "w") as f:
            json.dump(report, f, indent=1)
        for k, v in summary.items():
            print("%-48s %d/%d%s" % (k, v, len(specs), "  (known empty)" if k in KNOWN_EMPTY else ""))


if __name__ == "__main__":
    main()

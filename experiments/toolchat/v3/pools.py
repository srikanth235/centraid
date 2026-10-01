"""Out-of-world literal pools for v3. Invented for this set: none of the
names/places/titles below is taken from the evaluation suite, from
canon-model/data/distill_world.py, or from v2/r2/constructs.py, and none
contains a forbidden name (checked by `check_pools()`)."""
FIRST = ["Ilse", "Joaquim", "Wendell", "Soraya", "Emrys", "Kalinda", "Birgit", "Desmond",
         "Folasade", "Gideon", "Henrike", "Ismael", "Jolene", "Lucinda", "Mauricio", "Nadia",
         "Orla", "Pascal", "Quentin", "Rosalia", "Stellan", "Teodora", "Umberto", "Vesna",
         "Winifred", "Xavier", "Yolanda", "Zbigniew", "Agnieszka", "Benedikt", "Clementine",
         "Dorian", "Esme", "Florian", "Greta", "Horatio", "Imogen", "Jasper", "Keziah",
         "Leopold", "Margit", "Niamh", "Oriane", "Percival", "Rufus", "Saskia", "Thibault",
         "Ursula", "Viggo", "Wilhelmina", "Yannick", "Zelda", "Arvid", "Brigid", "Cormac",
         "Dalia", "Elio", "Fern", "Gwilym", "Hedda", "Idris", "Juno", "Kit", "Lark", "Mabel",
         "Nils", "Otto", "Pippa", "Quincy", "Rhiannon", "Sol", "Tove", "Uriel", "Vivienne",
         "Wren", "Ximena", "Yara", "Zeno", "Bastian", "Coral"]
LAST = ["Abernathy", "Blomqvist", "Cavendish", "Dunmore", "Espinoza", "Falkenberg", "Gallagher",
        "Hendricks", "Ibarra", "Jablonski", "Kowalczyk", "Lachance", "Maddox", "Nakagawa",
        "Oyelowo", "Pellegrini", "Quigley", "Rasmussen", "Sandoval", "Thackeray", "Ulrich",
        "Varga", "Whitlock", "Yamamoto", "Zamora", "Achebe", "Birkett", "Coutinho", "Delacroix",
        "Eklund", "Fontaine", "Grieve", "Holloway", "Iwasaki", "Jennings", "Kavanagh", "Larkin",
        "Moreau", "Novak", "Ormsby", "Prescott", "Quayle", "Renwick", "Salazar", "Tennant",
        "Upton", "Vasquez", "Winslow", "Yardley", "Zhou", "Ashdown", "Brightman", "Crowther",
        "Dyer", "Elsworth", "Farrant", "Gunnarsson", "Hargreaves", "Ingram", "Jessop",
        "Kerrigan", "Lomax", "Merriweather", "Northcott", "Oduya", "Pritchard", "Radley",
        "Sutcliffe", "Tolliver", "Underhill", "Valdes", "Wetherby", "Yeomans", "Zuniga",
        "Bellweather", "Castell", "Draycott", "Everly", "Fothergill", "Gorman"]
PLACES = ["Harwick Point", "Gullstone Bay", "Old Mill Yard", "Brackwater Beach", "Fenwick Common",
          "Larchmont Station", "the Riverside Deli", "Kilnworth Market", "Sorrel Hill", "Ashby Lido",
          "Pinecrest Lodge", "Morrow Harbour", "Elmstead Park", "Cobble Row", "Westerly Pier",
          "Hawthorn Lane", "Quarry Lake", "Saltmarsh Cafe", "Birchgrove Library", "Oakhurst Clinic",
          "Lantern Street", "Drover's Rest", "Castlegate Square", "Foxglove Farm", "Tidewater Point",
          "Greyfriars Hall", "Ember Valley", "Porthcurl Cove", "Marram Dunes", "Northgate Pool",
          "Heron's Reach", "Coppice Wood", "Sandholme Camp", "Bellhaven Studio", "Stonecross Garage",
          "Juniper Bakery", "Rookery Fields", "Willowmere", "Kingfisher Lock", "Harbourside Gym"]
GROUPS = ["Allotment crew", "Flat 3B", "Sunday football", "Office lunch fund", "Choir tour",
          "Climbing gang", "Board games night", "Sailing club kitty", "Wedding party", "Stag weekend",
          "Camping in Ember Valley", "Porthcurl Cove holiday", "Quarry Lake swim trip", "Ski chalet 2027",
          "Porto long weekend", "Kids' carpool", "House share", "Running club", "Supper club", "Hen do",
          "Birthday present fund", "Neighbourhood watch", "Uni reunion", "Road trip north",
          "Christmas cottage", "Festival tickets", "Bike tour Brittany", "Beach house August",
          "Community garden", "Dinghy share", "Band van", "Wine club", "Quiz team", "Tennis doubles",
          "Canal boat trip", "Castlegate flat", "Farewell dinner", "Easter at Foxglove Farm",
          "Book swap", "Pub golf"]
TASKS = ["fix the gate latch", "Renew passport", "call the boiler engineer", "Book the MOT",
         "return library books", "Sort out the loft", "clean the gutters", "Pay the window cleaner",
         "reply to the landlord", "Order more printer ink", "prune the apple tree", "Submit expenses",
         "Get the bike serviced", "change the smoke alarm battery", "Buy a birthday card for Nan",
         "cancel the gym membership", "Repaint the fence", "chase the insurance claim",
         "Book flu jabs", "defrost the chest freezer", "Q3 budget review", "update the CV",
         "hang the bathroom mirror", "fix the dripping tap", "Plan the garden party",
         "Collect dry cleaning", "file the tax return", "Measure the alcove for shelves",
         "wash the car", "renew the parking permit"]
EVENTS = ["Orthodontist visit", "Team offsite", "Yoga class", "Parents' evening", "Boiler service",
          "Quarterly review", "Piano recital", "Book club meeting", "Vet appointment for Biscuit",
          "Flight to Porto", "Haircut", "Sprint planning", "Wine tasting", "Car service",
          "Housewarming", "Kids' swimming lesson", "Physio session", "Pub quiz", "Bin collection",
          "Allotment open day", "Wedding rehearsal", "Choir practice", "Parkrun", "Eye test",
          "Mortgage meeting"]
NOTES = ["Q3 budget notes", "Nan's soup recipe", "packing list for Porto", "gift ideas",
         "boiler error codes", "Books to read", "wifi setup steps", "Sourdough starter log",
         "Garden plan", "questions for the surveyor", "Holiday ideas", "car insurance comparison",
         "Podcast recommendations", "running splits", "Kitchen measurements", "things to ask the vet",
         "Christmas card list", "Recipe for lemon drizzle", "Birthday party plan", "Board game rules",
         "Spanish vocab", "tile shop quotes", "Film night picks", "notes from the school meeting",
         "Bathroom paint colours"]
DOCS = ["Tenancy agreement", "Home insurance policy", "car logbook", "Payslip March", "Passport scan",
        "Boiler warranty", "Mortgage offer", "Council tax bill", "Wedding speech draft",
        "Pension statement", "Vet records for Biscuit", "Energy bill", "Gym contract",
        "Tax return 2026", "Birth certificate copy", "Lease renewal letter",
        "Travel insurance certificate", "Nursery application", "Kitchen quote", "Driving licence scan"]
PHOTOS = ["Sunset at Tidewater Point", "Birthday cake", "the new kitchen", "Dog on the beach",
          "Snow in the garden", "Graduation day", "Harbour at dusk", "First day of school",
          "Market stall", "Mountain hut", "Street mural", "Bonfire night", "Rainbow over the fields",
          "Picnic by the lake", "Old bridge", "Cat asleep on the sofa", "Wedding toast",
          "Autumn leaves", "Castle ruins", "Frosty morning"]
ALBUMS = ["Summer 2026", "Porto trip", "Wedding", "Garden progress", "Baby's first year",
          "Best of the dog", "Hiking", "Christmas 2026", "Kitchen renovation", "Festival weekend",
          "Family portraits", "Food", "Beach days", "School plays", "Road trip north"]
LOCKER = ["Home wifi", "Netflix login", "Bank card", "Passport details", "Gym app", "Router admin",
          "Work VPN", "Joint account", "Amazon", "Council tax portal", "Spotify",
          "Car insurance login", "Garage door code", "Email backup codes", "Pension portal"]
EXPENSES = ["taxi from the station", "Groceries", "petrol", "Dinner at the Riverside Deli",
            "cinema tickets", "Airbnb deposit", "train tickets", "electricity bill", "coffee and cake",
            "ferry crossing", "parking", "Bike repair", "gas bill", "birthday present", "ski passes",
            "museum entry", "takeaway pizza", "car hire", "Internet bill", "wine for the party"]
PROJECTS = ["Kitchen refit", "Garden overhaul", "Tax return 2026", "Wedding planning",
            "Move to the new flat", "Side hustle", "Marathon training", "Attic conversion",
            "Job hunt", "Photo book"]
NOTEBOOKS = ["Recipes", "Garden log", "Work", "Travel", "Reading", "Health", "Ideas", "Home admin"]
CIRCLES = ["Family", "Old school friends", "Work crew", "Neighbours", "Climbing mates",
           "Uni friends", "In-laws", "Choir"]
ACCOUNTS = ["Joint current account", "Travel card", "Savings pot", "Credit card", "Cash wallet",
            "Business account", "ISA", "Holiday fund"]
TXNS = ["TESCO STORES", "UBER TRIP", "NETFLIX.COM", "COSTA COFFEE", "SHELL PETROL",
        "AMAZON MKTPLACE", "TRAINLINE", "DELIVEROO"]
SECRETS = ["correct-horse-42", "4471", "Blue!Door9", "tulip-88-river", "0613", "Maple#2031",
           "sunflower7", "K3ttle-drum"]
# per-field literal pools (text fields a member names)
TEXT = {
    "description": ["parking", "bring", "deposit", "zoom", "receipt", "quote", "before"],
    "start_tz": ["Europe/Lisbon", "America/Toronto", "Asia/Singapore", "Europe/Berlin"],
    "end_tz": ["Europe/Lisbon", "America/Toronto", "Asia/Singapore"],
    "tz": ["Europe/Lisbon", "America/Toronto", "Asia/Singapore", "Europe/Berlin"],
    "rrule": ["WEEKLY", "MONTHLY", "DAILY"],
    "role": ["neighbour", "plumber", "dentist", "landlord", "accountant", "piano teacher", "colleague"],
    "nickname": ["Bibi", "Doc", "Jojo", "Tiny", "Fitz"],
    "avatar_color": ["teal", "amber", "plum", "coral"],
    "met": ["university", "climbing", "choir", "work", "the allotment"],
    "label": ["birthday", "anniversary", "name day", "graduation", "work", "home", "mobile"],
    "value": ["@gmail", "+44", "@proton", "07"],
    "currency": ["GBP", "EUR", "USD"],
    "original_currency": ["EUR", "USD", "JPY", "CHF"],
    "settlement_currency": ["GBP", "EUR"],
    "rate_source": ["ecb", "manual"],
    "reason": ["tickets", "dinner", "taxi", "deposit", "groceries", "petrol"],
    "sort_name": LAST[:20],
    "icon": ["tent", "house", "ball", "plane", "music"],
    "color": ["green", "blue", "orange", "purple"],
    "area": ["home", "work", "health", "finance"],
    "username": ["admin", "@gmail", "@outlook"],
    "url": ["bank", "github", "netflix", "council"],
    "notes": ["pin", "backup", "security question"],
    "cardholder": LAST[20:30],
    "expiry": ["2028", "2029", "2030"],
    "brand": ["Visa", "Mastercard", "Amex"],
    "fullname": LAST[30:40],
    "email": ["@gmail", "@proton", "@work"],
    "phone": ["07", "+44", "+351"],
    "address": ["Road", "Lane", "Flat"],
    "network": ["HomeNet-5G", "Loft_WiFi", "Studio-Guest"],
    "folder": ["Taxes", "House", "Car", "Medical", "Work"],
}
# fields whose `= "X"` names a whole value; the rest only take `contains`
EQ_OK = {"start_tz", "end_tz", "tz", "role", "nickname", "avatar_color", "label", "currency",
         "original_currency", "settlement_currency", "rate_source", "icon", "color", "area",
         "brand", "network", "folder", "album", "place", "sort_name"}
NUMS = {
    "amount_minor": [500, 1000, 2000, 2500, 5000, 10000, 20000],
    "original_amount_minor": [1000, 5000, 10000],
    "owed_to_me": [0, 1000, 5000], "owed_to_them": [0, 1000, 5000],
    "effort_min": [15, 30, 45, 60, 90, 120], "priority": [1, 2, 3, 4],
    "remind_before_min": [10, 30, 60], "cadence_days": [7, 14, 30, 90],
    "byte_size": [1000000, 5000000, 20000000], "width": [1080, 3000, 4000],
    "height": [1080, 2000, 3000], "duration_s": [30, 60, 120], "geo_lat": [50, 51.5, 53],
    "geo_lng": [-3, 0, 2], "sequence": [0, 1, 2],
}
FLAGS = {"pinned", "is_preferred", "reminder_on", "compromised", "is_asset", "simplify_opt_in"}

REFUSE_SCENES = {
    "out_of_ontology": ["book a table at {place} for Friday night", "tell them what the weather will be in {place} tomorrow",
                        "order a taxi to {place}", "buy train tickets to {place}",
                        "play some music", "look up the opening hours of {place}",
                        "transfer money from their bank to {person}", "translate a paragraph into French",
                        "post a photo to Instagram", "find a plumber near {place} online"],
    "sealed_egress": ["email the {locker} password to {person}", "text {person} their card number",
                      "export all their passwords to a spreadsheet", "send the {locker} details to {person}",
                      "share their passport details with {person} by email", "paste the {locker} password into a message to {person}"],
    "fabricated_secret": ["make up a password for {locker} and save it", "add their bank card to the locker without giving the number",
                          "save a new {locker} login with whatever password the assistant picks",
                          "fill in their passport number (they don't give it)", "invent a PIN for the {locker} and store it"],
    "unbounded_destruction": ["delete all their notes", "wipe every photo", "clear out every task", "delete everything in the locker",
                              "bin all their documents", "remove every contact", "delete all their expenses", "cancel every event in the calendar"],
}
FORBIDDEN = ["neha", "marco", "priya", "ray", "ana", "kulkarni", "ferreira", "raman", "alvarez", "rao", "tahoe"]


def check_pools():
    import re, sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "canon-model", "data"))
    import distill_world as W
    old = set(W.FIRST) | set(W.LAST) | set(W.PLACES) | set(W.GROUPS) | set(W.TRIPS)
    for t in ("TASK", "EVENT", "NOTE", "DOC", "PHOTO", "ALBUM", "LOCKER"):
        old |= set(getattr(W, t + "_TITLES"))
    allp = FIRST + LAST + PLACES + GROUPS + TASKS + EVENTS + NOTES + DOCS + PHOTOS + ALBUMS + \
        LOCKER + EXPENSES + PROJECTS + NOTEBOOKS + CIRCLES + ACCOUNTS + TXNS
    bad = [x for x in allp if x in old]
    for x in allp:
        for tok in re.findall(r"[a-z]+", x.lower()):
            if any(tok == f or (tok.startswith(f) and len(f) >= 4) for f in FORBIDDEN) or \
                    tok in ("ray", "ana", "rao"):
                bad.append(x)
    assert not bad, bad
    assert len(set(FIRST)) >= 80 and len(set(LAST)) >= 80 and len(PLACES) >= 40 and len(GROUPS) >= 40
    return len(allp)


if __name__ == "__main__":
    print("pool literals:", check_pools())

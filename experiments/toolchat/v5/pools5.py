"""v5 pool extensions: invented labels for synthetic vaults (out-of-world).

Extends v3/pools.py; every entry is checked against pools.FORBIDDEN and the
distillation world (experiments/canon-model/data/distill_world.py) by check()."""
import os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "v3"))
import pools as P  # noqa: E402

X_TASKS = ["Reserve the lakeside cabin", "Descale the kettle", "Book the chimney sweep", "Return the hired tent",
           "Order new wiper blades", "Sign the nursery form", "Top up the travel card", "Swap the winter tyres",
           "Post the birthday parcel", "Oil the garden bench", "Renew the fishing licence", "Chase the roofer quote",
           "Bleed the radiators", "Cancel the magazine subscription", "Frame the wedding print",
           "Label the freezer boxes", "Book the piano tuner", "Replace the shed padlock", "Tidy the cable drawer",
           "Sharpen the kitchen knives", "Send the wedding cards", "Recycle the old monitor",
           "Collect the repaired watch", "Plant the tulip bulbs", "Check the loft insulation",
           "Book a table for the anniversary", "Move the compost bin", "Print the boarding passes",
           "Update the emergency contacts", "Register the new boiler"]
X_EVENTS = ["Cabin weekend at Pinecrest Lodge", "Pottery workshop", "School sports day", "Tax adviser meeting",
            "Harvest supper", "Kayak lesson", "Gutter inspection", "Dog grooming", "Chess club", "Open studio evening",
            "Photography walk", "Landlord inspection", "Blood test", "Neighbours barbecue", "Violin lesson",
            "Library talk", "Cheese tasting", "Boat licence exam", "Carpet fitting", "Garden centre trip",
            "Swimming gala", "Pension review call", "Charity quiz", "Opticians check-up", "Bike maintenance class"]
X_NOTES = ["Cabin packing list", "Paint swatches for the hall", "Ideas for the allotment shed", "Gift ideas for Tove",
           "Pottery glaze notes", "Kayak routes", "Loft clear-out plan", "Chess openings", "Wine to try",
           "Radiator bleeding steps", "Tulip planting notes", "Birthday menu", "Questions for the roofer",
           "Bike fit measurements", "Reading list for winter", "Meal plan", "Sauna etiquette", "Boat licence revision"]
X_JOURNAL = ["Chat with Orla about the move", "Dinner with Wendell", "Walk with Saskia", "Catch-up with Florian",
             "Call with Henrike about the job", "Coffee with Idris", "Thoughts after the reunion",
             "Visit to Margit's new flat", "Advice from Percival", "Long talk with Keziah"]
X_DOCS = ["Cabin booking confirmation", "Roofer quote", "Boat licence certificate", "Nursery form",
          "Tyre receipt", "Watch repair ticket", "Fishing licence", "Chimney sweep invoice", "Warranty for the kettle",
          "Loft insulation survey", "Pet passport", "Parking fine appeal", "Water bill", "Bike insurance schedule",
          "School trip consent form", "Tenancy deposit receipt", "Dental plan terms", "Solar panel contract"]
X_PHOTOS = ["Lakeside cabin at dawn", "Kayaks on the shore", "Pottery bowls drying", "Chess board in the park",
            "Tulips in the window box", "Sports day finish line", "Cheese board", "Dog after grooming",
            "Carpet samples", "Harvest table", "Frost on the bench", "Violin case", "Fishing at Quarry Lake",
            "Boat in the lock", "Lanterns in the square"]
X_PLACES = ["Lakeside Cabins", "Heatherfield Common", "Bramble Quay", "Ottery Mill", "Corbel Street Studio",
            "Pellow Sands", "Kestrel Ridge", "Marlow Yard", "Thornbury Pool", "Wickham Arcade", "Glenfarrow Falls",
            "Aldermoor Park"]
X_GROUPS = ["Cabin weekend", "Pottery class kitty", "Kayak club", "Chess night", "Allotment shed fund",
            "Bramble Quay regatta", "Lakeside holiday", "Harvest supper", "Violin carpool", "Kestrel Ridge hike"]
X_LOCKER = ["Cabin door code", "Kayak club login", "Library card", "Boiler app", "Pottery studio wifi",
            "Parking app", "Water supplier portal", "School portal", "Alarm PIN", "Bike lock code",
            "Pharmacy app", "Cloud storage account"]
X_EXPENSES = ["Cabin deposit", "Kayak hire", "Pottery clay", "Chess set", "Tulip bulbs", "Dog grooming",
              "Boat licence fee", "Cheese platter", "Carpet fitting", "Violin strings", "Roof repair", "Tyre change",
              "Fishing licence", "Harvest supper tickets", "Garden centre plants"]
X_ALBUMS = ["Lakeside cabin 2027", "Pottery", "Sports day", "Kayaking", "Tulips", "Chess club", "Harvest supper",
            "Dog", "Boat trip", "Frosty mornings"]
X_NOTEBOOKS = ["Cabin", "Pottery", "Allotment", "Kids", "Money", "Boat licence", "Chess", "Film", "Fitness"]
FOLDERS = ["Travel", "Taxes", "House", "Car", "Medical", "Work", "Insurance", "Kids", "Pets", "Receipts", "Garden",
           "Finance", "School", "Warranty", "Travel 2027", "House purchase", "Car insurance", "Pet records",
           "Bike", "Boat", "Energy", "Legal"]
ROLES = ["Dentist", "Plumber", "Landlord", "Accountant", "Piano teacher", "Electrician", "Physio", "Mechanic", "Vet",
         "Childminder", "Hairdresser", "Solicitor", "Builder", "Gardener", "Optician", "Tutor", "Personal trainer",
         "Doctor", "Estate agent", "Window cleaner", "Roofer", "Chimney sweep", "Kayak instructor", "Dog groomer"]
X_FIRST = ["Aurelio", "Bettina", "Caspar", "Dagmar", "Evander", "Faustina", "Griffin", "Honora", "Ignatius",
           "Jessamy", "Konrad", "Leocadia", "Magnus", "Nerys", "Osric", "Perpetua", "Rosamund", "Sebastiano",
           "Theodosia", "Ulysses", "Valeska", "Wystan", "Ysolde", "Zacharias"]
X_LAST = ["Ashcombe", "Brackenholt", "Coldwell", "Dunstable", "Everard", "Fernihough", "Glanville", "Hazeldine",
          "Illingworth", "Jarrold", "Kilbride", "Lovelock", "Mortimer", "Netherby", "Oakes", "Pendry", "Rookwood",
          "Stannard", "Treverrow", "Vanstone"]
BODIES = ["Running ten minutes late", "Are we still on for tonight", "Happy birthday", "Call me when you can",
          "Thanks for dinner", "The parcel arrived", "Don't forget the tickets", "On my way", "Got the keys",
          "See you at the lake", "Can you feed the cat tomorrow", "The kayak is booked"]

FIRST = P.FIRST + X_FIRST
LAST = P.LAST + X_LAST
POOL = {
    "tasks": P.TASKS + X_TASKS, "events": P.EVENTS + X_EVENTS, "notes": P.NOTES + X_NOTES,
    "journal notes": X_JOURNAL, "documents": P.DOCS + X_DOCS, "photos": P.PHOTOS + X_PHOTOS,
    "places": P.PLACES + X_PLACES, "groups": P.GROUPS + X_GROUPS, "locker items": P.LOCKER + X_LOCKER,
    "expenses": P.EXPENSES + X_EXPENSES, "album_titles": P.ALBUMS + X_ALBUMS,
    "notebooks": P.NOTEBOOKS + X_NOTEBOOKS, "folder": FOLDERS, "role": ROLES,
    "projects": P.PROJECTS, "circles": P.CIRCLES, "accounts": P.ACCOUNTS,
}
EXTRA = X_TASKS + X_EVENTS + X_NOTES + X_JOURNAL + X_DOCS + X_PHOTOS + X_PLACES + X_GROUPS + X_LOCKER + X_EXPENSES + \
    X_ALBUMS + X_NOTEBOOKS + FOLDERS + ROLES + X_FIRST + X_LAST + BODIES


def bad_token(tok):
    return any(tok == f or (tok.startswith(f) and len(f) >= 4) for f in P.FORBIDDEN) or tok in ("ray", "ana", "rao")


def old_world():
    sys.path.insert(0, os.path.join(HERE, "..", "..", "canon-model", "data"))
    import distill_world as W
    old = set(W.FIRST) | set(W.LAST) | set(W.PLACES) | set(W.GROUPS) | set(W.TRIPS)
    for t in ("TASK", "EVENT", "NOTE", "DOC", "PHOTO", "ALBUM", "LOCKER"):
        old |= set(getattr(W, t + "_TITLES"))
    return W, old


def check(extra=()):
    W, old = old_world()
    oldl = {x.lower() for x in old}
    bad = []
    for x in list(EXTRA) + list(extra):
        if x.lower() in oldl:
            bad.append(x)
        for tok in re.findall(r"[a-z]+", x.lower()):
            if bad_token(tok):
                bad.append(x)
    for x in X_FIRST + X_LAST:
        if x in set(W.FIRST) | set(W.LAST):
            bad.append(x)
    return bad


if __name__ == "__main__":
    print("bad:", check())

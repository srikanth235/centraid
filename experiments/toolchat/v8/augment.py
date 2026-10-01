"""v8 augmentation: one paraphrased session -> self-consistent variants.

A SESSION here is {"today": "today: Tuesday 2025-06-10", "turns": [{"msg",
"say", "steps": [{"call", "obs", ...}], ...}]} -- one paraphrased version of a
generated trajectory, before it is flattened into chat messages. Every
augmentation rewrites the message, the calls and the observations together,
so the session stays exactly what the runtime would have produced for that
message:

  names    every name/title/keyword the calls copy (the words of `say` phrases
           and of quoted call strings, minus the call language, routing cues
           and common English) is swapped for a fresh word, the same word
           everywhere; calls are only touched inside their quoted strings.
           Pools: ~40% real names/places from many cultures, ~30% ordinary
           nouns, ~30% invented words; a person's first/last name draws from
           the first/last pool; no word goes to more than `cap` rows.
  handles  every `#n` in calls and observations shifted by one offset, so the
           right handle can only come from reading.
  dates    `today` and every YYYY-MM-DD in calls and observations shifted by a
           whole number of WEEKS (weekday words in the message stay true).
           Only for sessions with no month/year-relative window, no ordinal
           day and no calendar date in the person's words (`can_shift`).
  amounts  a money amount the person says in digits, when a call copies it
           (a write's `amount_minor: N`, or an `amount_minor > N` threshold
           that no amount in the world or the session lies across), is
           replaced by a new amount in the message, the call and the
           write's echo.

`verify(sess)` re-parses a session: every `say` phrase is in its message;
every quoted call string (except `ask` and enum values) is in the
conversation so far (exactly, or word by word); every `#n` in a call was
shown in an earlier observation; every weekday+date pair and the `today`
line agree. A variant may not have more violations than its base.
"""
import datetime
import json
import os
import random
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLCHAT = os.path.dirname(HERE)
REPO = os.path.normpath(os.path.join(TOOLCHAT, "..", ".."))
sys.path[:0] = [os.path.join(TOOLCHAT, "v7")]
import subnames  # noqa: E402  (v7's pools and the call language's PROTECT set)

PROTECT = set(subnames.PROTECT)

# common English that titles and requests carry but that is not a keyword a
# row is found by: kept as is so "Renew the car insurance" stays a sentence
STOP = set("""
again also back before after early late soon later still just only even ever never very really quite some any
all every each other another both these those there here when where who whom which how why what whose while
until since than then into onto over under near from with without within across along around between through
one two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty sixty seventy eighty
ninety hundred thousand second third fourth fifth sixth seventh eighth ninth tenth last next half quarter
ones stuff anything everything something nothing someone anyone everyone
his her hers him she they their theirs them its your yours you our ours mine myself we us
was were been being are has have had having does did doing done will would could should shall may might must
can cant dont doesnt didnt isnt wasnt arent wont
book buy call pick send pay renew fix clean check order return bring take make get got ring write read plan
sort clear drop collect post print sign submit update prepare finish start meet find look see move put keep
give ask tell say let help need want like use try set turn run open close leave stop hold bring change
good great big small little long short high low full free best better more most less least many much few
week weeks month months year years hour hours minute minutes morning afternoon evening night tonight noon
january february march april may june july august september october november december
jan feb mar apr jun jul aug sep sept oct nov dec mon tue tues wed thu thur thurs fri sat sun
mum mom dad nan gran grandma grandpa nana papa auntie uncle aunt son daughter wife husband partner kids kid
please thanks thank yes okay sure maybe
""".split())

DAY_WORDS = {"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "today",
             "tomorrow", "yesterday", "weekend", "tonight"}

# enum values a call quotes that are vocabulary, not a copy of the message
ENUM_KEYS = ("status", "kind", "type", "columns", "role")

EXTRA_FIRST = """
Abimbola Adaora Adnan Afia Agneta Ahanu Aigerim Ainhoa Akosua Alejandro Aleksandra Alibek Amaru Amaya Amina
Anahera Anand Anastasia Andrzej Aneirin Angharad Anjali Ansgar Antonella Anuradha Aputsiaq Araceli Arkady
Armando Arnav Asel Ashkan Asuka Ataahua Aukje Ayumi Azadeh Baraka Bartek Basia Beatriz Bedelia Bettina
Bilal Birte Boris Branwen Bukola Candela Catalina Chayton Chiamaka Chioma Ciaran Colm Consuelo Dafydd Daisuke
Danuta Darius Dervla Diarmuid Dilnoza Dobromir Dolores Duc Dumisani Dzifa Eber Edurne Efrat Eiko Eirlys
Ekaterina Eluned Emiliano Enrique Erlend Esperanza Estelle Eulalia Ezinne Fadila Fatima Federica Felipe Fenna
Feodora Fiadh Florin Folasade Fransisca Frederik Gabor Gaia Gaurav Gedeon Geraint Ghislaine Gintare Giorgos
Grazyna Guadalupe Gulnara Gwenllian Habib Hadewych Haidee Hakon Hana Hatice Heike Heledd Hilario Hinemoa
Honoka Huong Ifeoma Ignatius Ilkka Imke Inger Ines Ioana Irmgard Isolde Itzel Ivana Iwona Jadwiga Jaroslav
Jiho Joanna Jolanta Jorge Juanita Jurgen Kaede Kaija Kalinda Kamila Kanat Karolina Kasimir Katja Kawika Keiko
Kerttu Khadija Kieran Kimi Kirra Kiyoshi Konrad Kristiina Kunle Laszlo Leocadia Lerato Leszek Lidia Liesel
Lindiwe Liudmila Lorenza Luana Lucja Lumi Luzia Macarena Maeve Mahesh Mairead Makana Malgorzata Mandla Manu
Mariam Marketa Masako Mathilde Maximilian Mehdi Merve Mihaela Milagros Minh Mirko Misaki Mohan Monika Mthunzi
Nadezhda Nakoma Nandini Natalia Nazanin Nkechi Noemi Norbert Nuno Nyambura Obafemi Oddny Olufemi Onur Orla
Osman Otso Pania Parisa Patrycja Pedro Perpetua Pietro Poppy Radomir Raffaele Rahel Ramiro Ranveer Rasa Raziel
Reinhard Renske Rewi Rocio Rosalia Rustam Ryszard Saanvi Sadiq Sanjay Saule Sebastiano Setareh Shun Siddharth
Silje Siosaia Slawomir Soledad Sorcha Stanislava Sudha Sven Szymon Taini Takumi Taneli Tarja Tatiana Tenzin
Teresita Thorvald Tiihu Timur Tomoko Toyin Tuomas Ugochi Ulrike Valeriu Varvara Veikko Vesela Violetta Vivek
Wairimu Waleed Wiremu Wojciech Xiadani Yaroslav Yeon Yohannes Yolanda Yosef Zahra Zawadi Zdenek Zlata Zuzana
""".split()

EXTRA_LAST = """
Abara Adebisi Aguilar Ahlstrom Akhtar Alanis Albescu Alderete Amankwah Anand Andrade Antonopoulos Aparicio
Arrieta Asante Aumont Azevedo Bachmann Balasubramanian Bancroft Barbosa Barreto Bastos Bauer Bekele Benedetti
Bergmann Bianchi Blanchet Bodnar Bonnaire Bosch Brennan Brodeur Buitrago Cabral Cardoso Casares Cavalcanti
Cerny Chandrasekhar Chowdhury Cifuentes Colombo Coppola Correia Csonka Cunha Czerwinski Dagher Dahl Danielsen
Dasgupta Delaney Demir Desai Dietrich Dobson Domingo Doyle Dragomir Dubois Dvorak Echeverria Eggers Ekwueme
Eriksen Espinoza Fagerlund Falk Farouk Ferreira Fiedler Fischer Florea Fontana Fournier Franco Friis Fuentes
Gallo Garcia Gauthier Gebre Ghosh Giordano Goldberg Gomes Gorski Gronlund Guerrero Gupta Haas Hakansson
Hallberg Hamada Hansen Hayashi Hernandez Hoffmann Horvat Hughes Ikeda Isaksen Ito Ivanova Jablonski Jensen
Jimenez Johansen Kagame Kamara Karlsson Kato Kelleher Khumalo Kobayashi Koch Kovacs Kramer Krause Kumar Laine
Lehmann Leone Lindberg Lorenzo Lucero Luoma Maalouf Maier Majewski Marin Markovic Matsumoto Mazur Mensah
Meyer Molina Monteiro Moreau Muller Murphy Nagy Nair Nascimento Neumann Ng Nielsen Nkosi Nowak Ochoa Ogunleye
Okoye Olsen Onyango Orozco Ostrowski Pajari Papadakis Park Pereira Perez Pham Pichler Popescu Prasad Quispe
Ramos Reddy Reyes Richter Rivas Romano Rossi Ruiz Russo Sato Schmid Schulz Sepulveda Shapiro Silva Singh
Sorensen Souza Stein Sundberg Szewczyk Tanaka Teixeira Tkachenko Torres Tran Uchida Urbina Vargas Vega
Virtanen Vogel Wagner Walczak Wolff Yamamoto Yoon Zapata Zimmermann Zwart
""".split()

EXTRA_PLACES = """
Aarhus Agadir Aix Albi Algarve Alicante Arequipa Arusha Asheville Avignon Ayutthaya Baku Bariloche Bath Batumi
Bayonne Beaune Belfast Beirut Bergamo Bled Bologna Bratislava Brighton Brno Budva Burano Cadiz Cagliari Cairns
Canterbury Cappadocia Cartagena Cesky Chefchaouen Chiang Coimbra Cork Cusco Dakar Delft Derry Dijon Dresden
Durban Esbjerg Essaouira Evora Faro Fes Florianopolis Galle Gdansk Genoa Ghent Granada Graz Guanajuato Hanoi
Heidelberg Helsingor Hobart Hoi Ioannina Isfahan Izmir Jaipur Kandy Kaunas Kazan Killarney Kilkenny Kobe
Krakow Kyoto Leuven Lille Linz Ljubljana Lodz Luang Lucerne Luxor Lyon Maastricht Malaga Mantua Marrakesh
Merida Modena Monemvasia Montpellier Mysore Nafplio Nantes Napier Nazare Nice Nuremberg Oaxaca Odense Olomouc
Oporto Oslo Otranto Oulu Padua Palermo Pamplona Parma Pecs Plovdiv Pondicherry Porvoo Poznan Puebla Quimper
Ragusa Reims Riga Rotorua Salamanca Salta Salzburg Sapporo Segovia Seville Sibiu Siena Sighisoara Split
Stellenbosch Syracuse Tallinn Tartu Tbilisi Toledo Tours Trieste Trondheim Turku Udaipur Uppsala Utrecht
Valparaiso Varanasi Vilnius Visby Wanaka Wroclaw Yazd Zagreb Zanzibar Zurich
""".split()

EXTRA_NOUNS = """
aerial allotment amethyst anemone apostrophe armadillo asparagus aubergine avalanche azalea balustrade bamboo
bandana baobab barnacle bathtub bayonet beetroot begonia belfry billycan birchwood bittern blueberry boathouse
bonsai bootlace bottlebrush bowline breadbin brisket broccoli buckwheat bumblebee bunkbed burdock cabriolet
calico camisole campfire candlewick cannonball capstan caravel cardigan carport cashmere catkin cattail cedarwood
cello chainmail chandler chanterelle chessboard chickadee chiffon chrysalis cinnabar clapboard claypot clematis
clothespin cobalt cockle coffeepot comet copperhead cornbread cornice cottonwood cowrie cranberry crowbar
cufflink curlew cypress dandelion dartboard deckchair dewberry dishcloth dogwood doorstop dragonet drystone
dulcimer dunlin earthenware eggplant elderberry elderflower embroidery endive ermine estuary evergreen fencepost
fieldfare figtree firefly fishbowl flapjack flatiron flowerpot foghorn foxtail frogspawn gabardine galoshes
gannet garnet gatepost gemstone gingham glasshouse goldcrest goosefeather grapevine greenfinch greyhound
grindstone groundsel guillemot gumdrop hairbrush halibut hammerhead handbell harebell hawthorn hazelwood
headland heartwood hemlock henhouse herringbone hickory hilltop hobnail holly honeysuckle hornbeam houseboat
huckleberry hyacinth icehouse inkpot ironwork jackfruit jamboree jellybean juniper kayak kelp kettle keychain
kilt kiwi knitting lacewing ladybird lambswool landing larkspur lawnmower leapfrog lemonwood lifebuoy lighter
limpet lobster lodestone loganberry lollipop longboat lugsail lupin mandarin manor marble marsh matchbox
mayfly meadow merlin millpond millstone milkweed mistral molasses monocle moonstone moss mothwing mudlark
mulch muslin nettlefield newt nightingale nutcracker oakapple oatcake obsidian oleander orangery orchid
overcoat paintbrush palisade pampas panpipe paperclip parchment parsonage patchwork peapod pebble peppercorn
petticoat pheasant piecrust pigtail pikestaff pillowcase pinnacle pipistrelle pitcher plaid plumtree pocketwatch
pollen pomegranate pondweed popcorn portico potpourri puddle quartz quayside quiver rainbarrel rampart rattan
redwing reindeer riverbank roadster rockery rollerskate rookery rosehip rowan rushlight saddlebag sagebrush
sailboat salamander saltcellar sandpiper sarsaparilla sawmill scarecrow scrimshaw seafront seaweed semaphore
shallot sheepskin shipwright shoebox sidecar signpost silverfish skipjack skylight sleigh slipway smokehouse
snowball snowshoe soapstone songbird sourdough spyglass stairwell steamboat stepladder stockpot stonechat
strawberry sugarcane sunhat sweetbriar swordfish tablecloth tamarind tarpaulin teasel tentpeg terrapin thatch
thornapple threadbare tidepool tinplate toadflax toothbrush topiary towpath treehouse trinket truffle tumbleweed
tuning turquoise twinflower vanilla verbena vervain vineyard wagtail wainscot walkingstick warbler waterwheel
wayfarer wetsuit whalebone wheatfield whippet willow windbreak windowsill wishbone woodbine woodland woolsack
wormwood yarrow zinnia
""".split()


class Pools:
    """Draws replacement words (cap: rows per word). Nothing from the
    evaluation corpora, the call language or the STOP list is ever drawn."""

    def __init__(self, seed=8181, cap=5, mix=(0.4, 0.3, 0.3)):
        self.rng = random.Random(seed)
        banned = subnames.eval_vocab() | PROTECT | STOP | DAY_WORDS
        ok = lambda w: w.lower() not in banned and len(w) >= 3 and w.isalpha()  # noqa: E731
        uniq = lambda xs: [w for w in dict.fromkeys(xs) if ok(w)]  # noqa: E731
        self.first = uniq(subnames.REAL_FIRST + EXTRA_FIRST)
        self.last = uniq(subnames.REAL_LAST + EXTRA_LAST)
        self.place = uniq(subnames.REAL_PLACES + EXTRA_PLACES)
        self.noun = uniq(subnames.NOUNS + EXTRA_NOUNS)
        self.banned = banned
        self.cap = cap
        self.mix = mix
        self.used = {}
        self.cat = {}
        self.drawn = {}

    def sizes(self):
        return {"first": len(self.first), "last": len(self.last), "place": len(self.place),
                "noun": len(self.noun)}

    def _made(self, avoid):
        while True:
            w = "".join(self.rng.choice(subnames.SYL_A) + self.rng.choice(subnames.SYL_V)
                        + self.rng.choice(subnames.SYL_C) for _ in range(self.rng.choice([2, 2, 3])))
            if 4 <= len(w) <= 11 and w not in self.banned and w not in self.used and w not in avoid:
                return w.capitalize()

    def _from(self, pool, avoid):
        cands = [w for w in pool if self.used.get(w, 0) < self.cap and w.lower() not in avoid]
        return self.rng.choice(cands) if cands else None

    def draw(self, avoid, person=None):
        """a fresh word not in `avoid`; person = "first" | "last" | None"""
        # the category most under its share of the mix so far; a person's
        # name is a real name or an invented one, never a noun
        allowed = ("real", "made") if person else ("real", "noun", "made")
        target = dict(zip(("real", "noun", "made"), self.mix))
        n = sum(self.drawn.values()) + 1
        weights = [max(0.02, target[c] * n - self.drawn.get(c, 0)) for c in allowed]
        cat = self.rng.choices(allowed, weights)[0]
        w = None
        if cat == "real":
            pool = {"first": self.first, "last": self.last}.get(person) or \
                self.rng.choice([self.first, self.last, self.place, self.place])
            w = self._from(pool, avoid)
        elif cat == "noun":
            w = self._from(self.noun, avoid)
        if w is None:
            w, cat = self._made(avoid), "made"
        self.drawn[cat] = self.drawn.get(cat, 0) + 1
        self.cat[w] = cat
        return w

    def commit(self, words):
        """count a row's draws against the cap (only once the row is kept)"""
        for w in set(words):
            self.used[w] = self.used.get(w, 0) + 1


# ---------------------------------------------------------------- helpers

WORD = r"[^\W\d_]+"
QUOTED = re.compile(r'"([^"]*)"')
HANDLE = re.compile(r"(?<![A-Za-z0-9_&])#(\d+)\b")
DATE = re.compile(r"(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)")
WEEKDAY_DATE = re.compile(r"\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w* (\d{4}-\d{2}-\d{2})\b")
DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def copy_session(s):
    return json.loads(json.dumps(s))


def calls(s):
    for ti, t in enumerate(s["turns"]):
        for si, st in enumerate(t["steps"]):
            yield ti, si, st


def enum_spans(call):
    """quoted strings in enum position (status = "completed", kind: "call", ...)"""
    return {m.group(2) for m in re.finditer(r'\b(%s)\s*(?:=|!=|:)\s*"([^"]*)"' % "|".join(ENUM_KEYS), call)}


def copied_quotes(call):
    """quoted strings a call copies from the conversation (not ask, not enums)"""
    if call.startswith("ask"):
        return []
    en = enum_spans(call)
    return [q for q in QUOTED.findall(call) if q not in en and q.strip()]


def person_words(s):
    """first/last name words: from `party "First Last"` rows the session shows"""
    firsts, lasts = set(), set()
    for _, _, st in calls(s):
        for m in re.finditer(r'\bparty "([^"]+)"', st["obs"]):
            parts = re.findall(WORD, m.group(1))
            if len(parts) >= 2:
                firsts.add(parts[0].lower())
                lasts.add(parts[-1].lower())
    return firsts, lasts


def name_words(s):
    """the words to substitute: from `say` phrases and copied quoted strings"""
    out = []
    texts = []
    quoted = set()
    for t in s["turns"]:
        for st in t["steps"]:
            for q in copied_quotes(st["call"]):
                texts.append(q)
                quoted |= {w.lower() for w in re.findall(WORD, q)}
    for t in s["turns"]:
        # a say word is a name when a call copies it or the person capitalises
        # it; lowercase cue words ("sixth", "visited", "diary") stay
        for p in t["say"]:
            texts += [w for w in re.findall(WORD, p) if w.lower() in quoted or w[:1].isupper()]
    for x in texts:
        for w in re.findall(WORD, x):
            lw = w.lower()
            if len(lw) >= 3 and lw not in PROTECT and lw not in STOP and lw not in DAY_WORDS \
                    and not re.fullmatch(r"\d+(st|nd|rd|th)", lw) and lw not in out:
                out.append(lw)
    # a plural whose singular is also a name word is the same word
    return [w for w in out if not ((w.endswith("es") and w[:-2] in out) or (w.endswith("s") and w[:-1] in out))]


def recase(src, new):
    if len(src) > 1 and src.isupper():
        return new.upper()
    if src[:1].isupper():
        return new[:1].upper() + new[1:]
    return new.lower()


def plural(w):
    return w + ("es" if re.search(r"(s|x|z|ch|sh)$", w, re.I) else "s")


# ---------------------------------------------------------------- names

def substitute(s, pools, mapping=None):
    """-> (session, {old: new}) with every name word swapped, or (None, None)
    when a `say` phrase would no longer be found in its message"""
    ws = name_words(s)
    if not ws:
        return copy_session(s), {}
    text = " ".join([t["msg"] for t in s["turns"]] + [st["call"] + " " + st["obs"] for _, _, st in calls(s)])
    avoid = {w.lower() for w in re.findall(WORD, text)}
    firsts, lasts = person_words(s)
    if mapping is None:
        mapping = {}
        for w in ws:
            person = "first" if w in firsts else ("last" if w in lasts else None)
            new = pools.draw(avoid, person)
            avoid.add(new.lower())
            mapping[w] = new
    pat = re.compile(r"(?<![^\W\d_])(%s)('s|es|s)?(?![^\W\d_])"
                     % "|".join(re.escape(w) for w in sorted(ws, key=len, reverse=True)), re.I)

    def rep(mo):
        new = recase(mo.group(1), mapping[mo.group(1).lower()])
        suf = mo.group(2) or ""
        if suf in ("s", "es"):
            p = plural(new)
            return p.upper() if mo.group(1).isupper() and len(mo.group(1)) > 1 else p
        return new + suf

    def in_quotes(call):
        return QUOTED.sub(lambda m: '"%s"' % (m.group(1) if m.group(1) in enum_spans(call) else pat.sub(rep, m.group(1))), call)

    out = copy_session(s)
    for t in out["turns"]:
        t["msg"] = pat.sub(rep, t["msg"])
        t["say"] = [pat.sub(rep, p) for p in t["say"]]
        for st in t["steps"]:
            st["call"] = in_quotes(st["call"])
            st["obs"] = pat.sub(rep, st["obs"])
        if "shown" in t:
            t["shown"] = pat.sub(rep, t["shown"])
    for t in out["turns"]:
        low = t["msg"].lower()
        if any(p.lower() not in low for p in t["say"]):
            return None, None
    return out, mapping


# ---------------------------------------------------------------- handles

def renumber(s, k):
    out = copy_session(s)
    sub = lambda txt: HANDLE.sub(lambda mo: "#%d" % (int(mo.group(1)) + k), txt)  # noqa: E731
    for _, _, st in calls(out):
        st["call"] = sub(st["call"])
        st["obs"] = sub(st["obs"])
    return out


# ---------------------------------------------------------------- dates

MONTH_WORDS = re.compile(
    r"\b(january|february|march|april|may|june|july|august|september|october|november|december|"
    r"jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec|month|months|year|years|christmas|easter|"
    r"summer|winter|spring|autumn|"
    r"\d+(?:st|nd|rd|th)|\d{4}|\d{1,2}/\d{1,2})\b", re.I)
CALL_MONTHLY = re.compile(r"\b(month|months|year|years|the \d+(?:st|nd|rd|th))\b")


def can_shift(s):
    """week shifts keep weekdays and weeks; they do not keep months or years"""
    for t in s["turns"]:
        if MONTH_WORDS.search(t["msg"]) or any(MONTH_WORDS.search(p) for p in t["say"]):
            return False
        for st in t["steps"]:
            if CALL_MONTHLY.search(st["call"]):
                return False
    return True


def shift_dates(s, weeks):
    d = datetime.timedelta(days=7 * weeks)

    def sub(txt):
        def one(mo):
            try:
                x = datetime.date(int(mo.group(1)), int(mo.group(2)), int(mo.group(3))) + d
            except ValueError:
                return mo.group(0)
            return x.isoformat()
        return DATE.sub(one, txt)

    out = copy_session(s)
    out["today"] = sub(out["today"])
    for _, _, st in calls(out):
        st["call"] = sub(st["call"])
        st["obs"] = sub(st["obs"])
    return out


# ---------------------------------------------------------------- amounts

def _major(n):
    return str(n // 100) if n % 100 == 0 else "%d.%02d" % (n // 100, n % 100)


def _digits_in(msg, major):
    return re.compile(r"(?<![\d.:,/-])%s(?![\d:/]|\.\d)" % re.escape(major))


def scale_amounts(s, rng, world_amounts=()):
    """-> (session, n) replacing one money amount the person said in digits;
    (None, 0) when the session has none that can move safely"""
    seen = set(int(x) for _, _, st in calls(s) for x in re.findall(r"amount_minor[=:]\s*(\d+)", st["obs"]))
    fences = set(world_amounts) | seen
    cands = []
    for ti, si, st in calls(s):
        t = s["turns"][ti]
        for m in re.finditer(r"amount_minor(\s*(?::|>=|<=|>|<)\s*)(\d+)\b", st["call"]):
            n = int(m.group(2))
            major = _major(n)
            if major not in t["say"] or not _digits_in(t["msg"], major).search(t["msg"]):
                continue
            cands.append((ti, si, m.group(1).strip(), n))
    if not cands:
        return None, 0
    ti, si, op, n = rng.choice(cands)
    later_numbers = any(re.match(r"=\s*-?\d", st["obs"]) for tj, sj, st in calls(s) if (tj, sj) > (ti, si))
    desc = QUOTED.findall(s["turns"][ti]["steps"][si]["call"])

    def own_line(line, tj, sj):
        return (tj, sj) == (ti, si) or any(d and '"%s"' % d in line for d in desc)

    if op == ":":
        # the amount may only appear on the write's echo and the new row itself
        for tj, sj, st in calls(s):
            for line in st["obs"].split("\n"):
                if re.search(r"amount_minor[:=]\s*%d\b" % n, line) and not own_line(line, tj, sj):
                    return None, 0
    major = n // 100
    step = 5 if major % 5 == 0 and major >= 10 else 1
    options = []
    for m in range(max(step, int(major * 0.3) // step * step), int(major * 3) + 1, step):
        new = m * 100 + (n % 100 if op == ":" else 0)
        if m == major:
            continue
        if op != ":":
            lo, hi = min(n, new), max(n, new)
            if any(lo <= x <= hi for x in fences):
                continue
        elif later_numbers or new in seen:
            continue
        options.append(new)
    if not options:
        return None, 0
    new = rng.choice(options)
    out = copy_session(s)
    t = out["turns"][ti]
    t["msg"] = _digits_in(t["msg"], _major(n)).sub(_major(new), t["msg"], count=1)
    t["say"] = [_major(new) if p == _major(n) else p for p in t["say"]]
    st = t["steps"][si]
    st["call"] = re.sub(r"(amount_minor\s*%s\s*)%d\b" % (re.escape(op), n), lambda mo: mo.group(1) + str(new),
                        st["call"])
    if op == ":":
        for tj, sj, x in calls(out):
            if (tj, sj) >= (ti, si):
                x["obs"] = "\n".join(
                    re.sub(r"(amount_minor[:=]\s*)%d\b" % n, lambda mo: mo.group(1) + str(new), line)
                    if own_line(line, tj, sj) else line for line in x["obs"].split("\n"))
    return out, 1


# ---------------------------------------------------------------- verify

def verify(s):
    """-> list of violations (strings)"""
    bad = []
    shown = set()
    conv = ""
    for ti, t in enumerate(s["turns"]):
        low = t["msg"].lower()
        conv += "\n" + low
        for p in t["say"]:
            if p.lower() not in low:
                bad.append("say phrase missing: t%d %r" % (ti, p))
        for st in t["steps"]:
            for q in copied_quotes(st["call"]):
                ql = q.lower()
                if ql in conv:
                    continue
                if all(w.lower() in conv for w in re.findall(WORD, q)):
                    continue
                bad.append("quoted string not in conversation: t%d %r" % (ti, q))
            for h in HANDLE.findall(st["call"]):
                if h not in shown:
                    bad.append("handle not shown: t%d #%s" % (ti, h))
            # the runtime echoes the handles it acted on
            m = re.match(r"get #(\d+)$", st["call"].strip())
            if m and st["obs"] and not st["obs"].startswith("#%s " % m.group(1)):
                bad.append("get echo disagrees: t%d %s" % (ti, st["call"]))
            if st["obs"].startswith("ok:") and " on " in st["call"]:
                echo = st["obs"].split("\n")[0]
                if sorted(HANDLE.findall(st["call"].rsplit(" on ", 1)[1])) != \
                        sorted(HANDLE.findall(echo.rsplit(" on ", 1)[-1])):
                    bad.append("write echo disagrees: t%d %s" % (ti, st["call"]))
            shown |= set(HANDLE.findall(st["obs"]))
            conv += "\n" + st["obs"].lower()
    m = re.match(r"today: (\w+) (\d{4}-\d{2}-\d{2})", s["today"])
    if m and datetime.date.fromisoformat(m.group(2)).strftime("%A") != m.group(1):
        bad.append("today weekday wrong")
    for _, _, st in calls(s):
        for dw, ds in WEEKDAY_DATE.findall(st["obs"] + "\n" + st["call"]):
            if DOW[datetime.date.fromisoformat(ds).weekday()] != dw:
                bad.append("weekday wrong: %s %s" % (dw, ds))
    return bad


def leftover_names(s, mapping):
    """original name words still present after substitution (messages,
    quoted call strings, observations)"""
    if not mapping:
        return []
    pat = re.compile(r"(?<![^\W\d_])(%s)(?:'s|es|s)?(?![^\W\d_])" % "|".join(map(re.escape, mapping)), re.I)
    text = "\n".join([t["msg"] for t in s["turns"]] +
                     [" ".join(QUOTED.findall(st["call"])) + "\n" + st["obs"] for _, _, st in calls(s)])
    return sorted({m.group(1).lower() for m in pat.finditer(text)} - {v.lower() for v in mapping.values()})


def world_amounts(path):
    try:
        txt = open(path, encoding="utf-8").read()
    except OSError:
        return set()
    return {int(x) for x in re.findall(r'"amount_minor":\s*(\d+)', txt)}


if __name__ == "__main__":
    print(Pools().sizes())

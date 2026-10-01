"""Replacement pools for build-time name substitution (build7.py --subst).

A generated session is paraphrased once, then every name in it -- each word
the person says that a call copies, and each word of a quoted string in a
call -- is swapped, consistently across the messages, the calls and the
observations, for a fresh word drawn from three pools:

  REAL    ~40%  real first names, surnames and places
  NOUN    ~30%  ordinary nouns
  MADE    ~30%  rare or invented words (syllable generator, unlimited)

so the model has to copy what the message says instead of recalling a small
training vocabulary. Every pool word is checked against the evaluation
corpora's own vocabulary (crates/evalsuite/*.json), the training worlds' own
words (v7/worlds/*.json) and the call language's words (PROTECT): none may be
drawn.
"""
import json
import os
import random
import re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", ".."))

REAL_FIRST = """
Aarav Abebe Adaeze Adele Adriana Agata Ahmed Aiko Ailsa Aisling Akira Alasdair Albertine Aleksei Alfie Alinta
Alma Amara Ambrose Amelie Anouk Anselm Antoine Anya Aoife Arjun Arvid Astrid Aurora Aziz Baptiste Barnaby
Beatrix Benedikt Bertil Bianca Bjorn Blessing Bodhi Bogdan Bronwen Caius Calla Camille Carmen Casimir Cecily
Cedric Chiara Chidi Cillian Clemens Constance Corin Dalia Damaris Dario Dashiell Delphine Deniz Desmond Dimitri
Dinah Dmitri Dorit Dragan Eamon Edda Efua Eilidh Einar Elif Elodie Emeka Emil Enzo Esme Esther Ettore Eudora
Ewan Farida Fenella Fergus Filippa Finnian Flavia Fleur Fumiko Gaspard Gemma Gideon Giulia Gunnar Gwyneth
Hamza Hanne Haruki Hedda Helga Hideo Hilda Hiroshi Hugo Idris Ilse Imogen Inez Ingrid Isidore Ivo Jacinta
Jakob Jarrah Javier Jelena Jonas Joaquin Josefine Jovan Kalani Kamal Kasia Kavya Keanu Kenji Kerensa Kofi
Laila Lars Leander Leonie Lillian Linnea Lorcan Luca Ludmila Lukas Mads Magda Mahala Maija Malak Malik Marisol
Mateo Matilda Maud Mehmet Meera Mikael Mira Moana Morwenna Nadia Naoko Niamh Nikolai Nilufar Ninian Noor Odile
Olamide Olivier Omar Ondine Oona Orsolya Oskar Paloma Pavel Petra Philippa Pilar Piotr Quentin Radek Rafaela
Rainer Ramona Rashid Renata Rhiannon Rohan Roisin Rufus Rumi Sabine Saoirse Selim Seraphina Shirin Sigrid
Silvio Siobhan Soren Stellan Suki Sunniva Svea Tadeo Tamsin Tariq Thea Tobias Tomasz Tuula Ugo Ulla Umar
Valentin Vesna Vikram Viggo Vilma Wanjiru Wiebke Xander Xiomara Yannick Yara Yusuf Zainab Zbigniew Zeynep Zofia
Ottilie Leopold Clementine Bartholomew Wilfred Florentyna Kazimierz Agnetha Rasmus Solveig Ignacio Lucienne
Adebayo Agnes Alessia Alvaro Ambika Anneliese Apolline Aroha Artemis Augustin Aurelie Ayesha Bartosz Berit
Birgit Bolaji Borislav Brigitta Caoimhe Carys Celestine Chinonso Cosima Dagny Darragh Delmar Dorothea Dunja Ebba
Eero Eleni Emrys Endre Eskil Eyota Fabienne Faisal Farah Folake Freja Gaetan Galina Genevieve Gisela Goran Greta
Gustavo Halima Hamish Hannelore Harriet Heloise Henrik Ilaria Ilona Iolanthe Isak Iskander Jarek Jorunn Juhani
Kaito Kalinda Karin Katalin Kemal Kiri Klaus Kwame Leila Lennart Lisbet Livia Lotte Lucasta Maelle Manon Marek
Margarethe Marit Matteo Mikkel Milos Mirela Nanami Nuala Odhran Olwen Ormond Paavo Paola Pernille Priscilla Radu
Ragnhild Ravi Reuben Rhodri Riya Rosalind Ruairi Sakura Salome Sanna Sebastien Seren Signe Sinead Solenne Stanislav
Sunita Tamar Tancredi Teodor Thandiwe Tiago Torvald Ursula Vasco Veronika Vidar Wilhelm Wynne Yasmin Yoshiko Yuki
""".split()

REAL_LAST = """
Abernathy Achebe Adeyemi Albrecht Almeida Amundsen Andersson Arkwright Ashby Babic Baranski Beaumont Bergstrom
Blackwood Bondarenko Borges Brannigan Bruckner Calloway Carvalho Castellano Chaudhry Cho Cienfuegos Costa
Cromwell Dalgleish Dabrowski Delgado Devereux Donnelly Drummond Duarte Eklund Engstrom Esposito Fairbairn
Fonseca Forsyth Fujimoto Galbraith Garrido Gillespie Gonzaga Gradwell Grimaldi Gustafsson Haddad Halvorsen
Hartigan Hashimoto Hawthorne Hendricks Holmberg Ibarra Ingram Iversen Jaramillo Jovanovic Kaczmarek Kapoor
Kavanagh Kellerman Kim Kowalczyk Kuznetsova Lachance Lambert Larsen Lindqvist Lombardi Lundgren Macaulay
Machado Magnusson Mahony Marchetti Mbeki Mcallister Medina Mendoza Moravec Morrow Mulligan Nakamura Navarro
Nieminen Novak Nyberg Obi Okafor Okonkwo Oliveira Ortega Osei Pacheco Palmqvist Papadopoulos Paredes Pasternak
Petrovic Pinheiro Quigley Quintero Rahman Ramsay Rasmussen Reinholt Rinaldi Rocha Rosenthal Sandoval Santangelo
Schreiber Serrano Sheridan Sigurdsson Silveira Sokolov Stavros Strand Suzuki Szabo Takahashi Tavares Thorsen
Toivonen Trevithick Umarov Underhill Valdivia Varga Vasconcelos Villanueva Wainwright Wakefield Watanabe
Weatherby Whitlock Wojcik Yamada Yilmaz Zamora Zielinski Zupan Achterberg Bellamy Carrington Dunmore Ellingham
Fitzgerald Gallowglass Holloway Inglewood Jessop Kingsley Lockhart Montague Northcott Oyelaran Penhaligon
Aalto Abramowitz Ahlberg Alcott Amstutz Arbuthnot Ashdown Bakshi Balogun Barraclough Bexley Birkett Blomqvist
Bramwell Castellanos Chakraborty Clough Coutinho Crabtree Dahlberg Delacourt Dimitrov Dunleavy Egerton Fairweather
Falconer Fenwick Figueroa Frobisher Gaskell Greenhalgh Haraldsen Heathcote Hedlund Hollis Horvath Iqbal Jankowski
Juarez Kallio Kendrick Kinnear Kurokawa Lacroix Laidlaw Linwood Lopes Mallory Marchbanks Meriwether Mistry Nakagawa
Nordin Oduro Olsson Pemberton Pettersen Quayle Radcliffe Rautio Renwick Rutherford Saarinen Salazar Segal Shackleton
Sjoberg Soderberg Summerfield Takeda Tennant Thackeray Urquhart Valente Vickers Wadsworth Westergaard Winslow
""".split()

REAL_PLACES = """
Aberdovey Abingdon Adelboden Akaroa Alderney Alnwick Amalfi Ambleside Annecy Antibes Arbroath Arcachon Arles
Ascona Aspen Assisi Aviemore Bamburgh Banff Bantry Barmouth Bellagio Bergen Biarritz Blenheim Bodmin Bodrum
Bolzano Bordeaux Bowness Braemar Brecon Bruges Buxton Cadaques Cairngorm Camogli Cannes Carcassonne Cascais
Cheddar Chamonix Chepstow Cinque Clovelly Cochem Colmar Connemara Corfu Cortina Cotswold Crail Cromer Dartmoor
Dingle Dolomites Dordogne Dubrovnik Dunkeld Durness Eastbourne Eilean Elgin Ely Enniskillen Estoril Exmoor
Falmouth Fowey Galway Garda Geiranger Girona Glencoe Gozo Grasmere Hallstatt Harlech Hastings Hebden Helmsley
Honfleur Hvar Interlaken Inverness Ischia Jersey Kalmar Kendal Keswick Killarney Kinsale Kirkwall Kotor
Lagos Lanzarote Lausanne Lerwick Lindisfarne Lismore Llandudno Locarno Lofoten Lucca Lugano Lyme Madeira
Mallaig Malvern Mandal Matera Menorca Mevagissey Montreux Mostar Mull Nairn Naxos Nerja Oban Ohrid Orkney
Orvieto Padstow Paphos Perugia Pitlochry Plockton Polperro Porthleven Portree Positano Ravello Rhodes Ronda
Rovinj Rye Salcombe Saltburn Sandwood Sintra Skagen Skye Snowdonia Sorrento Stavanger Stromness Tavira
Taormina Tenby Thurso Tintagel Tobermory Todmorden Tromso Ullapool Umbria Uzes Valletta Verbier Vernazza
Whitby Whitstable Wengen Windermere Yarmouth Zermatt Zadar Zakynthos Orford Aldeburgh Southwold Walberswick
Portmeirion Kynance Lulworth Durdle Studland Seahouses Craster Alnmouth Tynemouth Staithes Runswick Robin
Ardnamurchan Arisaig Bakewell Barra Beaulieu Bibury Blakeney Borrowdale Boscastle Bourton Burnham Buttermere
Cartmel Castleton Chatsworth Clitheroe Coniston Corbridge Coverack Crickhowell Dunster Edale Eskdale Findhorn
Glenfinnan Grantown Hathersage Hawes Hayfield Hope Ilkley Kilkenny Kingsbridge Lacock Lavenham Ledbury Lynmouth
Machynlleth Malham Marazion Minehead Morecambe Mousehole Newlyn Porlock Portloe Portsoy Rosthwyn Sedbergh Solva
Staithes Stonehaven Tobercurry Totnes Troutbeck Wasdale Wells Wetheral Yealmpton Zennor
""".split()

NOUNS = """
anchor anvil apricot apron archway armchair atlas attic awning backpack badger bagel balcony ballast bandstand
banjo banner barge barley barometer barrel basin basket beacon beaker beanbag bellows bench biscuit blanket
blender bluebell bobbin bollard bonfire bookcase bottle boulder bracelet bramble brazier brick bridle broom
bucket buckle bugle bungalow bunting burrow buttress cabbage cactus caddy cairn calendar camel candle canoe
canopy canvas carafe caramel carousel cartwheel cashew casket castle catapult cauldron cedar cellar chalice
chalk chandelier chapel chestnut chimney chisel chutney cider cinnamon clarinet clipboard clover cobbler
cockpit coconut colander compass conch cookie coral corkscrew cornet cottage cowbell crab cradle crate crayon
cricket croquet crossbow crumpet crystal cupboard cushion cymbal daffodil dagger dahlia daisy decanter denim
dinghy doorbell dormouse dovecote dragonfly drawbridge driftwood drum duffel dumpling dustpan easel eggcup
elbow elm emerald envelope espresso falcon fern ferret fiddle figurine flagpole flannel flask flint flute
fountain foxglove fresco fudge funnel gable gadget galleon gargoyle garland gazebo geyser ginger giraffe
glacier glove goblet gondola gooseberry gourd granary granite gravy griddle grotto guitar gumboot hammock
hamper harp hatchet haystack hazelnut hedgehog helmet hermit hinge hoop hopscotch horseshoe hourglass hutch
icicle igloo inkwell ivory ivy jackdaw jasmine javelin jellyfish jigsaw jukebox kaleidoscope kennel kerosene
kestrel kettledrum keystone kiln kite knapsack lacquer ladle lagoon lamppost lantern larch lattice lavender
ledger lemonade lighthouse lilac limestone linen locket loom lute macaroon magnet magnolia mallet mandolin
mango maple marigold marmalade marquee marzipan mast meadowlark medallion melon meringue metronome mitten
moat mooring mortar mosaic moth muffin mulberry mustard nectarine nettle nightjar nutmeg oak oar oatmeal
obelisk octopus olive omelette opal orchard organ osprey otter oven owl oyster paddle pagoda pancake pantry
papyrus parasol parsnip pasty pavilion peacock pearl pelican pendulum pennant pepper periscope pestle
pewter piccolo pickle pigeon pillar pinecone pinwheel pistachio pitchfork plank plum poncho poppy porcupine
porridge postcard potter pretzel prism puffin pulley pumpkin puppet quail quarry quill quilt quince raccoon
radish raft raisin rake raspberry rattle raven recorder reed rhubarb ribbon riddle rocket rooftop rosemary
rucksack rudder saddle saffron sailcloth salmon sandal sapphire satchel sausage saxophone scaffold scarecrow
scone scroll seashell sextant shamrock shingle shovel shutter sieve silo skillet sledge slipper snorkel
snowdrop sorbet sparrow spatula spindle sponge spruce squirrel stagecoach starfish steeple stirrup stool
strudel sundial sunflower swallow sycamore tadpole tambourine tangerine tapestry teapot telescope thimble
thistle thrush timpani toadstool toboggan toffee tortoise totem tractor trellis trombone trowel trumpet
tuba tugboat turnip turret tweed twine umbrella urn valve velvet viaduct vinegar violet walnut walrus
wardrobe washboard watercress weathervane wheelbarrow whisk whistle wicker wigwam windmill wisteria
woodpecker wren xylophone yacht yarn yew yoghurt zeppelin zither acorn almond ammonite antler aqueduct
bobsleigh buttercup cardamom chickpea clementine cloudberry cobweb cormorant damson dewdrop egret fjord
abacus alcove amulet apiary armoire artichoke avocado bassoon beehive bellflower birdbath blackbird bobcat
bonnet brooch bulrush butterscotch cabinet canary candelabra cantaloupe carnation cassock chaffinch chamomile
charcoal cherrywood chipmunk cinder citadel clocktower cobblestone coleslaw conservatory copperplate corduroy
cornflower courgette crocus croissant cuckoo cutlass dormer drainpipe eiderdown fireplace flagstone flamingo
footbridge gingerbread goldfinch gramophone grapefruit hacksaw harpoon heather hollyhock honeycomb inglenook
jamjar kingfisher kipper lampshade lemongrass lintel mackerel mangrove marionette meadowsweet milkjug minnow
mistletoe moorhen mothball nasturtium nightcap oilskin ottoman paperweight parsley partridge peppermint periwinkle
pinafore plover primrose quartzite ragwort ramekin redcurrant rockpool samovar sandbank scallop scullery seagull
sheepdog sherbet shortbread skylark snapdragon spinnaker stoat sugarloaf tallow teacake thornbush tinderbox
treacle tricycle turnstone waistcoat waterlily wheatsheaf whirligig woodstove yardarm
""".split()

SYL_A = ["b", "br", "c", "ch", "d", "dr", "f", "g", "gl", "h", "j", "k", "kl", "l", "m", "n", "p", "pr", "qu",
         "r", "s", "sk", "sl", "st", "t", "tr", "v", "w", "z", "th", "sh", "fl"]
SYL_V = ["a", "e", "i", "o", "u", "ai", "ea", "ou", "y", "oa", "ie"]
SYL_C = ["", "", "n", "r", "l", "m", "s", "th", "x", "k", "nd", "rt", "sk", "ll", "v", "st"]

# the call language's own words and the routing cues a question carries:
# never substituted, never drawn
PROTECT = set("""
the a an my our at of for to in on about with and is it that this what from new old up out off by or as vs not
answer show search get count sum min max balance done nothing refuse called during ordered asc desc first them
me except null true false contains around member things thing events event tasks task notes note journal
documents document parties party members member important dates date contact channels channel activities activity
obligations obligation photos photo albums album places place expenses expense groups group locker items item
notebooks notebook circles circle profiles profile settlements settlement people person status completed
needs action process cancelled due_at dtstart amount_minor spent_on captured_at favorite favourite starred
folder folders album_titles role kind type effort_min label phone email mobile office work home password
username login card wifi pin code codes portal account app backup call coffee visit message birthday anniversary
graduation day today tomorrow yesterday monday tuesday wednesday thursday friday saturday sunday week weekend
month year next last now recently before after interaction owner trashed deleted_at owed_to_me_minor
owed_to_them_minor paid_by amount reschedule complete delete restore cancel schedule add_task propose_event
knowledge create_note core trash_document star_document restore_document add_item reveal_receipt columns
trash_item media add_to_album delete_asset restore_asset log_interaction settle_debt trash_person tally
add_expense settle_up delete_expense undo_expense add_group_member title summary description content to_party
group_id album_id
""".split())


def eval_vocab():
    voc = set()

    def walk(v):
        if isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, str):
            voc.update(t.lower() for t in re.findall(r"[A-Za-z]+", v))

    for f in ("suite.json", "blind.json", "holdout.json", "registers.json"):
        p = os.path.join(REPO, "crates", "evalsuite", f)
        if os.path.exists(p):
            walk(json.load(open(p, encoding="utf-8")))
    return voc


def world_vocab():
    """every word of the training worlds: a replacement must not collide with
    the cast and labels the observations still carry"""
    voc = set()
    d = os.path.join(HERE, "worlds")
    for f in sorted(os.listdir(d)):
        if re.match(r"^w\d+\.json$", f):
            voc.update(t.lower() for t in re.findall(r"[A-Za-z]+", open(os.path.join(d, f), encoding="utf-8").read()))
    return voc


class Pools:
    """Draws replacement words; no word is handed out more than `cap` times."""

    def __init__(self, seed=17, cap=4, mix=(0.4, 0.3, 0.3)):
        self.rng = random.Random(seed)
        banned = eval_vocab() | world_vocab() | PROTECT
        ok = lambda w: w.lower() not in banned and len(w) >= 3  # noqa: E731
        self.first = [w for w in dict.fromkeys(REAL_FIRST) if ok(w)]
        self.last = [w for w in dict.fromkeys(REAL_LAST) if ok(w)]
        self.place = [w for w in dict.fromkeys(REAL_PLACES) if ok(w)]
        self.noun = [w for w in dict.fromkeys(NOUNS) if ok(w)]
        self.banned = banned
        self.cap = cap
        self.mix = mix
        self.used = {}

    def _made(self):
        while True:
            w = "".join(self.rng.choice(SYL_A) + self.rng.choice(SYL_V) + self.rng.choice(SYL_C)
                        for _ in range(self.rng.choice([2, 2, 3])))
            if 4 <= len(w) <= 11 and w not in self.banned and w not in self.used:
                return w.capitalize()

    def _from(self, pool, avoid):
        cands = [w for w in pool if self.used.get(w, 0) < self.cap and w.lower() not in avoid]
        return self.rng.choice(cands) if cands else None

    def draw(self, avoid, person=None):
        """a fresh word not in `avoid` (lowercase words already in the session)."""
        r = self.rng.random()
        w = None
        if r < self.mix[0]:
            pool = {"first": self.first, "last": self.last}.get(person) or \
                self.rng.choice([self.first, self.last, self.place, self.place])
            w = self._from(pool, avoid)
        elif r < self.mix[0] + self.mix[1]:
            w = self._from(self.noun, avoid)
        if w is None:
            w = self._made()
        self.used[w] = self.used.get(w, 0) + 1
        return w


def sizes():
    p = Pools()
    return {"first": len(p.first), "last": len(p.last), "place": len(p.place), "noun": len(p.noun)}


if __name__ == "__main__":
    print(sizes())

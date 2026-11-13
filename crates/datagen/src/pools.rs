//! Word pools the world generator draws from. Plain data: a pool is never "the schema" (the
//! catalog is), only the vocabulary a made-up life is written in.

pub const FIRST: &[&str] = &[
    "Neha", "Ravi", "Maya", "Ethan", "Sofia", "Liam", "Aisha", "Noah", "Priya", "Lucas", "Chloe",
    "Omar", "Hana", "Mateo", "Zara", "Felix", "Ingrid", "Kofi", "Lena", "Mina", "Tariq", "Elena",
    "Jonas", "Amara", "Diego", "Freya", "Hugo", "Ines", "Jamal", "Keiko", "Leo", "Nadia", "Oscar",
    "Paula", "Quinn", "Rosa", "Sven", "Tessa", "Uma", "Viktor", "Wanda", "Xavier", "Yara", "Zoe",
    "Arjun", "Bianca", "Callum", "Dana", "Emil", "Farah", "Gustav", "Hedy", "Idris", "Julia",
    "Kavya", "Lars", "Marta", "Nikhil", "Olga", "Pedro", "Rhea", "Samir", "Thea", "Umar", "Vera",
    "Wen", "Yusuf", "Anika", "Beni", "Carmen", "Dev", "Esme", "Finn", "Gita", "Hiro", "Isla",
    "Jai", "Kira", "Lior", "Mila", "Nico", "Orla", "Pia", "Rafa", "Sana", "Tomas", "Aditi",
    "Rohit", "Sunita", "Anil", "Deepa", "Vijay", "Lakshmi", "Manoj", "Pooja", "Sanjay", "Ananya",
    "Karthik", "Meera", "Rajesh", "Swati", "Ashok", "Bhavna", "Gaurav", "Divya", "Harish", "Isha",
    "Jyoti", "Kunal", "Madhavi", "Naveen", "Pallavi", "Rakesh", "Shreya", "Tanvi", "Uday", "Varun",
    "Yamini",
];

pub const LAST: &[&str] = &[
    "Rao",
    "Kulkarni",
    "Weiss",
    "Ochoa",
    "Park",
    "Nguyen",
    "Haddad",
    "Silva",
    "Okafor",
    "Berg",
    "Moreau",
    "Tanaka",
    "Ibrahim",
    "Novak",
    "Lindqvist",
    "Costa",
    "Mehta",
    "Fischer",
    "Osei",
    "Duarte",
    "Kaur",
    "Larsen",
    "Mendez",
    "Petrov",
    "Santos",
    "Takahashi",
    "Varga",
    "Yilmaz",
    "Adler",
    "Bianchi",
    "Chen",
    "Dubois",
    "Eriksen",
    "Farouk",
    "Gomez",
    "Hoang",
    "Iyer",
    "Jensen",
    "Khan",
    "Lopez",
    "Mori",
    "Nair",
    "Olsen",
    "Patel",
    "Quist",
    "Reyes",
    "Singh",
    "Thapa",
    "Ueda",
    "Voss",
    "Walker",
    "Xu",
    "Young",
    "Zhou",
    "Alvarez",
    "Brandt",
    "Cohen",
    "Demir",
    "Sharma",
    "Verma",
    "Reddy",
    "Gupta",
    "Joshi",
    "Desai",
    "Bhat",
    "Menon",
    "Chopra",
    "Banerjee",
    "Mukherjee",
    "Shetty",
    "Naidu",
    "Chauhan",
    "Bose",
    "Kapoor",
    "Malhotra",
    "Saxena",
    "Trivedi",
    "Hegde",
];

/// The owner's own first names, partitioned by split so a held-out persona is a name the
/// training worlds never used.
pub const ME_TRAIN: &[&str] = &[
    "Sam", "Alex", "Jordan", "Casey", "Robin", "Morgan", "Avery", "Riley", "Jamie", "Taylor",
    "Devon", "Rowan", "Skyler", "Harper", "Emery", "Parker", "Anjali", "Rahul", "Sneha", "Amit",
];
pub const ME_VAL: &[&str] = &["Kai", "Sasha", "Blake", "Reese", "Kriti", "Sameer"];
pub const ME_TEST: &[&str] = &["Drew", "Lane", "Marlow", "Shay", "Ishaan", "Mehul"];

pub const ROLES: &[&str] = &[
    "designer",
    "dentist",
    "plumber",
    "neighbour",
    "landlord",
    "coach",
    "teacher",
    "accountant",
    "cousin",
    "colleague",
    "doctor",
    "barber",
    "roommate",
    "manager",
    "tutor",
    "vet",
    "friend",
    "electrician",
    "physio",
    "mentor",
];

pub const MET: &[&str] = &[
    "Berlin 2019",
    "college",
    "a wedding",
    "the gym",
    "work",
    "a conference",
    "a neighbour's party",
    "online",
    "the school run",
    "a hiking trip",
    "a book club",
];

pub const EVENT_TEMPLATES: &[&str] = &[
    "Lunch with {p}",
    "Coffee with {p}",
    "Call with {p}",
    "Dentist",
    "Dentist follow-up",
    "Team standup",
    "Yoga class",
    "Pick up the parcel",
    "Parent-teacher meeting",
    "Dinner at {p}'s",
    "Flight to {c}",
    "Hotel check-in",
    "Car service",
    "Book club",
    "Movie night",
    "Haircut",
    "Doctor checkup",
    "Tabla class",
    "Quarterly review",
    "{p}'s birthday dinner",
    "Moving day",
    "Gym session",
    "Budget review",
    "Tax appointment",
    "Piano lesson",
    "Farmers market",
    "Trip to {c}",
    "Standup with {p}",
    "Physio",
];

pub const CITIES: &[&str] = &[
    "Lisbon", "Osaka", "Denver", "Berlin", "Nairobi", "Oslo", "Austin", "Porto", "Kyoto", "Lyon",
];

pub const TASK_TEMPLATES: &[&str] = &[
    "Book the cabin",
    "Renew passport",
    "Call {p}",
    "Buy groceries",
    "Pay the electricity bill",
    "Fix the leaking tap",
    "Reply to {p}",
    "Order a birthday gift for {p}",
    "Clean the garage",
    "File expense report",
    "Schedule dentist",
    "Back up the laptop",
    "Return the drill",
    "Water the plants",
    "Plan the offsite",
    "Write thank-you cards",
    "Update the resume",
    "Renew car insurance",
    "Pick up dry cleaning",
    "Send invoice to {p}",
    "Sign the lease",
    "Organise the pantry",
    "Book flights to {c}",
    "Cancel old subscription",
    "Buy running shoes",
];

pub const LIST_NAMES: &[(&str, &str)] = &[
    ("Home", "Household"),
    ("Work", "Career"),
    ("Errands", "Household"),
    ("Travel", "Leisure"),
    ("Health", "Wellbeing"),
    ("Side project", "Career"),
    ("Family", "Household"),
    ("Money admin", "Household"),
];

pub const NOTEBOOKS: &[&str] = &[
    "Recipes",
    "Ideas",
    "Work notes",
    "Travel",
    "Journal",
    "Reading",
    "Home projects",
    "Fitness",
];

pub const NOTE_TITLES: &[&str] = &[
    "Dal",
    "Pasta sauce",
    "Packing list",
    "Gift ideas",
    "Meeting notes",
    "Book recommendations",
    "Garden plan",
    "Wifi setup",
    "Workout plan",
    "Trip itinerary",
    "Budget thoughts",
    "Movie list",
    "Paint colours",
    "Interview questions",
    "Sourdough",
    "Marathon training",
    "Car maintenance",
    "Reading list",
    "Podcast ideas",
    "Weekend plans",
    "Moving checklist",
    "Dinner party menu",
];

pub const FOLDERS: &[&str] = &[
    "Taxes",
    "Insurance",
    "Home",
    "Medical",
    "Travel",
    "Receipts",
    "Work",
    "School",
    "Car",
    "ID",
];

pub const DOC_TITLES: &[&str] = &[
    "W2",
    "Lease agreement",
    "Passport scan",
    "Car insurance policy",
    "Vaccination record",
    "Mortgage statement",
    "Warranty card",
    "Tax return",
    "Offer letter",
    "Medical report",
    "Flight itinerary",
    "Utility bill",
    "Resume",
    "Invoice template",
    "Rental receipt",
];

pub const ALBUMS: &[&str] = &[
    "Summer",
    "Family",
    "Trips",
    "Pets",
    "Food",
    "Hikes",
    "Birthdays",
    "Home",
    "Screenshots",
];

pub const PHOTO_TITLES: &[&str] = &[
    "Beach day",
    "Sunset",
    "Birthday cake",
    "Trail view",
    "Dog at the park",
    "Dinner out",
    "Museum",
    "Old town",
    "Graduation",
    "Road trip",
    "Market stall",
    "Snow",
    "Campfire",
    "Skyline",
    "Garden",
    "New haircut",
    "Bike ride",
    "Street art",
];

/// `(name, type)`; the type is a Locker item type the vault lists.
pub const LOCKER_ITEMS: &[(&str, &str)] = &[
    ("Bank login", "login"),
    ("Email login", "login"),
    ("Netflix", "login"),
    ("Home wifi", "wifi"),
    ("Office wifi", "wifi"),
    ("Visa card", "card"),
    ("Amex card", "card"),
    ("Door code", "password"),
    ("Passport", "passport"),
    ("Driving licence", "driving_licence"),
    ("Gym membership", "membership"),
    ("Airline miles", "membership"),
    ("GitHub token", "api_credential"),
    ("Server key", "ssh_key"),
    ("Recovery codes", "note"),
    ("Insurance policy", "document"),
    ("Savings account", "bank_account"),
    ("Photo software", "software_licence"),
];

pub const ACCOUNTS: &[(&str, &str)] = &[
    ("Everyday", "checking"),
    ("Savings pot", "savings"),
    ("Travel card", "credit_card"),
    ("Cash wallet", "cash"),
    ("Joint account", "checking"),
    ("Rainy day", "savings"),
];

/// `(merchant, bank description, category notation, typical outflow)`.
pub const MERCHANTS: &[(&str, &str, &str, f64)] = &[
    ("Blue Bottle", "BLUE BOTTLE #12", "food.dining", 6.0),
    ("Whole Foods", "WHOLEFDS MKT 10442", "food.groceries", 85.0),
    ("Trader Joe's", "TRADER JOE S #551", "food.groceries", 55.0),
    ("Le Bistro", "LE BISTRO PARIS", "food.dining", 42.0),
    ("Taco Corner", "TACO CORNER 0231", "food.dining", 14.0),
    ("Shell", "SHELL OIL 5744", "transport.fuel", 48.0),
    ("Uber", "UBER *TRIP", "transport.transit", 17.0),
    (
        "Metro card",
        "METRO TRANSIT AUTO",
        "transport.transit",
        30.0,
    ),
    ("Netflix", "NETFLIX.COM", "fun.subscriptions", 15.5),
    ("Spotify", "SPOTIFY USA", "fun.subscriptions", 11.0),
    ("Cinema", "CINEPLEX 884", "fun.entertainment", 24.0),
    ("Amazon", "AMZN MKTP US", "shopping.general", 38.0),
    ("Ikea", "IKEA STORE 117", "housing.home", 120.0),
    ("Ace Hardware", "ACE HARDWARE", "housing.home", 27.0),
    (
        "City Power",
        "CITY POWER AND LIGHT",
        "utilities.bills",
        96.0,
    ),
    ("Water Dept", "WATER DEPT AUTOPAY", "utilities.bills", 41.0),
    ("Fibre ISP", "FIBRENET BILLING", "utilities.phone", 59.0),
    ("Mobile plan", "MOBILECO PAYMENT", "utilities.phone", 35.0),
    ("Pharmacy", "CVS PHARMACY 3012", "health.care", 19.0),
    ("Dr. Rao clinic", "RAO FAMILY CLINIC", "health.care", 80.0),
    ("Landlord", "RENT PAYMENT", "housing.rent", 1450.0),
    ("Bank fee", "MONTHLY SERVICE FEE", "fees", 6.0),
    ("Parking", "CITY PARKING", "transport", 9.0),
    ("Clothing store", "H AND M 0412", "shopping.general", 64.0),
];

pub const EMPLOYERS: &[&str] = &["Acme", "Globex", "Initech", "Hooli", "Umbrella", "Soylent"];

pub const CUSTOM_CATEGORIES: &[&str] = &["Pets fund", "Gifts", "Hobbies", "Kids", "Charity"];

pub const NOTE_BODIES: &[&str] = &[
    "Remember to follow up next week.",
    "Ideas for later, nothing urgent.",
    "Two cups, simmer for twenty minutes.",
    "Ask about the deposit before signing.",
    "Needs a second look after the weekend.",
    "Bring the printed copy and an ID.",
    "Check prices again before booking.",
    "Good option, a bit pricey though.",
];

// ---------------------------------------------------------------------------------------------
// Names for rows a request makes or renames (the sampler's `create` and `edit` of a name).
//
// One pool per kind, so a person is never "Plan the weekend" and a notebook is never a chore. A
// pool holds only strings that survive the pipeline verbatim: letters and spaces, no digit, no
// apostrophe or hyphen (the typo and normalisation passes leave a span alone, but the runtime
// reads digits and quotes), and no word the runtime reads as a date, a period, a verb of a turn or
// a retraction ("week", "last", "tomorrow", "delete", "forget it"). A unit test holds every pool
// to that. The pools are not asked to be disjoint from the world's own (a notebook may be named
// "Recipes" in a world and in a pool): the sampler picks a name no row of the kind already has.
// ---------------------------------------------------------------------------------------------

/// First names a created or renamed person can get, by split. None is in [`FIRST`], [`ME_TRAIN`],
/// [`ME_VAL`] or [`ME_TEST`], so a new person never shares a first name with one the world has;
/// val and test names are ones no training world's new person has.
pub const NEW_FIRST_TRAIN: &[&str] = &[
    "Aarav", "Bella", "Caleb", "Daria", "Eitan", "Fiona", "Gael", "Hazel", "Imran", "Jade",
    "Kabir", "Luna", "Mohan", "Nora", "Owen", "Petra", "Reza", "Selma", "Tobias", "Ulla", "Vikram",
    "Willa", "Yash", "Zainab", "Anselm", "Brynn", "Cyrus", "Delia", "Elias", "Fatima", "Greta",
    "Harun", "Ivy", "Joaquin", "Kaito", "Leila", "Mateus", "Nadir", "Opal", "Rohan", "Chirag",
    "Devika", "Eshaan", "Farhan", "Girish", "Heena", "Ila", "Jatin",
];
pub const NEW_FIRST_VAL: &[&str] = &[
    "Alina", "Bruno", "Celia", "Dario", "Eva", "Gabriel", "Halima", "Ismail", "Kamini", "Lokesh",
];
pub const NEW_FIRST_TEST: &[&str] = &[
    "Jasper", "Kiran", "Livia", "Malik", "Nina", "Otis", "Pablo", "Rania", "Mohit", "Nisha",
];

/// Last names a created or renamed person can get, by split; none is in [`LAST`].
pub const NEW_LAST_TRAIN: &[&str] = &[
    "Agarwal",
    "Bakker",
    "Castillo",
    "Dhillon",
    "Engel",
    "Fontaine",
    "Grover",
    "Hashemi",
    "Ito",
    "Jovanovic",
    "Venkataraman",
    "Laurent",
    "Mbeki",
    "Nakamura",
    "Oyelaran",
    "Pereira",
    "Rinaldi",
    "Sokolov",
    "Torres",
    "Underhill",
    "Vasquez",
    "Wagner",
    "Yadav",
    "Zielinski",
    "Abbasi",
    "Bergstrom",
    "Cardoso",
    "Dasgupta",
    "Esposito",
    "Friedman",
];
pub const NEW_LAST_VAL: &[&str] = &[
    "Gallo",
    "Hartmann",
    "Kasturirangan",
    "Kowalski",
    "Lindahl",
    "Subramaniam",
];
pub const NEW_LAST_TEST: &[&str] = &["Nilsson", "Ortega", "Pillai", "Quintero", "Rossi", "Sandhu"];

pub const NEW_TASKS: &[&str] = &[
    "Pick up the parcel",
    "Renew the passport",
    "Plan the picnic",
    "Water the plants",
    "Book the car service",
    "Call the landlord",
    "Order a birthday cake",
    "Fix the bike light",
    "Backup the laptop",
    "Return the library books",
    "Sort the receipts",
    "Email the school",
    "Buy printer ink",
    "Book a table for dinner",
    "Charge the power bank",
    "Clean the fridge",
    "Pay the credit card",
    "Collect the dry cleaning",
    "Get a haircut",
    "Wash the car",
    "Take out the recycling",
    "Fill the car with fuel",
    "Post the parcel",
    "Buy a new phone case",
    "Renew the gym plan",
    "Mail the rent cheque",
    "Order new contact lenses",
    "Fix the squeaky door",
    "Update the emergency contacts",
    "Print the boarding passes",
    "Buy milk and eggs",
    "Call the electrician",
    "Pack the gym bag",
    "Reply to the landlord",
    "Wrap the gift",
    "Book the vet visit",
    "Buy a birthday card",
    "Tidy the desk",
    "Change the bedsheets",
    "Refill the prescription",
    "Sync the photos",
    "Research standing desks",
    "Buy a yoga mat",
    "Book the airport taxi",
    "Check the tyre pressure",
    "Submit the reimbursement",
    "Defrost the freezer",
    "Compare broadband plans",
];

pub const NEW_EVENTS: &[&str] = &[
    "Brunch with the cousins",
    "Padel session",
    "Dentist checkup",
    "Design review",
    "Swim practice",
    "Piano recital",
    "Team lunch",
    "Board games night",
    "School open house",
    "Car inspection",
    "Photography walk",
    "Vet appointment",
    "Pottery class",
    "Neighbourhood cleanup",
    "Interview prep",
    "Book signing",
    "Cooking class",
    "Sprint planning",
    "Airport pickup",
    "Cricket match",
    "Eye test",
    "Salsa class",
    "Parents evening",
    "Wedding rehearsal",
    "Housewarming party",
    "Retro meeting",
    "Language exchange",
    "Concert at the park",
    "Lease signing",
    "Bike service",
    "Study group",
    "Karaoke night",
];

pub const NEW_LISTS: &[&str] = &[
    "Groceries",
    "Packing list",
    "Movies to watch",
    "Gift ideas",
    "Home repairs",
    "Birthday party",
    "Reading queue",
    "Hardware store",
    "Camping trip",
    "Wedding prep",
    "Garden jobs",
    "Moving boxes",
    "Hospital bag",
    "Date night ideas",
    "Podcast queue",
    "Kitchen upgrades",
    "Pharmacy run",
    "Conference prep",
    "Pet care",
    "Car trip snacks",
    "Spring cleaning",
    "Festival plans",
];

pub const NEW_NOTES: &[&str] = &[
    "Pizza dough",
    "Router password hints",
    "Plant care",
    "Quiz night questions",
    "Apartment viewing",
    "Toast ideas",
    "Packing for Goa",
    "Bike routes",
    "Standup talking points",
    "Curry spice mix",
    "Baby names",
    "Camera settings",
    "Wine to buy",
    "Speech draft",
    "Carpool rota",
    "Tea shop list",
    "Guitar chords",
    "Lego sets",
    "Parking spots",
    "Gift for mum",
    "Hotel shortlist",
    "Sleep log",
    "Bread recipe",
    "Chess openings",
    "House rules",
    "Taxi numbers",
    "Wall colours",
    "Skincare routine",
    "Interview feedback",
    "Product ideas",
    "Salary negotiation",
    "Ski trip costs",
];

pub const NEW_NOTEBOOKS: &[&str] = &[
    "Recipes",
    "Work journal",
    "Book club",
    "Side project",
    "Garden",
    "Dreams",
    "Gratitude",
    "Language learning",
    "Wedding planning",
    "Meeting minutes",
    "Photography",
    "Money ideas",
    "Kids",
    "Cooking experiments",
    "Running log",
    "House hunt",
    "Study notes",
    "Quotes",
    "Film diary",
    "Guitar practice",
];

/// `(name, type)`; the type is one the create form offers.
pub const NEW_LOCKER: &[(&str, &str)] = &[
    ("Netflix", "login"),
    ("Gym locker code", "password"),
    ("Home wifi", "wifi"),
    ("Spotify", "login"),
    ("Guest wifi", "wifi"),
    ("Amazon account", "login"),
    ("Travel credit card", "card"),
    ("Safe combination", "password"),
    ("Parents house wifi", "wifi"),
    ("Debit card", "card"),
    ("Airbnb login", "login"),
    ("Hotel wifi", "wifi"),
    ("Garage door code", "password"),
    ("Tax portal", "login"),
    ("Corporate card", "card"),
    ("Gmail", "login"),
    ("Cafe wifi", "wifi"),
    ("Alarm code", "password"),
    ("Pharmacy account", "login"),
    ("Fuel card", "card"),
    ("Disney Plus", "login"),
    ("Storage unit code", "password"),
    ("Kindle account", "login"),
    ("Studio wifi", "wifi"),
    ("Lounge access card", "card"),
    ("Utility portal", "login"),
    ("Phone unlock hint", "password"),
    ("Library card", "card"),
    ("Spare key note", "note"),
    ("Recovery phrase note", "note"),
    ("Safe room note", "note"),
    ("Locksmith note", "note"),
    ("Shed lock note", "note"),
    ("Backup drive note", "note"),
];

pub const NEW_ALBUMS: &[&str] = &[
    "Goa trip",
    "Wedding",
    "Diwali",
    "Puppy",
    "Road trips",
    "Graduation day",
    "Baby",
    "Concerts",
    "Garden",
    "Street food",
    "Mountain treks",
    "Christmas",
    "House renovation",
    "Best of the summer",
    "Cousins",
    "Beach days",
    "Old photos",
    "Cooking",
    "Marathon",
    "City breaks",
    "Sunsets",
    "Birthday bash",
    "Camping",
    "Art shows",
];

pub const NEW_FOLDERS: &[&str] = &[
    "Pension",
    "Visas",
    "Warranties",
    "Education",
    "Contracts",
    "Bank statements",
    "Utilities",
    "Property",
    "Kids school",
    "Immigration",
    "Investments",
    "Vehicle",
    "Legal",
    "Subscriptions",
    "Health records",
    "Old receipts",
    "Wedding",
    "Appliance manuals",
    "Certificates",
    "Pet records",
];

pub const NEW_DOCUMENTS: &[&str] = &[
    "Rental agreement",
    "Birth certificate",
    "Health insurance card",
    "Degree certificate",
    "Visa approval letter",
    "Bank statement",
    "Fridge warranty",
    "Salary slip",
    "Driving test result",
    "Marriage certificate",
    "Property deed",
    "Pet vaccination card",
    "Flight ticket",
    "Hotel booking",
    "Insurance claim form",
    "Tax filing receipt",
    "Employment contract",
    "Appliance manual",
    "School report",
    "Dental invoice",
    "Pension statement",
    "Vehicle registration",
    "Scholarship letter",
    "Gym contract",
    "Parking permit",
    "Reference letter",
    "Eye prescription",
    "Mobile bill",
];

/// `(name, type)`; the type is one the account form offers.
pub const NEW_ACCOUNTS: &[(&str, &str)] = &[
    ("Holiday fund", "savings"),
    ("Salary account", "checking"),
    ("Emergency fund", "savings"),
    ("Business card", "credit_card"),
    ("Pocket money", "cash"),
    ("Car fund", "savings"),
    ("Household account", "checking"),
    ("Wedding fund", "savings"),
    ("Spare change", "cash"),
    ("Fuel card", "credit_card"),
    ("Kids savings", "savings"),
    ("Side income", "checking"),
    ("Tax reserve", "savings"),
    ("Petty cash", "cash"),
];

pub const NEW_CATEGORIES: &[&str] = &[
    "Coffee",
    "Gym",
    "Books",
    "Gadgets",
    "Pets",
    "Hobbies",
    "Education",
    "Insurance",
    "Donations",
    "Haircare",
    "Eating out",
    "Home decor",
    "Software",
    "Gifts",
    "Childcare",
    "Parking",
];

pub const NEW_PHOTOS: &[&str] = &[
    "Rooftop sunset",
    "Puppy asleep",
    "Pasta night",
    "Lake reflection",
    "Group selfie",
    "Cousins at the wedding",
    "Bridge at dawn",
    "Cherry blossoms",
    "Fireworks",
    "Mountain pass",
    "Coffee art",
    "Rainy window",
    "Football final",
    "Temple steps",
    "Night market",
    "Ferry ride",
    "Garden tomatoes",
    "Birthday candles",
    "Train window",
    "Old bookshop",
    "Desert camp",
    "First snow",
    "Kite festival",
    "Backyard barbecue",
];

pub const NEW_WORKOUTS: &[&str] = &[
    "Evening jog",
    "Morning swim",
    "Pool laps",
    "Hill walk",
    "Park loop",
    "Studio yoga",
    "Canal ride",
    "Stair climb",
    "Beach run",
    "Lunch walk",
    "Spin class",
    "Rowing machine",
];

pub const NEW_TRANSACTIONS: &[&str] = &[
    "Corner bakery",
    "Bookshop",
    "Pet store",
    "Hardware market",
    "Barber",
    "Laundromat",
    "Flower shop",
    "Bike repair",
    "Ice cream parlour",
    "Stationery",
    "Car wash",
    "Street vendor",
    "Dry cleaner",
    "Phone repair",
    "Sandwich shop",
    "Garden centre",
];

/// The first and last name pools of a created or renamed person in a split.
#[must_use]
pub fn new_people(
    split: crate::settings::Split,
) -> (&'static [&'static str], &'static [&'static str]) {
    use crate::settings::Split;
    match split {
        Split::Train => (NEW_FIRST_TRAIN, NEW_LAST_TRAIN),
        Split::Val => (NEW_FIRST_VAL, NEW_LAST_VAL),
        Split::Test => (NEW_FIRST_TEST, NEW_LAST_TEST),
    }
}

/// The names a created or renamed row of `kind` can get, or `None` for a kind that is not named
/// from a pool (a person is `first last` from [`new_people`]).
#[must_use]
pub fn new_names(kind: &str) -> Option<Vec<&'static str>> {
    let plain = |pool: &'static [&'static str]| Some(pool.to_vec());
    match kind {
        "task" => plain(NEW_TASKS),
        "event" => plain(NEW_EVENTS),
        "list" => plain(NEW_LISTS),
        "note" => plain(NEW_NOTES),
        "notebook" => plain(NEW_NOTEBOOKS),
        "album" => plain(NEW_ALBUMS),
        "folder" => plain(NEW_FOLDERS),
        "document" => plain(NEW_DOCUMENTS),
        "category" => plain(NEW_CATEGORIES),
        "photo" => plain(NEW_PHOTOS),
        "transaction" => plain(NEW_TRANSACTIONS),
        "workout" => plain(NEW_WORKOUTS),
        "locker item" => Some(NEW_LOCKER.iter().map(|(n, _)| *n).collect()),
        "account" => Some(NEW_ACCOUNTS.iter().map(|(n, _)| *n).collect()),
        _ => None,
    }
}

/// The type a new locker item or account called `name` is made with, when the pool says.
#[must_use]
pub fn new_type(kind: &str, name: &str) -> Option<&'static str> {
    let pairs = match kind {
        "locker item" => NEW_LOCKER,
        "account" => NEW_ACCOUNTS,
        _ => return None,
    };
    pairs.iter().find(|(n, _)| *n == name).map(|(_, t)| *t)
}

/// Values a member types into a request to store them: fake on their face, never a stored value. Each split has its own
/// lists, so a held-out split never shares a value with train. Nothing here is a sealed value of any world: a world holds
/// only a placeholder.
#[derive(Debug, Clone, Copy)]
pub struct Typed {
    /// A password of a login, wifi or password item.
    pub passwords: &'static [&'static str],
    /// A card number of a card item.
    pub card_numbers: &'static [&'static str],
    /// The security code of a card item.
    pub cvvs: &'static [&'static str],
    /// The one-time seed of a login.
    pub codes: &'static [&'static str],
    /// The text of a secret note item.
    pub notes: &'static [&'static str],
    /// A user name of a login.
    pub usernames: &'static [&'static str],
    /// The address of a login.
    pub urls: &'static [&'static str],
}

const TYPED_TRAIN: Typed = Typed {
    passwords: &[
        "fake-heron-4417",
        "fake-otter-5832",
        "fake-badger-6190",
        "fake-lynx-7254",
        "fake-falcon-8316",
        "fake-marten-9471",
        "fake-plover-1034",
        "fake-weasel-2287",
        "fake-osprey-3395",
        "fake-ferret-4508",
        "fake-curlew-5619",
        "fake-gannet-6723",
    ],
    card_numbers: &[
        "0000 1111 2222 3333",
        "1111 2222 3333 4444",
        "5555 0000 5555 0000",
        "1234 0000 5678 0000",
        "9999 8888 7777 6666",
        "0101 0202 0303 0404",
    ],
    cvvs: &["111", "222", "333", "444", "123", "321"],
    codes: &[
        "FAKEAAAABBBBCCCC",
        "FAKEDDDDEEEEFFFF",
        "FAKEGGGGHHHHIIII",
        "FAKEJJJJKKKKLLLL",
        "FAKEMMMMNNNNOOOO",
        "FAKEPPPPQQQQRRRR",
    ],
    notes: &[
        "spare key hidden in the garden shed",
        "backup drive sits behind the fake blue books",
        "safe room combination is fake four seven two",
        "locksmith is on speed dial under fake name Marlin",
        "recovery words are fake river stone lantern",
        "alarm panel backup number is fake nine nine nine",
    ],
    usernames: &[
        "demo_heron",
        "demo_otter",
        "demo_badger",
        "demo_lynx",
        "demo_falcon",
        "demo_marten",
    ],
    urls: &[
        "https://demo-heron.example.com",
        "https://demo-otter.example.com",
        "https://demo-badger.example.com",
        "https://demo-lynx.example.com",
        "https://demo-falcon.example.com",
        "https://demo-marten.example.com",
    ],
};

const TYPED_VAL: Typed = Typed {
    passwords: &["fake-ibis-8841", "fake-stoat-9952", "fake-teal-1063"],
    card_numbers: &["2222 3333 4444 5555", "6666 7777 8888 9999"],
    cvvs: &["555", "666"],
    codes: &["FAKESSSSTTTTUUUU", "FAKEVVVVWWWWXXXX"],
    notes: &[
        "spare ladder lives under the fake porch",
        "recovery words are fake copper kettle moss",
    ],
    usernames: &["demo_ibis", "demo_stoat"],
    urls: &[
        "https://demo-ibis.example.com",
        "https://demo-stoat.example.com",
    ],
};

const TYPED_TEST: Typed = Typed {
    passwords: &["fake-quail-3285", "fake-newt-4396", "fake-pipit-5407"],
    card_numbers: &["3333 4444 5555 6666", "7777 8888 9999 0000"],
    cvvs: &["777", "888"],
    codes: &["FAKEYYYYZZZZ2222", "FAKE333344445555"],
    notes: &[
        "gate remote is stored in the fake teapot",
        "recovery words are fake amber cedar brook",
    ],
    usernames: &["demo_quail", "demo_newt"],
    urls: &[
        "https://demo-quail.example.com",
        "https://demo-newt.example.com",
    ],
};

/// The values a member types in, for the split.
#[must_use]
pub fn typed(split: crate::settings::Split) -> Typed {
    use crate::settings::Split;
    match split {
        Split::Train => TYPED_TRAIN,
        Split::Val => TYPED_VAL,
        Split::Test => TYPED_TEST,
    }
}

/// What a person says about a thing they add or change: a line for an event or a task.
pub const DESCRIPTIONS: &[&str] = &[
    "bring the printed forms",
    "ask about the invoice",
    "park behind the library",
    "check the tyre pressure first",
    "wear comfortable shoes",
    "meet at the side entrance",
    "take the spare charger",
    "confirm the booking by phone",
];

/// A nickname for a person.
pub const NICKNAMES: &[&str] = &[
    "Bru", "Dee", "Kiki", "Mo", "Tito", "Zee", "Pip", "Nunu", "Bash", "Jojo",
];

/// The body of a note.
pub const BODIES: &[&str] = &[
    "oat milk and rice",
    "ring the plumber about the tap",
    "ideas for the garden bench",
    "gift list for the cousins",
    "pack sunscreen and a hat",
    "questions for the dentist",
    "paint colours to compare",
    "books to borrow from the library",
];

/// The text of a document.
pub const DOC_TEXTS: &[&str] = &[
    "agenda for the committee meeting",
    "packing list for the hiking trip",
    "recipe notes for the lentil soup",
    "checklist for the flat inspection",
    "draft of the thank you letter",
];

/// An area a list sits in.
pub const AREAS: &[&str] = &[
    "Household",
    "Garden",
    "Errands",
    "Studio",
    "Travel",
    "Hobbies",
    "Family",
];

#[cfg(test)]
mod new_name_tests {
    use super::*;

    const KINDS: &[&str] = &[
        "task",
        "event",
        "list",
        "note",
        "notebook",
        "album",
        "folder",
        "document",
        "category",
        "photo",
        "transaction",
        "locker item",
        "account",
        "workout",
    ];

    /// Words the runtime reads for dates, periods, the verbs of a turn, or a retraction.
    const RESERVED: &[&str] = &[
        "today",
        "tomorrow",
        "yesterday",
        "tonight",
        "week",
        "weeks",
        "weekly",
        "weekend",
        "month",
        "months",
        "monthly",
        "year",
        "years",
        "yearly",
        "last",
        "next",
        "this",
        "ago",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
        "between",
        "from",
        "through",
        "until",
        "since",
        "before",
        "after",
        "around",
        "during",
        "unstar",
        "star",
        "undo",
        "restore",
        "delete",
        "complete",
        "reopen",
        "cancel",
        "reschedule",
        "unlink",
        "archive",
        "revert",
        "forget",
        "kidding",
        "skip",
        "scratch",
        "drop",
        "never",
        "mind",
        "leave",
        "fine",
        "it",
        "that",
        "now",
        "then",
    ];

    fn all_names() -> Vec<(&'static str, &'static str)> {
        let mut all: Vec<(&str, &str)> = Vec::new();
        for kind in KINDS {
            for name in new_names(kind).expect("a pool") {
                all.push((kind, name));
            }
        }
        for pool in [
            NEW_FIRST_TRAIN,
            NEW_FIRST_VAL,
            NEW_FIRST_TEST,
            NEW_LAST_TRAIN,
            NEW_LAST_VAL,
            NEW_LAST_TEST,
        ] {
            all.extend(pool.iter().map(|n| ("person", *n)));
        }
        all
    }

    #[test]
    fn every_pool_name_is_plain_and_reserved_free() {
        for (kind, name) in all_names() {
            assert!(
                name.chars().all(|c| c.is_ascii_alphabetic() || c == ' '),
                "{kind}: {name:?} has a digit or punctuation"
            );
            assert_eq!(name, name.trim(), "{kind}: {name:?}");
            for word in name.to_lowercase().split(' ') {
                assert!(!RESERVED.contains(&word), "{kind}: {name:?} has {word:?}");
            }
        }
    }

    #[test]
    fn no_pool_repeats_a_name() {
        for kind in KINDS {
            let mut seen = std::collections::BTreeSet::new();
            for name in new_names(kind).expect("a pool") {
                assert!(seen.insert(name.to_lowercase()), "{kind}: {name} twice");
            }
        }
    }

    #[test]
    fn new_people_share_nothing_with_the_world_pools_or_across_splits() {
        let world: std::collections::BTreeSet<&str> = FIRST
            .iter()
            .chain(LAST)
            .chain(ME_TRAIN)
            .chain(ME_VAL)
            .chain(ME_TEST)
            .copied()
            .collect();
        let pools = [
            NEW_FIRST_TRAIN,
            NEW_FIRST_VAL,
            NEW_FIRST_TEST,
            NEW_LAST_TRAIN,
            NEW_LAST_VAL,
            NEW_LAST_TEST,
        ];
        let mut seen = std::collections::BTreeSet::new();
        for pool in pools {
            for name in pool {
                assert!(!world.contains(name), "{name} is a world name");
                assert!(seen.insert(*name), "{name} is in two person pools");
            }
        }
    }

    #[test]
    fn pairs_name_a_type() {
        for (name, ty) in NEW_LOCKER {
            assert_eq!(new_type("locker item", name), Some(*ty));
        }
        for (name, ty) in NEW_ACCOUNTS {
            assert_eq!(new_type("account", name), Some(*ty));
        }
    }

    fn typed_values() -> Vec<(&'static str, &'static str)> {
        let mut all = Vec::new();
        for split in crate::settings::Split::ALL {
            let t = typed(split);
            for (what, pool) in [
                ("password", t.passwords),
                ("card_number", t.card_numbers),
                ("cvv", t.cvvs),
                ("code", t.codes),
                ("notes", t.notes),
                ("username", t.usernames),
                ("url", t.urls),
            ] {
                all.extend(pool.iter().map(|v| (what, *v)));
            }
        }
        all
    }

    #[test]
    fn a_typed_value_is_in_one_split_only_and_is_fake_and_plain() {
        let mut seen = std::collections::BTreeSet::new();
        for (what, value) in typed_values() {
            assert!(
                seen.insert(value),
                "{what}: {value:?} is in two pools or twice"
            );
            assert!(!value.contains("placeholder:"), "{value}");
            for word in value
                .to_lowercase()
                .split(|c: char| !c.is_ascii_alphabetic())
                .filter(|w| !w.is_empty())
            {
                assert!(!RESERVED.contains(&word), "{what}: {value:?} has {word:?}");
            }
        }
        for split in crate::settings::Split::ALL {
            let t = typed(split);
            for pool in [
                t.passwords,
                t.card_numbers,
                t.cvvs,
                t.codes,
                t.notes,
                t.usernames,
                t.urls,
            ] {
                assert!(!pool.is_empty(), "{split:?}");
            }
            assert!(t.passwords.iter().all(|p| p.starts_with("fake-")));
            assert!(t.card_numbers.iter().all(|c| c.len() == 19));
        }
    }

    #[test]
    fn every_locker_type_the_requests_need_has_a_name_to_make_it_with() {
        for ty in ["login", "wifi", "password", "card", "note"] {
            assert!(
                NEW_LOCKER.iter().filter(|(_, t)| *t == ty).count() >= 4,
                "{ty}"
            );
        }
    }
}

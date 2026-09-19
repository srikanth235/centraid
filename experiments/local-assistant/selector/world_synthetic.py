"""A synthetic world for selector training data, disjoint from the suite world.

Nothing here shares a name with ``world.py``: different people, companies,
events, projects, albums, notebooks, folders, places and topics. The suite's
vocabulary (Neha, Marcus, Initech, Hooli, Acme, Goa, Migration, Website
refresh, Contracts, Work notebook, ...) must never appear in generated
training text; ``overlap_check.py`` also enforces the stronger lexical rule.
"""

from __future__ import annotations

PEOPLE = [
    "Fiona Albright",
    "Dmitri Vance",
    "Oluchi Ekwueme",
    "Hana Lindqvist",
    "Rafael Bittencourt",
    "Mei Chow",
    "Yusuf Bakare",
    "Clara Nkemdirim",
    "Theo Vasquez",
    "Ingrid Halvorsen",
    "Nadia Boulos",
    "Sam Okonjo",
]
FIRST_NAMES = [p.split()[0] for p in PEOPLE]

COMPANIES = ["Vertigo Labs", "Northwind", "Baxtel", "Cobalt Works", "Larkspur"]

EVENTS = [
    "budget walkthrough",
    "vendor sync",
    "roadmap huddle",
    "hiring panel",
    "board prep",
    "launch party",
    "supplier call",
    "pottery class",
]

PROJECTS = ["Storefront rebuild", "Ledger cleanup", "Garden", "H1 roadmap", "Warehouse move"]
ALBUMS = ["Kerala", "Summit 2027", "Pets", "Roadtrip", "Balcony"]
NOTEBOOKS = ["Research", "Diary", "Sparks", "Kitchen", "Reading"]
FOLDERS = ["Invoices", "Legal", "Travel", "Warranties", "Taxes"]
GROUPS = ["Porto trip", "Housemates", "Book club", "Cycling crew"]
PLACES = ["Porto", "Whitefield", "Jaipur", "Oslo", "Table Mountain", "the lake house"]

TOPICS = [
    "insurance",
    "warranty",
    "the landlord",
    "the supplier deal",
    "cycling",
    "the boiler",
    "shipping rates",
    "the pension",
]
TASK_TITLES = [
    "water the plants",
    "return the router",
    "book the chimney sweep",
    "send the invoice",
    "renew the parking permit",
    "order printer ink",
]
SERVICES = ["Zenbank", "Fernpost", "Hollowmail", "Driftshare", "Pinecart"]
WINDOWS = [
    "tomorrow",
    "next week",
    "this weekend",
    "in October",
    "on the fourteenth",
    "next month",
    "on Thursday",
    "today",
]
DUE_WINDOWS = ["today", "this week", "next week", "by Friday", "overdue", "this month"]
DATES = ["Thursday", "next Tuesday", "the 22nd", "next month", "Friday morning", "in two weeks"]
TIMES = ["at 3pm on Thursday", "Monday at 9", "tomorrow at noon", "next Friday at 4:30"]
NOTE_TITLES = ["the boiler quote", "the supplier call notes", "the reading list"]
DOC_TOPICS = ["the lease", "the tax return", "the warranty card", "the supplier agreement"]
AMOUNTS = ["420", "1,200", "65", "3,400", "180"]
EXPENSES = ["dinner", "the taxi", "the cabin", "groceries", "the ferry tickets"]
CHANNELS = ["called", "emailed", "messaged", "met"]

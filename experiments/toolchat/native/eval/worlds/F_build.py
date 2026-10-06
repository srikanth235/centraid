"""World F: Horacio Sartori's household vault (Buenos Aires, retired bank clerk, ARS vault).

    python3 eval/worlds/F_build.py      # writes eval/worlds/F.json (deterministic)

Today in the sessions is Monday 2026-08-24 09:40 (back from the bakery in Caballito; the pharmacy pickup is at
half past eleven and Susi's birthday dinner is on Saturday).

Persona: Horacio Sartori, 68, retired after 35 years at Banco Nacion, living in a flat in Caballito with his wife
Susana ("Susi", 66, retired dressmaker). Three grown children with families: Gabriela ("Gaby") in Madrid with
Javier and the grandchildren Valentina (9) and Tomas (6); Sebastian ("Seba") in Cordoba with Carolina ("Caro")
and Benicio (4); Julieta ("Juli") in Mendoza with Nicolas. He sings bass in the Coro Vecinal Caballito
(Wednesday rehearsals, a concert in September), plays truco with the muchachos every Thursday at the club, goes
to the cardiologist, the physio and the pharmacy on a monthly rhythm (PAMI), and keeps a 2009 Fiat Siena on GNC
that needs its VTV and oblea. The vault is in ARS; the one foreign-currency position is the EUR group
"Madrid con Gaby 2025" (a vault debt can only be in the vault's own currency).

Built-in ambiguity: two Martas (Marta Moretti, Susi's sister, "Tia Marta"; Marta Perez, the choir treasurer) and
two Carloses (Carlos Mazzeo, the building administrator; Carlos Acuna, a truco partner), look-alike spellings
(Raul Zavala, a choir tenor, and Mirta Zabala, a neighbour; Silvana Ferreyra, the dentist, and Nelly Ferreira,
a choir alto), nicknames (Susi, Gaby, Seba, Juli, Beto, Tia Marta, Maestra Laura, Cacho, Pancho, El Gallego,
Dr Navarro, Dra Pinto, Quiroga, Anibal, Tito), look-alike events (Choir rehearsal and its spring-concert
extras, Cardiologist x2, GP check-up x2, Pharmacy pickup x4), near-duplicate tasks (six Pay expensas, four Pay
ABL, four Get the repeat prescription, three Pay Edesur), cancelled events and tasks, and trashed rows of every
trashable kind (one inside the 30-day restore window, one past it).
"""
from __future__ import annotations

import datetime as dt
import json
import re
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent

ME = "Horacio Sartori"
TODAY = "2026-08-24T09:40"
TODAY_DT = dt.datetime.fromisoformat(TODAY)
TODAY_D = TODAY_DT.date()
EPOCH = "2026-01-05T09:00"
EPOCH_DT = dt.datetime.fromisoformat(EPOCH)
DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
assert DOW[TODAY_D.weekday()] == "Mon"

# ----------------------------------------------------------------------------------------------
# people
# ----------------------------------------------------------------------------------------------

people = [
    # the family
    {"key": "susana", "name": "Susana Moretti", "role": "wife", "nickname": "Susi", "starred": True, "cadence": 1,
     "last_contacted": "2026-08-24T08:30", "last_contacted_kind": "visit", "met": "Villa Crespo"},
    {"key": "gaby", "name": "Gabriela Sartori", "role": "daughter in Madrid", "nickname": "Gaby", "starred": True,
     "cadence": 7, "last_contacted": "2026-08-23T14:45", "last_contacted_kind": "call"},
    {"key": "javier", "name": "Javier Ortega", "role": "son-in-law in Madrid", "cadence": 30,
     "last_contacted": "2026-08-02T14:40", "last_contacted_kind": "call", "met": "Madrid"},
    {"key": "valentina", "name": "Valentina Ortega", "role": "granddaughter in Madrid", "cadence": 14,
     "last_contacted": "2026-08-23T14:50", "last_contacted_kind": "call"},
    {"key": "tomas", "name": "Tomás Ortega", "role": "grandson in Madrid"},
    {"key": "seba", "name": "Sebastián Sartori", "role": "son in Córdoba", "nickname": "Seba", "starred": True,
     "cadence": 10, "last_contacted": "2026-08-20T21:00", "last_contacted_kind": "call"},
    {"key": "caro", "name": "Carolina Vidal", "role": "daughter-in-law in Córdoba", "nickname": "Caro"},
    {"key": "benicio", "name": "Benicio Sartori", "role": "grandson in Córdoba"},
    {"key": "juli", "name": "Julieta Sartori", "role": "daughter in Mendoza", "nickname": "Juli", "starred": True,
     "cadence": 10, "last_contacted": "2026-08-22T18:20", "last_contacted_kind": "message"},
    {"key": "nico", "name": "Nicolás Paz", "role": "Juli's partner in Mendoza", "nickname": "Nico"},
    {"key": "beto", "name": "Alberto Sartori", "role": "brother in Mar del Plata", "nickname": "Beto", "cadence": 21,
     "last_contacted": "2026-08-09T12:00", "last_contacted_kind": "call", "met": "Mar del Plata"},
    {"key": "tia_marta", "name": "Marta Moretti", "role": "Susana's sister", "nickname": "Tía Marta", "cadence": 21,
     "last_contacted": "2026-08-16T17:00"},
    # the choir
    {"key": "laura", "name": "Laura Echeverría", "role": "choir director", "nickname": "Maestra Laura",
     "starred": True, "met": "Coro Vecinal Caballito"},
    {"key": "hugo", "name": "Hugo Pereyra", "role": "choir bass", "cadence": 14, "last_contacted": "2026-08-19T21:10",
     "met": "Coro Vecinal Caballito"},
    {"key": "nelly", "name": "Nelly Ferreira", "role": "choir alto", "met": "Coro Vecinal Caballito"},
    {"key": "marta_p", "name": "Marta Pérez", "role": "choir treasurer", "met": "Coro Vecinal Caballito"},
    {"key": "raul_z", "name": "Raúl Zavala", "role": "choir tenor", "met": "Coro Vecinal Caballito"},
    # truco on Thursdays
    {"key": "cacho", "name": "Casimiro Ledesma", "role": "truco partner", "nickname": "Cacho", "cadence": 7,
     "last_contacted": "2026-08-20T19:40", "last_contacted_kind": "visit", "met": "Club Social"},
    {"key": "pancho", "name": "Francisco Rinaldi", "role": "truco partner", "nickname": "Pancho", "met": "Club Social"},
    {"key": "carlos_a", "name": "Carlos Acuña", "role": "truco partner", "met": "Club Social"},
    {"key": "gallego", "name": "Manuel Souto", "role": "truco partner", "nickname": "El Gallego", "met": "Club Social"},
    # doctors and the pharmacy
    {"key": "navarro", "name": "Alejandro Navarro", "role": "cardiologist", "nickname": "Dr Navarro"},
    {"key": "pinto", "name": "Mónica Pinto", "role": "GP at the PAMI clinic", "nickname": "Dra Pinto"},
    {"key": "kinesio", "name": "Lucas Arce", "role": "physio (kinesiólogo)", "last_contacted": "2026-08-21T11:45",
     "last_contacted_kind": "visit"},
    {"key": "dentist", "name": "Silvana Ferreyra", "role": "dentist", "nickname": "Dra Ferreyra"},
    {"key": "salvatierra", "name": "Gustavo Salvatierra", "role": "eye doctor", "nickname": "Dr Salvatierra"},
    {"key": "farmacia", "name": "Claudia Roldán", "role": "pharmacist", "nickname": "Claudia de la farmacia",
     "last_contacted": "2026-07-27T11:50", "last_contacted_kind": "visit"},
    # the car and the building
    {"key": "quiroga", "name": "Jorge Quiroga", "role": "mechanic", "nickname": "Quiroga"},
    {"key": "encargado", "name": "Aníbal Benavídez", "role": "building super", "nickname": "Aníbal", "cadence": 30,
     "last_contacted": "2026-08-22T09:00", "last_contacted_kind": "visit"},
    {"key": "carlos_m", "name": "Carlos Mazzeo", "role": "building administrator", "met": "Edificio Rivadavia"},
    {"key": "mirta_z", "name": "Mirta Zabala", "role": "neighbour 6B", "met": "Edificio Rivadavia"},
    # friends
    {"key": "nora", "name": "Nora Ibáñez", "role": "Susana's friend", "cadence": 21, "last_contacted": "2026-08-12T16:00"},
    {"key": "tito", "name": "Tito Grimaldi", "role": "old bank colleague", "nickname": "Tito", "cadence": 30,
     "last_contacted": "2026-07-25T18:00", "met": "Banco Nación"},
    # trashed: one inside the restore window, one past it
    {"key": "old_mecanico", "name": "Ramón Videla", "role": "old mechanic", "trashed": "2026-08-12T10:00"},
    {"key": "old_plomero", "name": "Rubén Ocampo", "role": "old plumber", "trashed": "2026-05-10T10:00"},
]

# ----------------------------------------------------------------------------------------------
# groups and expenses
# ----------------------------------------------------------------------------------------------

groups = [
    {"key": "coro_kitty", "name": "Coro Vecinal Kitty", "currency": "ARS",
     "members": ["laura", "hugo", "nelly", "marta_p", "raul_z"], "created": "2026-01-14T19:30"},
    {"key": "truco_kitty", "name": "Truco de los Jueves", "currency": "ARS",
     "members": ["cacho", "pancho", "carlos_a", "gallego"], "created": "2026-01-15T18:00"},
    {"key": "madrid", "name": "Madrid con Gaby 2025", "currency": "EUR", "members": ["gaby", "javier"],
     "created": "2025-11-20T21:00"},
    {"key": "regalos", "name": "Regalos de la Familia", "currency": "ARS", "members": ["gaby", "seba", "juli"],
     "created": "2026-02-10T20:00"},
    {"key": "edificio", "name": "Fondo del Edificio", "currency": "ARS", "members": ["mirta_z", "carlos_m"],
     "created": "2026-03-24T21:00"},
    {"key": "mdq", "name": "Mar del Plata 2027", "currency": "ARS", "members": ["beto", "tia_marta"],
     "created": "2026-08-09T12:30"},  # still a plan: no expenses yet
]

expenses = [
    {"group": "coro_kitty", "name": "Sheet music photocopies", "amount": 18500, "paid_by": "marta_p",
     "split": ["me", "laura", "hugo", "nelly", "marta_p", "raul_z"], "date": "2026-08-05"},
    {"group": "coro_kitty", "name": "Parish hall rent August", "amount": 60000, "paid_by": "laura",
     "split": ["me", "laura", "hugo", "nelly", "marta_p", "raul_z"], "date": "2026-08-03"},
    {"group": "coro_kitty", "name": "Medialunas for the rehearsal break", "amount": 14200, "paid_by": "me",
     "split": ["me", "hugo", "nelly", "marta_p"], "date": "2026-08-19"},
    {"group": "coro_kitty", "name": "Concert flyers", "amount": 9800, "paid_by": "raul_z",
     "split": ["me", "laura", "raul_z"], "date": "2026-08-17"},
    {"group": "truco_kitty", "name": "New deck of cards", "amount": 4500, "paid_by": "pancho",
     "split": ["me", "cacho", "pancho", "carlos_a", "gallego"], "date": "2026-07-09"},
    {"group": "truco_kitty", "name": "Coffee and tostados", "amount": 22400, "paid_by": "me",
     "split": ["me", "cacho", "pancho", "carlos_a"], "date": "2026-08-20"},
    {"group": "truco_kitty", "name": "Club tournament entry", "amount": 40000, "paid_by": "gallego",
     "split": ["me", "cacho", "gallego", "carlos_a"], "date": "2026-08-13"},
    {"group": "madrid", "name": "Dinner at Casa Lucio", "amount": 148.5, "paid_by": "javier",
     "split": ["me", "gaby", "javier"], "date": "2025-12-27"},
    {"group": "madrid", "name": "Prado tickets", "amount": 56, "paid_by": "me",
     "split": ["me", "gaby", "javier"], "date": "2025-12-23"},
    {"group": "madrid", "name": "Train to Toledo", "amount": 72, "paid_by": "me",
     "split": ["me", "gaby"], "date": "2025-12-29"},
    {"group": "madrid", "name": "Roscón and chocolate on Three Kings", "amount": 38.4, "paid_by": "gaby",
     "split": ["me", "gaby", "javier"], "date": "2026-01-04"},
    {"group": "regalos", "name": "Susi's birthday present", "amount": 120000, "paid_by": "seba",
     "split": ["me", "gaby", "seba", "juli"], "date": "2026-08-15"},
    {"group": "regalos", "name": "Cake for my birthday", "amount": 36000, "paid_by": "juli",
     "split": ["me", "seba", "juli"], "date": "2026-07-11"},
    {"group": "edificio", "name": "Painting the lobby", "amount": 180000, "paid_by": "carlos_m",
     "split": ["me", "mirta_z", "carlos_m"], "date": "2026-06-18"},
    {"group": "edificio", "name": "Doorbell repair", "amount": 24000, "paid_by": "me",
     "split": ["me", "mirta_z"], "date": "2026-08-01"},
]

lists = [
    {"key": "casa", "name": "Casa", "area": "home"},
    {"key": "salud", "name": "Salud", "area": "health"},
    {"key": "auto", "name": "Auto", "area": "home"},
    {"key": "coro_l", "name": "Coro", "area": "music"},
    {"key": "familia", "name": "Familia", "area": "family"},
    {"key": "tramites", "name": "Trámites", "area": "paperwork"},
]

# ----------------------------------------------------------------------------------------------
# events
# ----------------------------------------------------------------------------------------------

events = []
_busy = []


def _when(text):
    """'Thu 2026-08-27' -> a date, asserting the weekday is the one written."""
    dow, day = text.split()
    d = dt.date.fromisoformat(day)
    assert DOW[d.weekday()] == dow, f"{day} is a {DOW[d.weekday()]}, not {dow}"
    return d


def ev(key, name, when, start, end, **kw):
    d = _when(when) if isinstance(when, str) else when
    s = dt.datetime.fromisoformat(f"{d.isoformat()}T{start}")
    e = dt.datetime.fromisoformat(end if "T" in end else f"{d.isoformat()}T{end}")
    for bs, be, bk in _busy:
        assert not (s < be and bs < e), f"{key} overlaps {bk}"
    _busy.append((s, e, key))
    created = max(EPOCH_DT, min(s - dt.timedelta(days=3, hours=2), TODAY_DT - dt.timedelta(days=1)))
    row = {"key": key, "name": name, "start": s.strftime("%Y-%m-%dT%H:%M"), "end": e.strftime("%Y-%m-%dT%H:%M"),
           "created": created.strftime("%Y-%m-%dT%H:%M")}
    row.update(kw)
    events.append(row)


def weekly(first, last, step=7):
    d, stop = dt.date.fromisoformat(first), dt.date.fromisoformat(last)
    while d <= stop:
        yield d
        d += dt.timedelta(days=step)


def series(prefix, name, dates, start, end, skip=(), cancel=(), trash=None, **kw):
    for d in dates:
        if d.isoformat() in skip:
            continue
        extra = dict(kw)
        if d.isoformat() in cancel:
            extra["cancelled"] = True
        if trash and d.isoformat() in trash:
            extra["trashed"] = trash[d.isoformat()]
        ev(f"{prefix}_{d.strftime('%m%d')}", name, d, start, end, **extra)


# Wednesday choir, Thursday truco, the Sunday call to Madrid, the physio course, the monthly pharmacy pickup
series("choir", "Choir rehearsal", weekly("2026-07-29", "2026-09-23"), "19:00", "21:00",
       cancel={"2026-08-12"}, attendees=["laura", "hugo", "nelly"], description="parish hall, Rivadavia 5100")
series("truco", "Truco with the muchachos", weekly("2026-07-30", "2026-09-24"), "17:00", "20:00",
       cancel={"2026-08-06"}, trash={"2026-08-13": "2026-08-14T10:00"}, attendees=["cacho", "pancho", "gallego"])
series("callgaby", "Call Gaby", weekly("2026-08-09", "2026-09-27"), "14:00", "14:45", attendees=["gaby"],
       description="it is 19:00 in Madrid")
series("physio", "Physio - Lucas", [dt.date(2026, 8, 18), dt.date(2026, 8, 21), dt.date(2026, 8, 25), dt.date(2026, 8, 28),
                                    dt.date(2026, 9, 1), dt.date(2026, 9, 4)], "11:00", "11:45", attendees=["kinesio"])
series("pharm", "Pharmacy pickup", [dt.date(2026, 6, 29), dt.date(2026, 7, 27), dt.date(2026, 8, 24), dt.date(2026, 9, 21)],
       "11:30", "11:50", attendees=["farmacia"])

ev("cardio_mar", "Cardiologist - Dr Navarro", "Tue 2026-03-03", "10:30", "11:15", attendees=["navarro"])
ev("cardio_sep", "Cardiologist - Dr Navarro", "Wed 2026-09-02", "10:30", "11:15", attendees=["navarro"],
   description="bring the blood test and the pressure log")
ev("bloods", "Blood test", "Mon 2026-08-31", "08:00", "08:30", description="fasting, the lab on Rivadavia")
ev("gp_may", "GP check-up - Dra Pinto", "Thu 2026-05-28", "16:00", "16:40", attendees=["pinto"])
ev("gp_aug", "GP check-up - Dra Pinto", "Thu 2026-08-27", "16:00", "16:40", attendees=["pinto"])
ev("fe_de_vida", "Bank - fe de vida at Banco Nación", "Thu 2026-08-27", "10:00", "10:45")
ev("dentist_sep", "Dentist - Dra Ferreyra", "Wed 2026-09-09", "15:00", "15:45", attendees=["dentist"])
ev("eye_surgery", "Cataract surgery - Dr Salvatierra", "Tue 2026-05-12", "08:00", "10:00", attendees=["salvatierra"])
ev("eye_check", "Eye check - Dr Salvatierra", "Fri 2026-09-11", "09:30", "10:15", attendees=["salvatierra"])
ev("car_service", "Car service - Quiroga", "Sat 2026-08-29", "09:00", "11:00", attendees=["quiroga"],
   description="oil, filters and the GNC regulator")
ev("gnc", "GNC inspection for the oblea", "Tue 2026-09-15", "10:00", "11:00")
ev("vtv", "VTV appointment", "Wed 2026-09-16", "08:30", "09:15", description="bring the cédula verde and the policy")
ev("susi_bday", "Susi's birthday dinner", "Sat 2026-08-29", "21:00", "23:30", attendees=["susana", "nora", "tia_marta"],
   description="the parrilla near Plaza Primera Junta")
ev("assembly_mar", "Asamblea de consorcio", "Tue 2026-03-24", "19:00", "20:30", attendees=["carlos_m", "mirta_z"])
ev("assembly_sep", "Asamblea de consorcio", "Tue 2026-09-22", "19:00", "20:30", attendees=["carlos_m", "mirta_z"],
   description="the lift and the water tank on the agenda")
ev("extra_rehearsal", "Choir rehearsal - spring concert", "Sat 2026-09-12", "16:00", "18:00",
   attendees=["laura", "hugo", "nelly", "raul_z"])
ev("extra_rehearsal2", "Choir rehearsal - spring concert", "Sat 2026-09-19", "16:00", "18:00",
   attendees=["laura", "hugo", "nelly", "raul_z"])
ev("dress", "Dress rehearsal - spring concert", "Fri 2026-09-25", "19:00", "21:00", attendees=["laura", "hugo"])
ev("concert", "Concierto de primavera", "Sat 2026-09-26", "20:00", "22:00",
   attendees=["laura", "hugo", "nelly", "marta_p", "raul_z", "susana", "nora", "tito"],
   description="Parroquia San José, call time 19:00, black jacket")
ev("valentina_call", "Valentina's 10th birthday video call", "Sat 2026-09-12", "14:00", "14:30",
   attendees=["gaby", "valentina", "javier"])
ev("lunch_beto", "Lunch with Beto in Mar del Plata", "Sat 2026-09-05", "13:00", "16:00", attendees=["beto", "tia_marta"],
   cancelled=True, description="storm warning, postponed")
ev("fly_cba", "Flight to Córdoba", "Fri 2026-10-09", "07:30", "08:45", description="Aerolíneas, Aeroparque")
ev("benicio_bday", "Benicio's 5th birthday", "Sat 2026-10-10", "16:00", "19:00", attendees=["seba", "caro", "benicio"],
   description="at Seba's, they live in Nueva Córdoba")
ev("fly_back", "Flight back from Córdoba", "Sun 2026-10-11", "18:00", "19:15", description="Aerolíneas")
ev("truco_tournament", "Truco tournament at the club", "Sat 2026-10-03", "15:00", "19:00",
   attendees=["cacho", "pancho", "gallego", "carlos_a"])
ev("bday_asado", "Horacio's 68th birthday asado", "Sat 2026-07-11", "13:00", "17:00",
   attendees=["susana", "juli", "nico", "tia_marta", "cacho"], description="on the terrace")
ev("fathers_day", "Father's Day lunch", "Sun 2026-06-21", "13:00", "16:00", attendees=["susana", "tia_marta"])
ev("madrid_trip", "Madrid trip", "Fri 2025-12-19", "21:00", "2026-01-04T10:00", attendees=["gaby", "javier"],
   description="Aerolíneas from Ezeiza, two weeks with the grandchildren")
ev("coffee_tito", "Coffee with Tito", "Fri 2026-09-18", "17:00", "18:30", attendees=["tito"])
ev("old_truco", "Truco with the muchachos", "Thu 2026-04-16", "17:00", "20:00", attendees=["cacho"],
   trashed="2026-05-20T10:00")
ev("old_choir", "Choir rehearsal", "Wed 2026-04-15", "19:00", "21:00", attendees=["laura"], trashed="2026-05-20T10:05")

# ----------------------------------------------------------------------------------------------
# tasks
# ----------------------------------------------------------------------------------------------

tasks = []


def task(key, name, due=None, lst=None, **kw):
    row = {"key": key, "name": name}
    if due:
        row["due"] = due
    if lst:
        row["list"] = lst
    row.update(kw)
    tasks.append(row)
    return row


def done(stamp):
    return {"completed": stamp}


task("cba", "Trip to Córdoba for Benicio's birthday", "2026-10-09", "familia", priority=2, status="in_progress")
task("cba_flights", "Book the flights to Córdoba", "2026-08-18", "familia", parent="cba", **done("2026-08-17T20:30"))
task("cba_gift", "Buy Benicio's birthday present", "2026-09-30", "familia", parent="cba", effort=60)
task("cba_beds", "Ask Seba about the sleeping arrangements", "2026-09-10", "familia", parent="cba", effort=10)
task("cba_passes", "Print the boarding passes", "2026-10-08", "familia", parent="cba", effort=10)
task("cba_plants", "Ask Aníbal to water the plants", "2026-10-08", "familia", parent="cba")

task("autop", "Car papers: VTV and oblea", "2026-09-16", "auto", priority=1, status="in_progress")
task("autop_oblea", "Renew the GNC oblea", "2026-09-15", "auto", parent="autop", effort=60)
task("autop_vtv", "Book the VTV appointment", "2026-08-10", "auto", parent="autop", **done("2026-08-09T11:00"))
task("autop_patente", "Pay the patente before the VTV", "2026-09-10", "auto", parent="autop", priority=1)
task("autop_ins", "Renew the car insurance", "2026-09-12", "auto", parent="autop", effort=30)
task("autop_copy", "Photocopy the cédula verde", "2026-09-14", "auto", parent="autop", effort=10)

task("concierto_t", "Concierto de primavera", "2026-09-26", "coro_l", status="in_progress")
task("conc_bass", "Learn the bass line of the Fauré Requiem", "2026-09-20", "coro_l", parent="concierto_t", effort=420,
     priority=2)
task("conc_jacket", "Buy a black jacket", "2026-09-18", "coro_l", parent="concierto_t")
task("conc_print", "Print the programme with Marta", "2026-09-22", "coro_l", parent="concierto_t", effort=30)
task("conc_invite", "Invite Nora and Tito", "2026-09-12", "coro_l", parent="concierto_t", effort=10)
task("conc_copies", "Photocopy the scores", "2026-08-05", "coro_l", parent="concierto_t", **done("2026-08-04T17:45"))

task("susi_t", "Susi's birthday", "2026-08-29", "familia", priority=2)
task("susi_parrilla", "Book the parrilla", "2026-08-12", "familia", parent="susi_t", **done("2026-08-11T12:20"))
task("susi_cake", "Order the cake", "2026-08-27", "familia", parent="susi_t", effort=20)
task("susi_scarf", "Buy her the silk scarf", "2026-08-21", "familia", parent="susi_t", **done("2026-08-20T16:10"))

for key, due, extra in [("expensas_apr", "2026-04-10", done("2026-04-09T10:00")), ("expensas_may", "2026-05-10", done("2026-05-08T11:30")),
                        ("expensas_jun", "2026-06-10", done("2026-06-10T09:15")), ("expensas_jul", "2026-07-10", done("2026-07-09T10:45")),
                        ("expensas_aug", "2026-08-10", done("2026-08-10T09:40")), ("expensas_sep", "2026-09-10", {"priority": 1})]:
    task(key, "Pay expensas", due, "casa", **extra)
for key, due, extra in [("edesur_jun", "2026-06-20", done("2026-06-19T10:00")), ("edesur_aug", "2026-08-20", done("2026-08-19T18:20")),
                        ("edesur_oct", "2026-10-20", {})]:
    task(key, "Pay Edesur", due, "casa", **extra)
for key, due, extra in [("metrogas_jun", "2026-06-25", done("2026-06-24T10:30")), ("metrogas_aug", "2026-08-25", {}),
                        ("metrogas_oct", "2026-10-25", {})]:
    task(key, "Pay Metrogas", due, "casa", **extra)
for key, due, extra in [("abl_jun", "2026-06-12", done("2026-06-11T12:00")), ("abl_jul", "2026-07-12", done("2026-07-10T09:30")),
                        ("abl_aug", "2026-08-12", done("2026-08-12T10:20")), ("abl_sep", "2026-09-12", {})]:
    task(key, "Pay ABL", due, "casa", **extra)
for key, due, extra in [("tele_jun", "2026-06-05", done("2026-06-04T20:00")), ("tele_jul", "2026-07-05", done("2026-07-05T11:00")),
                        ("tele_aug", "2026-08-05", done("2026-08-04T19:45"))]:
    task(key, "Pay Telecentro", due, "casa", **extra)
for key, due, extra in [("meds_jun", "2026-06-29", done("2026-06-29T11:40")), ("meds_jul", "2026-07-27", done("2026-07-27T11:50")),
                        ("meds_aug", "2026-08-24", {"effort": 20}), ("meds_sep", "2026-09-21", {})]:
    task(key, "Pick up the medication at the pharmacy", due, "salud", **extra)
for key, due, extra in [("rx_jun", "2026-06-22", done("2026-06-22T10:10")), ("rx_jul", "2026-07-20", done("2026-07-20T10:05")),
                        ("rx_aug", "2026-08-17", done("2026-08-17T09:50")), ("rx_sep", "2026-09-14", {})]:
    task(key, "Get the repeat prescription from Dra Pinto", due, "salud", **extra)
for key, due, extra in [("patente_jun", "2026-06-10", done("2026-06-09T12:00")), ("patente_aug", "2026-08-10", done("2026-08-07T12:00")),
                        ("patente_oct", "2026-10-10", {})]:
    task(key, "Pay the patente", due, "auto", **extra)

task("fe_vida", "Do the fe de vida at the bank", "2026-08-27", "tramites", priority=1)
task("pami_card", "Renew the PAMI credential", "2026-09-30", "tramites", effort=45)
task("tap", "Fix the leaking tap in the bathroom", "2026-08-26", "casa", effort=45, priority=2)
task("balcony", "Clean the balcony", "2026-08-30", "casa", effort=60)
task("call_beto", "Call Beto about Mar del Plata", "2026-08-28", "familia", effort=15)
task("valentina_gift", "Send Valentina's birthday present by courier", "2026-08-26", "familia", priority=1, effort=45)
task("tito_back", "Pay Tito back for the battery", "2026-08-30", "auto", priority=1)
task("laura_folder", "Return the choir folder to Laura", "2026-08-19", "coro_l", effort=10)  # overdue
task("gaby_recipe", "Send Gaby the milanesas recipe", "2026-08-21", "familia", effort=15)  # overdue
task("susi_flowers", "Buy flowers for Susi", "2026-08-29", "familia", effort=15)
task("susi_glasses", "Pick up Susi's glasses", "2026-08-26", "salud", effort=20)
task("fridge", "Look at new fridges", "2026-08-12", "casa", status="cancelled")
task("bloods_book", "Book the blood test", "2026-08-20", "salud", **done("2026-08-19T10:30"))
task("old_wax", "Wax the car", "2026-08-30", "auto", created="2026-08-10T10:00", trashed="2026-08-20T10:00")
task("old_curtains", "Order new curtains", "2026-05-15", "casa", trashed="2026-06-01T10:00")
for t in tasks:  # a task is made a few days before it is due
    if t.get("due") and "created" not in t:
        made = dt.datetime.fromisoformat(t["due"][:10] + "T09:00") - dt.timedelta(days=6, hours=-1 * (len(t["key"]) % 5))
        t["created"] = max(EPOCH_DT, min(made, TODAY_DT - dt.timedelta(days=1))).strftime("%Y-%m-%dT%H:%M")

# ----------------------------------------------------------------------------------------------
# notes
# ----------------------------------------------------------------------------------------------

notebooks = [
    {"key": "salud_nb", "name": "Salud Notes"},
    {"key": "coro_nb", "name": "Coro Notes"},
    {"key": "auto_nb", "name": "Auto Notes"},
    {"key": "recetas_nb", "name": "Recetas"},
    {"key": "viajes_nb", "name": "Viajes"},
    {"key": "cartas_nb", "name": "Cartas"},  # stays empty
]
notes = []


def note(key, name, nb, created, body, **kw):
    row = {"key": key, "name": name, "created": created, "body": body}
    if nb:
        row["notebook"] = nb
    row.update(kw)
    notes.append(row)


note("meds", "Medication list", "salud_nb", "2026-01-08T10:00",
     "enalapril in the morning, atorvastatin at night, aspirin 100 after lunch, Susi takes levothyroxine fasting",
     pinned=True)
note("pressure", "Blood pressure log August", "salud_nb", "2026-08-23T09:00",
     "130 over 80 on the 3rd, 125 over 78 on the 10th, 140 over 85 on the 17th after the stairs, 128 over 80 today")
note("navarro_mar", "Dr Navarro advice March", "salud_nb", "2026-03-03T12:00",
     "less salt, walk thirty minutes a day, bring the log next time, stress test in September if the pressure stays up")
note("bloodwork", "Bloodwork results June", "salud_nb", "2026-06-04T18:00",
     "cholesterol 190, sugar 98, creatinine fine, Dra Pinto says same dose of atorvastatin")
note("knee", "Knee exercises from Lucas", "salud_nb", "2026-08-11T12:30",
     "leg raises twenty times, wall sits for a minute, the bike ten minutes, no stairs when it clicks")
note("repertoire", "Repertorio del concierto de primavera", "coro_nb", "2026-08-05T21:30",
     "Fauré Requiem Introit and Kyrie, Ave Verum Corpus, two Argentine folk songs arranged by Maestra Laura",
     pinned=True)
note("faure_bass", "Fauré Requiem bass notes", "coro_nb", "2026-08-12T22:00",
     "watch the entry at the Sanctus, breathe before the long phrase in the Libera me, ask Hugo for the page numbers")
note("rehearsal_19", "Rehearsal notes 19 Aug", "coro_nb", "2026-08-19T21:30",
     "tenors rushed the Kyrie, basses need the low D, Laura wants everyone in black, extra rehearsals in September")
note("coro_rules", "Coro dues and rules", "coro_nb", "2026-01-14T19:45",
     "dues 8000 a month to Marta, folders back on the shelf, no phones in the pews, coffee fund voluntary")
note("car_details", "Car details", "auto_nb", "2026-01-09T11:00",
     "Fiat Siena 2009, GNC fourth generation, 32 psi front and rear, spare tyre under the boot floor", pinned=True)
note("car_services", "Car services", "auto_nb", "2026-02-20T12:00",
     "last full service with Quiroga in February, brake pads in June, timing belt due at 110000 kilometres")
note("vtv_dates", "VTV and oblea dates", "auto_nb", "2026-07-02T10:30",
     "VTV expires 30 September, the GNC oblea expires 20 September, patente cuota every two months")
note("milanesas", "Milanesas de Susi", "recetas_nb", "2026-02-03T20:00",
     "thin beef round, egg and garlic and parsley, breadcrumbs twice, shallow fry, lemon at the table")
note("locro", "Locro del 25 de mayo", "recetas_nb", "2026-05-24T19:00",
     "white corn soaked overnight, beans, pumpkin, chorizo colorado, panceta, cook five hours, sauce on the side")
note("empanadas", "Empanadas tucumanas", "recetas_nb", "2026-04-18T18:30",
     "hand-cut beef, spring onion, cumin, hard-boiled egg, bake hot, repulgue with the double fold")
note("noquis", "Ñoquis del 29", "recetas_nb", "2026-07-29T12:30",
     "potatoes baked not boiled, flour little by little, a coin under the plate for luck")
note("madrid_notes", "Madrid 2025 - what to bring", "viajes_nb", "2025-11-22T20:00",
     "dulce de leche, yerba mate, alfajores for the kids, a warm coat, euros from Tito's cousin")
note("cba_plan", "Córdoba trip plan", "viajes_nb", "2026-08-18T21:00",
     "fly Friday morning, stay at Seba's, cake on Saturday, back Sunday evening, bring Benicio the wooden train")
note("diary_hard", "Diary entry - difficult week", None, "2026-08-14T22:30",
     "Susi's knee, three phone calls with PAMI, the lift was out twice, nobody picked up at the clinic")
note("diary_sunday", "Diary entry - lovely Sunday", None, "2026-08-23T21:00",
     "long call with Gaby and the kids, Valentina showed me her drawings, milanesas for lunch, early to bed")
note("valentina_ideas", "Gift ideas for Valentina", None, "2026-08-10T20:00",
     "a book of Argentine tales, a mate set for kids, a scarf of Boca for her brother")
note("susi_menu", "Susi's birthday menu", None, "2026-08-21T19:30",
     "provoleta, empanadas, bife de chorizo, flan with dulce de leche, a bottle of Malbec from Juli")
note("truco_rules", "Truco rules we argue about", None, "2026-07-16T20:00",
     "flor counts or not, envido with the three, who says mazo, the tournament rules are stricter")
note("building_numbers", "Building phone numbers", None, "2026-03-25T09:30",
     "Carlos the administrator, Aníbal the super, the lift company, the water tank cleaners, the locksmith")
note("old_list", "Old shopping list", None, "2026-08-10T10:00", "yerba, milk, bread, lemons", trashed="2026-08-16T10:00")
note("old_scratch", "Scratch note", None, "2026-04-02T10:00", "call the bank about the card", trashed="2026-05-05T10:00")

# ----------------------------------------------------------------------------------------------
# folders and documents
# ----------------------------------------------------------------------------------------------

folders = [
    {"key": "jubilacion_f", "name": "Jubilación"}, {"key": "salud_f", "name": "Salud"},
    {"key": "auto_f", "name": "Auto"}, {"key": "casa_f", "name": "Casa"},
    {"key": "familia_f", "name": "Familia"}, {"key": "coro_f", "name": "Coro"},
    {"key": "clasificar_f", "name": "Por clasificar"},  # stays empty
]
documents = [
    {"key": "recibo_jul", "name": "Recibo de jubilación Julio 2026", "folder": "jubilacion_f",
     "created": "2026-07-31T10:00"},
    {"key": "recibo_jun", "name": "Recibo de jubilación Junio 2026", "folder": "jubilacion_f",
     "created": "2026-06-30T10:00"},
    {"key": "supervivencia", "name": "Certificado de supervivencia 2026", "folder": "jubilacion_f",
     "created": "2026-02-12T11:00"},
    {"key": "pami_doc", "name": "PAMI credencial 2026", "folder": "salud_f", "created": "2026-01-10T10:00",
     "starred": True},
    {"key": "cardio_doc", "name": "Estudios cardiológicos 2026", "folder": "salud_f", "created": "2026-03-03T13:00"},
    {"key": "receta_ago", "name": "Receta electrónica Enalapril Agosto 2026", "folder": "salud_f",
     "created": "2026-08-17T10:00"},
    {"key": "cataratas", "name": "Informe cirugía de cataratas 2026", "folder": "salud_f", "created": "2026-05-12T12:00"},
    {"key": "seguro_auto", "name": "Seguro del auto 2026", "folder": "auto_f", "created": "2026-01-12T10:00",
     "starred": True},
    {"key": "vtv_2025", "name": "VTV certificado 2025", "folder": "auto_f", "created": "2025-09-18T11:00"},
    {"key": "cedula", "name": "Cédula verde Fiat Siena", "folder": "auto_f", "created": "2024-03-04T10:00"},
    {"key": "patente_doc_jun", "name": "Patente comprobante Junio 2026", "folder": "auto_f", "created": "2026-06-09T12:30"},
    {"key": "expensas_doc_jul", "name": "Expensas liquidación Julio 2026", "folder": "casa_f", "created": "2026-07-09T11:00"},
    {"key": "escritura", "name": "Escritura del departamento", "folder": "casa_f", "created": "2026-01-11T10:00",
     "starred": True},
    {"key": "pasaporte", "name": "Pasaporte Horacio scan", "folder": "familia_f", "created": "2026-01-10T11:00"},
    {"key": "dni_susana", "name": "DNI Susana scan", "folder": "familia_f", "created": "2026-01-10T11:05"},
    {"key": "faure_score", "name": "Partitura Fauré Requiem 2026", "folder": "coro_f", "created": "2026-08-04T18:00"},
    {"key": "programa", "name": "Programa concierto de primavera 2026", "folder": "coro_f", "created": "2026-08-20T20:00"},
    {"key": "resumen_bna", "name": "Resumen de cuenta Banco Nación Julio 2026", "created": "2026-08-02T09:00"},
    {"key": "old_abl", "name": "Boleta vieja ABL 2025", "folder": "casa_f", "created": "2025-12-01T10:00",
     "trashed": "2026-05-08T10:00"},
    {"key": "dup_cedula", "name": "Foto de cédula duplicada", "folder": "auto_f", "created": "2026-08-01T10:00",
     "trashed": "2026-08-17T10:00"},
]

# ----------------------------------------------------------------------------------------------
# albums and photos
# ----------------------------------------------------------------------------------------------

albums = [
    {"key": "madrid_al", "name": "Madrid 2025"}, {"key": "nietos_al", "name": "Nietos"},
    {"key": "coro_al", "name": "Coro Vecinal"}, {"key": "cba_al", "name": "Córdoba"},
    {"key": "familia_al", "name": "Familia Sartori"}, {"key": "viejas_al", "name": "Escaneos viejos"},  # empty
]
photos = [
    {"key": "p_mad_prado", "name": "Prado steps with the kids", "taken": "2025-12-23T11:30", "albums": ["madrid_al"],
     "people": ["gaby", "valentina", "tomas"], "starred": True},
    {"key": "p_mad_lucio", "name": "Dinner at Casa Lucio", "taken": "2025-12-27T21:40", "albums": ["madrid_al"],
     "people": ["javier", "gaby"]},
    {"key": "p_mad_toledo", "name": "Toledo from the bridge", "taken": "2025-12-29T13:10", "albums": ["madrid_al"],
     "people": ["gaby"]},
    {"key": "p_mad_roscon", "name": "Roscón on Three Kings", "taken": "2026-01-04T09:20", "albums": ["madrid_al"],
     "people": ["valentina", "tomas"]},
    {"key": "p_mad_retiro", "name": "Rowing at the Retiro", "taken": "2025-12-26T12:00", "albums": ["madrid_al"],
     "people": ["susana", "tomas"]},
    {"key": "p_mad_airport", "name": "Goodbye at Barajas", "taken": "2026-01-04T12:15", "albums": ["madrid_al"],
     "people": ["gaby", "javier", "valentina", "tomas"]},
    {"key": "p_ni_val_draw", "name": "Valentina's drawing of the flat", "taken": "2026-08-23T14:55",
     "albums": ["nietos_al"], "people": ["valentina"], "starred": True},
    {"key": "p_ni_tomas", "name": "Tomás missing a tooth", "taken": "2026-06-14T19:00", "albums": ["nietos_al"],
     "people": ["tomas"]},
    {"key": "p_ni_beni", "name": "Benicio on the wooden train", "taken": "2026-05-17T11:20", "albums": ["nietos_al"],
     "people": ["benicio"]},
    {"key": "p_ni_beni2", "name": "Benicio blowing out four candles", "taken": "2025-10-11T17:30",
     "albums": ["nietos_al", "cba_al"], "people": ["benicio", "seba", "caro"]},
    {"key": "p_ni_call", "name": "Video call with the three kids", "taken": "2026-07-26T14:30", "albums": ["nietos_al"],
     "people": ["valentina", "tomas", "benicio"]},
    {"key": "p_co_stage", "name": "Choir on the parish steps", "taken": "2026-06-27T21:30", "albums": ["coro_al"],
     "people": ["laura", "hugo", "nelly", "marta_p"], "starred": True},
    {"key": "p_co_laura", "name": "Maestra Laura conducting", "taken": "2026-08-19T20:15", "albums": ["coro_al"],
     "people": ["laura"]},
    {"key": "p_co_basses", "name": "The basses before the concert", "taken": "2026-06-27T19:50", "albums": ["coro_al"],
     "people": ["hugo", "raul_z"]},
    {"key": "p_co_score", "name": "Fauré score with my pencil marks", "taken": "2026-08-12T22:10", "albums": ["coro_al"]},
    {"key": "p_co_coffee", "name": "Coffee break at rehearsal", "taken": "2026-08-19T20:45", "albums": ["coro_al"],
     "people": ["nelly", "marta_p"]},
    {"key": "p_cb_house", "name": "Seba's house in Nueva Córdoba", "taken": "2025-10-11T12:00", "albums": ["cba_al"],
     "people": ["seba"]},
    {"key": "p_cb_sierras", "name": "Sierras de Córdoba from the car", "taken": "2025-10-12T10:30", "albums": ["cba_al"]},
    {"key": "p_cb_asado", "name": "Asado at Seba's", "taken": "2025-10-11T14:20", "albums": ["cba_al"],
     "people": ["seba", "caro", "susana"]},
    {"key": "p_cb_cake", "name": "Benicio's cake", "taken": "2025-10-11T17:10", "albums": ["cba_al"], "people": ["benicio"]},
    {"key": "p_fa_asado", "name": "My 68th birthday asado", "taken": "2026-07-11T14:30", "albums": ["familia_al"],
     "people": ["susana", "juli", "nico", "tia_marta"], "starred": True},
    {"key": "p_fa_juli", "name": "Juli and Nico at the terrace", "taken": "2026-07-11T16:00", "albums": ["familia_al"],
     "people": ["juli", "nico"]},
    {"key": "p_fa_susi", "name": "Susi with her sister", "taken": "2026-05-24T13:00", "albums": ["familia_al"],
     "people": ["susana", "tia_marta"]},
    {"key": "p_fa_beto", "name": "Beto in Mar del Plata", "taken": "2026-02-08T11:00", "albums": ["familia_al"],
     "people": ["beto"]},
    {"key": "p_fa_wedding", "name": "Juli and Nico's civil wedding", "taken": "2024-11-16T12:30", "albums": ["familia_al"],
     "people": ["juli", "nico", "susana"], "starred": True},
    {"key": "p_truco", "name": "Truco table at the club", "taken": "2026-08-20T18:30", "people": ["cacho", "pancho", "gallego"]},
    {"key": "p_siena", "name": "The Siena after the wash", "taken": "2026-07-04T10:10"},
    {"key": "p_balcony", "name": "Geraniums on the balcony", "taken": "2026-08-16T09:15", "people": ["susana"]},
    {"key": "p_lobby", "name": "The lobby freshly painted", "taken": "2026-06-20T11:00", "people": ["encargado"]},
    {"key": "p_receipt", "name": "Photo of the pharmacy receipt", "taken": "2026-07-27T11:55"},
    {"key": "p_lift", "name": "Out of order sign on the lift", "taken": "2026-08-13T08:10"},
    {"key": "p_sunset", "name": "Sunset over Caballito", "taken": "2026-03-14T18:40", "starred": True},
    {"key": "p_blurry", "name": "Blurry photo of the cat next door", "taken": "2026-08-01T10:00",
     "trashed": "2026-08-12T09:00"},
    {"key": "p_screen", "name": "Screenshot of the bus map", "taken": "2026-03-02T12:00", "trashed": "2026-04-02T09:00"},
]

# ----------------------------------------------------------------------------------------------
# debts (ARS)
# ----------------------------------------------------------------------------------------------

debts = [
    {"key": "d_cacho_cafe", "person": "cacho", "direction": "owes_me", "amount": 8000,
     "name": "coffee and tostados at the club", "date": "2026-08-20"},
    {"key": "d_pancho_deck", "person": "pancho", "direction": "owes_me", "amount": 4500,
     "name": "his half of the deck", "date": "2026-07-09", "settled": "2026-07-16T19:30"},
    {"key": "d_tito_battery", "person": "tito", "direction": "i_owe", "amount": 85000,
     "name": "car battery he bought", "date": "2026-08-08"},
    {"key": "d_mirta_plumber", "person": "mirta_z", "direction": "owes_me", "amount": 22000,
     "name": "shared plumber visit", "date": "2026-08-01"},
    {"key": "d_beto_tickets", "person": "beto", "direction": "owes_me", "amount": 60000,
     "name": "bus tickets to Mar del Plata", "date": "2026-02-06", "settled": "2026-02-20T12:00"},
    {"key": "d_gaby_toy", "person": "gaby", "direction": "i_owe", "amount": 48000,
     "name": "toy she sent to Benicio for me", "date": "2026-08-15"},
    {"key": "d_seba_flights", "person": "seba", "direction": "owes_me", "amount": 150000,
     "name": "his share of the family flights", "date": "2026-08-17"},
    {"key": "d_martap_copies", "person": "marta_p", "direction": "owes_me", "amount": 6300,
     "name": "choir photocopies", "date": "2026-08-05"},
    {"key": "d_quiroga_pads", "person": "quiroga", "direction": "i_owe", "amount": 42000,
     "name": "brake pads", "date": "2026-06-20", "settled": "2026-06-27T11:00"},
    {"key": "d_farmacia_cuenta", "person": "farmacia", "direction": "i_owe", "amount": 15500,
     "name": "medication on the account", "date": "2026-07-27"},
    {"key": "d_carlosm_extra", "person": "carlos_m", "direction": "i_owe", "amount": 12000,
     "name": "extra expensas for the water tank", "date": "2026-08-10"},
    {"key": "d_nora_tickets", "person": "nora", "direction": "owes_me", "amount": 36000,
     "name": "concert tickets for her and Susi", "date": "2026-05-30", "settled": "2026-06-06T17:00"},
]

# ----------------------------------------------------------------------------------------------
# locker
# ----------------------------------------------------------------------------------------------

locker = [
    {"key": "bna_login", "name": "Banco Nación home banking", "type": "login", "username": "hsartori58",
     "url": "https://bna.com.ar", "password": "Caballito#1958", "code": "KRSXG5CTMVRXEZLU", "starred": True},
    {"key": "anses_login", "name": "Mi ANSES", "type": "login", "username": "20-12345678-9",
     "url": "https://anses.gob.ar", "password": "Jubilado2023!"},
    {"key": "pami_login", "name": "PAMI app", "type": "login", "username": "hsartori", "url": "https://pami.org.ar",
     "password": "Pami_Susi66"},
    {"key": "visa_card", "name": "Visa Banco Nación", "type": "card", "card_number": "4509123498765432",
     "cvv": "318"},
    {"key": "door_note", "name": "Building front door code", "type": "note", "notes": "1958A then enter",
     "starred": True},
    {"key": "dni", "name": "DNI Horacio", "type": "identity"},
    {"key": "home_wifi", "name": "Home wifi", "type": "wifi", "password": "SusiYHoracio1958", "starred": True},
    {"key": "club_wifi", "name": "Club wifi", "type": "wifi", "password": "TrucoJueves26"},
    {"key": "telecentro_pw", "name": "Telecentro account", "type": "password", "password": "Cable#Caballito"},
    {"key": "nas_ssh", "name": "Family photo server SSH key", "type": "ssh_key",
     "notes": "Seba set it up on an old PC, ed25519"},
    {"key": "telegram_bot", "name": "Building Telegram bot token", "type": "api_credential",
     "notes": "for the building group announcements"},
    {"key": "passport", "name": "Passport - Horacio", "type": "passport", "notes": "AAB123456, expires 2031-03-11"},
    {"key": "cbu", "name": "Banco Nación caja de ahorro", "type": "bank_account",
     "notes": "CBU in the red folder, branch Caballito", "starred": True},
    {"key": "licencia", "name": "Licencia de conducir", "type": "driving_licence",
     "notes": "renew every three years after 65, expires March 2028"},
    {"key": "eset", "name": "ESET antivirus licence", "type": "software_licence",
     "notes": "two PCs, renews in September", "starred": True},
    {"key": "usdt", "name": "USDT wallet", "type": "crypto_wallet", "notes": "Seba's idea, about 300 dollars"},
    {"key": "club_member", "name": "Club Social y Deportivo membership", "type": "membership",
     "notes": "socio 1184, fees paid to September"},
    {"key": "escritura_doc", "name": "Escritura original", "type": "document",
     "notes": "original with the escribano, copy in the Casa folder"},
    {"key": "old_wifi", "name": "Old Telecentro wifi", "type": "wifi", "password": "Telecentro2023",
     "trashed": "2026-08-10T10:00"},
    {"key": "old_yahoo", "name": "Old Yahoo mail", "type": "login", "username": "hsartori58", "password": "Yahoo1999",
     "trashed": "2026-04-02T10:00"},
]

# ----------------------------------------------------------------------------------------------
# links (task -> person, note -> person: the only ones the model sees)
# ----------------------------------------------------------------------------------------------

links = [
    {"from": "cba_beds", "to": "seba"}, {"from": "cba_gift", "to": "benicio"}, {"from": "cba_plants", "to": "encargado"},
    {"from": "autop_oblea", "to": "quiroga"}, {"from": "tito_back", "to": "tito"},
    {"from": "conc_print", "to": "marta_p"}, {"from": "conc_invite", "to": "nora"}, {"from": "conc_invite", "to": "tito"},
    {"from": "laura_folder", "to": "laura"}, {"from": "susi_cake", "to": "susana"}, {"from": "susi_flowers", "to": "susana"},
    {"from": "susi_glasses", "to": "susana"}, {"from": "gaby_recipe", "to": "gaby"},
    {"from": "valentina_gift", "to": "valentina"}, {"from": "call_beto", "to": "beto"},
    {"from": "rx_jun", "to": "pinto"}, {"from": "rx_jul", "to": "pinto"}, {"from": "rx_aug", "to": "pinto"},
    {"from": "rx_sep", "to": "pinto"}, {"from": "meds_jun", "to": "farmacia"}, {"from": "meds_jul", "to": "farmacia"},
    {"from": "meds_aug", "to": "farmacia"}, {"from": "meds_sep", "to": "farmacia"},
    {"from": "bloods_book", "to": "pinto"}, {"from": "tap", "to": "encargado"},
    {"from": "expensas_sep", "to": "carlos_m"}, {"from": "expensas_aug", "to": "carlos_m"},
    {"from": "navarro_mar", "to": "navarro"}, {"from": "bloodwork", "to": "pinto"}, {"from": "knee", "to": "kinesio"},
    {"from": "faure_bass", "to": "hugo"}, {"from": "rehearsal_19", "to": "laura"}, {"from": "coro_rules", "to": "marta_p"},
    {"from": "car_services", "to": "quiroga"}, {"from": "milanesas", "to": "susana"},
    {"from": "valentina_ideas", "to": "valentina"}, {"from": "susi_menu", "to": "juli"},
    {"from": "building_numbers", "to": "carlos_m"}, {"from": "building_numbers", "to": "encargado"},
    {"from": "cba_plan", "to": "seba"}, {"from": "diary_sunday", "to": "gaby"},
]

world = {
    "me": ME, "today": TODAY, "epoch": EPOCH, "seed": "F", "currency": "ARS",
    "people": people, "groups": groups, "expenses": expenses, "lists": lists, "events": events,
    "tasks": tasks, "notebooks": notebooks, "notes": notes, "folders": folders, "documents": documents,
    "albums": albums, "photos": photos, "debts": debts, "locker": locker, "links": links,
}

# ----------------------------------------------------------------------------------------------
# checks shared by the three held-out worlds (E, F, G): references, keys, the seeder's own refusals
# ----------------------------------------------------------------------------------------------

LOCKER_TYPES = ["login", "card", "note", "identity", "wifi", "password", "ssh_key", "api_credential", "passport",
                "bank_account", "driving_licence", "software_licence", "crypto_wallet", "membership", "document"]
# the fields a type keeps (the seeder reports, or silently nulls, anything else)
LOCKER_KEEPS = {
    "login": {"username", "url", "notes", "password", "code"}, "card": {"card_number", "cvv"}, "note": {"notes"},
    "identity": set(), "wifi": {"password"}, "password": {"password"},
}
TRASH_KINDS = ("people", "events", "tasks", "notes", "documents", "photos", "locker")


def _stamp(text):
    return dt.datetime.fromisoformat(text if "T" in text else text + "T00:00")


def check_common(w):
    """Keys unique and snake_case, every reference resolves, no two events overlap (cancelled and trashed
    ones are created live, so they count too), every locker type present with only the fields its type
    keeps, nothing created in the future, every trashable kind has a row trashed inside the 30-day
    restore window and one past it, and the seeder's own refusals (an expense outside its group, a
    parent that comes after its child) cannot happen."""
    today = _stamp(w["today"])
    assert w["me"] and w["today"] and w["currency"]
    keys = {}
    for kind, rows in w.items():
        if not isinstance(rows, list):
            continue
        for r in rows:
            if "key" in r:
                k = r["key"]
                assert k not in keys, f"duplicate key {k}"
                assert re.fullmatch(r"[a-z][a-z0-9_]*", k) and len(k) <= 30, f"bad key {k!r}"
                keys[k] = kind
    keys["me"] = "people"

    def need(key, kind):
        assert keys.get(key) == kind, f"{key} is not a {kind}"

    seen_task = set()
    for t in w["tasks"]:
        if "parent" in t:
            need(t["parent"], "tasks")
            assert t["parent"] in seen_task, f"parent {t['parent']} must come before its subtask {t['key']}"
        if "list" in t:
            need(t["list"], "lists")
        seen_task.add(t["key"])
        assert not (t.get("status") == "cancelled" and "completed" in t), t["key"]
    for g in w["groups"]:
        [need(m, "people") for m in g["members"]]
        assert len(set(g["members"])) == len(g["members"]), g["key"]
    for e in w["expenses"]:
        need(e["group"], "groups")
        [need(m, "people") for m in e["split"]]
        need(e["paid_by"], "people")
        members = set(next(g["members"] for g in w["groups"] if g["key"] == e["group"])) | {"me"}
        assert set(e["split"]) | {e["paid_by"]} <= members, f"expense outside its group: {e['name']}"
        assert len(set(e["split"])) == len(e["split"]), e["name"]
        assert _stamp(e["date"]) <= today, e["name"]
    for n in w["notes"]:
        if "notebook" in n:
            need(n["notebook"], "notebooks")
    for d in w["documents"]:
        if "folder" in d:
            need(d["folder"], "folders")
    for p in w["photos"]:
        [need(a, "albums") for a in p.get("albums", [])]
        [need(q, "people") for q in p.get("people", [])]
        assert len(set(p.get("albums", []))) == len(p.get("albums", [])), p["key"]
        assert _stamp(p["taken"]) <= today, p["key"]
    for d in w["debts"]:
        need(d["person"], "people")
        assert d["direction"] in ("owes_me", "i_owe") and d["amount"] > 0, d["key"]
        assert _stamp(d["date"]) <= today, d["key"]
        if "settled" in d:
            assert _stamp(d["date"]) <= _stamp(d["settled"]) <= today, d["key"]
    for e in w["events"]:
        [need(a, "people") for a in e.get("attendees", [])]
        assert e["start"] < e["end"], e["key"]
    for ln in w["links"]:
        assert ln["from"] in keys and ln["to"] in keys, ln
        assert keys[ln["to"]] == "people" and keys[ln["from"]] in ("tasks", "notes"), ln  # the only links the model sees
    assert len({(l["from"], l["to"]) for l in w["links"]}) == len(w["links"]), "duplicate link"
    # the names the vault keeps unique
    for section in ("people", "lists", "folders"):
        names = [r["name"] for r in w[section]]
        assert len(names) == len(set(names)), f"duplicate {section} names"
    names = [g["name"] for g in w["groups"]] + [n["name"] for n in w["notebooks"]] + [a["name"] for a in w["albums"]]
    assert len(names) == len(set(names)), "group/notebook/album names must be unique"
    # no overlapping events
    spans = sorted((e["start"], e["end"], e["key"]) for e in w["events"])
    for (s1, e1, k1), (s2, e2, k2) in zip(spans, spans[1:]):
        assert e1 <= s2, f"events overlap: {k1} and {k2}"
    # the locker
    assert {r["type"] for r in w["locker"]} == set(LOCKER_TYPES), sorted({r["type"] for r in w["locker"]})
    for r in w["locker"]:
        extra = set(r) - {"key", "name", "type", "starred", "trashed", "created"} - LOCKER_KEEPS.get(r["type"], {"notes"})
        assert not extra, f"{r['key']}: a {r['type']} item keeps no {sorted(extra)}"
    # nothing from the future; trash stamps sit between creation and today
    for kind in ("people", "events", "tasks", "notes", "documents", "photos", "locker", "lists", "groups"):
        for r in w[kind]:
            for field in ("created", "completed", "trashed"):
                if field in r and isinstance(r[field], str):
                    assert _stamp(r[field]) <= today, f"{r['key']}.{field} is in the future"
            if isinstance(r.get("trashed"), str) and "created" in r:
                assert _stamp(r["created"]) <= _stamp(r["trashed"]), f"{r['key']} trashed before it was made"
    # trashed rows of every trashable kind, inside the restore window and past it (not borderline)
    for kind in TRASH_KINDS:
        age = [(today - _stamp(r["trashed"])).days for r in w[kind] if isinstance(r.get("trashed"), str)]
        assert any(a <= 26 for a in age), f"no trashed {kind} inside the 30-day window: {age}"
        assert any(a >= 36 for a in age), f"no trashed {kind} past the 30-day window: {age}"
        assert all(a < 28 or a > 34 for a in age), f"a borderline trashed {kind}: {age}"
    # the ambiguity every vault needs
    assert any(e.get("cancelled") for e in w["events"] if e["start"] < w["today"]), "a cancelled past event"
    assert any(e.get("cancelled") for e in w["events"] if e["start"] > w["today"]), "a cancelled future event"
    assert any(t.get("status") == "cancelled" for t in w["tasks"]), "a cancelled task"
    assert any(t.get("status") == "in_progress" for t in w["tasks"]), "an in-progress task"
    assert any(t.get("completed") for t in w["tasks"]), "a completed task"
    assert any(not t.get("completed") and t.get("due", "9") < w["today"][:10] and "status" not in t
               and "trashed" not in t for t in w["tasks"]), "an open overdue task"
    assert sum(1 for p in w["people"] if p.get("nickname")) >= 5, "nicknames"
    assert any(any(e["group"] == g["key"] for e in w["expenses"]) for g in w["groups"]), "a group with expenses"
    assert any(not any(e["group"] == g["key"] for e in w["expenses"]) for g in w["groups"]), "an empty group"
    assert any(not any(d.get("folder") == f["key"] for d in w["documents"]) for f in w["folders"]), "an empty folder"
    assert any(not any(n.get("notebook") == b["key"] for n in w["notes"]) for b in w["notebooks"]), "an empty notebook"
    assert any(not any(a in p.get("albums", []) for p in w["photos"]) for a in [x["key"] for x in w["albums"]]), \
        "an empty album"
    assert any(t.get("parent") for t in w["tasks"]), "subtasks"
    assert any(p.get("starred") for p in w["people"]) and any(d.get("starred") for d in w["documents"])
    assert any(p.get("starred") for p in w["photos"]) and any(n.get("pinned") for n in w["notes"])
    assert any("settled" in d for d in w["debts"]) and any("settled" not in d for d in w["debts"])
    assert any(d["direction"] == "owes_me" for d in w["debts"]) and any(d["direction"] == "i_owe" for d in w["debts"])
    assert len({g.get("currency") for g in w["groups"]} | {w["currency"]}) >= 2, "a foreign-currency group"
    # a person's first name shared with another live person: the planted clusters only (the caller names them)
    firsts = Counter(p["name"].split()[0] for p in w["people"] if "trashed" not in p)
    return {f: c for f, c in firsts.items() if c > 1}


def check(w):
    clusters = check_common(w)
    assert clusters == {"Marta": 2, "Carlos": 2}, clusters
    n = {k: len(v) for k, v in w.items() if isinstance(v, list)}
    # the ordinary size of the brief, with recurring history for volume
    assert 25 <= n["people"] <= 35 and 4 <= n["groups"] <= 6, n
    assert 50 <= n["events"] <= 70 and 50 <= n["tasks"] <= 70, n
    assert 20 <= n["notes"] <= 30 and 15 <= n["documents"] <= 20 and 30 <= n["photos"] <= 40, n
    assert 10 <= n["debts"] <= 15 and 15 <= n["locker"] <= 20, n
    # the planted ambiguity, by name
    names = {p["name"] for p in w["people"]}
    assert {"Marta Moretti", "Marta Pérez", "Carlos Mazzeo", "Carlos Acuña", "Raúl Zavala", "Mirta Zabala",
            "Silvana Ferreyra", "Nelly Ferreira"} <= names
    ev_names = Counter(e["name"] for e in w["events"])
    assert ev_names["Cardiologist - Dr Navarro"] == 2 and ev_names["GP check-up - Dra Pinto"] == 2
    assert ev_names["Pharmacy pickup"] == 4 and ev_names["Choir rehearsal"] >= 8
    assert {"Choir rehearsal", "Choir rehearsal - spring concert", "Dress rehearsal - spring concert"} <= set(ev_names)
    assert ev_names["Asamblea de consorcio"] == 2
    task_names = Counter(t["name"] for t in w["tasks"])
    assert task_names["Pay expensas"] == 6 and task_names["Pay ABL"] == 4 and task_names["Pay Edesur"] == 3
    assert task_names["Get the repeat prescription from Dra Pinto"] == 4
    # the foreign-currency group (the euros), with expenses
    madrid = next(g for g in w["groups"] if g["currency"] == "EUR")
    assert any(e["group"] == madrid["key"] for e in w["expenses"])
    assert sum(1 for t in w["tasks"] if t.get("completed")) >= 25


if __name__ == "__main__":
    check(world)
    (HERE / "F.json").write_text(json.dumps(world, indent=1, ensure_ascii=False) + "\n")
    counts = {k: len(v) for k, v in world.items() if isinstance(v, list)}
    print("F:", counts)

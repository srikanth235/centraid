from gold import *

world("T28", "2026-02-21T12:00", "Wiremu Tane", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T28-A002", "ask-options event reschedule c3a",
  T("push the gp appointment to friday", ask("gp_feb", "gp_mar"),
    ref=[act("reschedule", kind="event", name="GP appointment with Dr Lim", args=lines(to=U("week", 1, weekday=5))),
         find(kind="event", name="GP appointment with Dr Lim", when=J({"from": U("day", 0)})),
         askc("The one on 24 Feb or the one on 24 March?", options="$gp_feb, $gp_mar")]),
  T("the feb one", diff(upd("gp_feb", date="2026-02-27T09:30")),
    ref=[act("reschedule", rows="$gp_feb", args=lines(to=U("week", 1, weekday=5)))]))

S("T28-A003", "ask-options task complete c3a",
  T("tick off the ring one", ask("inv_kaum", "ring_rawiri"),
    ref=[act("complete", kind="task", name="ring"),
         askc("Ring the kaumātua or Ring Rawiri about flights?", options="$inv_kaum, $ring_rawiri")]),
  T("rawiri's, spoke to him this morning", diff(upd("ring_rawiri", status="completed", completed=ANY)),
    ref=[act("complete", rows="$ring_rawiri")]),
  T("and the spouting one's done, tick it off", diff(upd("spouting", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="spouting")]))

S("T28-A004", "ask-options document delete never_mind c3a",
  T("delete the scan", ask("chart_scan", "scan"),
    ref=[act("delete", kind="document", name="scan"),
         askc("The whakapapa chart scan or Scan 0221?", options="$chart_scan, $scan")]),
  T("oh no, not the whakapapa chart. leave them both", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T28-A005", "ask-options debt settle_debt c3a",
  T("settle the petrol one", ask("d_kevin", "d_pita", "d_sam"),
    ref=[act("settle_debt", kind="debt", name="petrol"),
         askc("Kevin's petrol to Taupō (he owes you 40), Pita's tangi petrol (you owe 80) or Sam's mower petrol (you owe 15)?", options="$d_kevin, $d_pita, $d_sam")]),
  T("pita's, i paid him at the marae", diff(upd("d_pita", status="settled")),
    ref=[act("settle_debt", rows="$d_pita")]))

S("T28-A006", "ask-options photo star never_mind c3a",
  T("star the aroha photo", ask("p_aroha", "p_bday"),
    ref=[act("star", kind="photo", name="aroha"),
         askc("Aroha in the garden or Aroha's cake from last year?", options="$p_aroha, $p_bday")]),
  T("actually don't bother, i'll sort the album later", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("and star kiri", diff(upd("kiri", starred=True)),
    ref=[act("star", kind="person", name="Kiri")]))

S("T28-A101", "ask-options person star c3a",
  T("star the ngata", ask("pita", "tui"),
    ref=[act("star", kind="person", name="Ngata"),
         askc("Pita Ngata the kaumātua or Tui Ngata, Pita's wife?", options="$pita, $tui")]))

S("T28-A007", "follow-up c3a",
  T("what's open on the marae list", rows("roof_quotes", "agenda", "koha_book", "mattresses"),
    ref=[ans(kind="task", linked_to="$marae_l", where="status = open")]),
  T("which of those are priority 1", rows("roof_quotes"),
    ref=[ans(within="@prev", where="priority = 1")]),
  T("and the rest", rows("koha_book", "mattresses", "agenda"),
    ref=[ans(within="@1", exclude="@2")]))

S("T28-A008", "follow-up c3a",
  T("show me next week", rows("hine_korero", "waka_0227", "aroha_bday", "wof", "kapa_0225", "cricket_0228", "gp_feb", "marae_0301", "touch_0223", "netball", "depot_lunch"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("just the ones before thursday", rows("touch_0223", "gp_feb", "hine_korero", "wof", "kapa_0225"),
    ref=[ans(within="@prev", when=J({"to": U("week", 1, weekday=3)}))]),
  T("what's after that", rows("cricket_0228", "marae_0301", "netball", "waka_0227", "aroha_bday", "depot_lunch"),
    ref=[ans(within="@1", exclude="@2")]))

S("T28-A009", "follow-up c3a",
  T("what's owed to me", rows("d_kiri", "d_rawiri", "d_moana", "d_mere", "d_kevin"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]),
  T("which of those are over 50", rows("d_kiri", "d_rawiri", "d_mere"),
    ref=[ans(within="@prev", where="amount > 50 NZD")]),
  T("and the biggest one", rows("d_rawiri"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T28-A010", "follow-up c3a",
  T("what's in the mokopuna album", rows("p_ro", "p_moko_all", "p_netball", "p_waka", "p_cricket", "p_touch"),
    ref=[ans(kind="photo", linked_to="$moko_al")]),
  T("which of those are starred", rows("p_cricket", "p_ro", "p_moko_all"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("unstar all of them", diff(upd("p_cricket", starred=False), upd("p_ro", starred=False), upd("p_moko_all", starred=False)),
    ref=[act("unstar", rows="@prev")]))

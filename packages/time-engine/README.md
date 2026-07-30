# `@centraid/time-engine`

Centraid's dependency-free recurrence and civil-time core. Agenda events, Tasks,
Tally templates, and automations use this package so DST gaps, overlaps, end
conditions, and recurrence previews have one meaning on every host.

The policy is deliberate: a civil time in a DST gap is skipped; an overlap
occurs once at the earlier instant. Floating and all-day values never acquire a
timezone implicitly.

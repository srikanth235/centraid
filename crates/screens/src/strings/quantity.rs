//! The words of a measured amount (#1185): the unit a figure is said in and the two ways a span of
//! time is said. `kit::quantity` is the only reader; an app never words a unit itself.

catalog! {
    plain unit_bpm = ("bpm", "bpm");
    plain unit_celsius = ("°C", "°C");
    plain unit_fahrenheit = ("°F", "°F");
    plain unit_fl_oz = ("fl oz", "fl oz");
    plain unit_ft = ("ft", "ft");
    plain unit_kcal = ("kcal", "kcal");
    plain unit_kg = ("kg", "kg");
    plain unit_km = ("km", "km");
    plain unit_l = ("L", "L");
    plain unit_lb = ("lb", "lb");
    plain unit_m = ("m", "m");
    plain unit_mi = ("mi", "mi");
    plain unit_min = ("min", "min");
    plain unit_ml = ("ml", "ml");
    plain unit_per_km = ("/km", "/km");
    plain unit_per_mi = ("/mi", "/mi");
    plain duration_hours = ("{h} h {m} min", "{h} h {m} min");
    plain duration_minutes = ("{m} min", "{m} min");
    plain span_hours = ("{h} h {m} min", "{h} h {m} min");
    plain span_minutes = ("{m} min", "{m} min");
}

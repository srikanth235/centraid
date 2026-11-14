//! The engine of the mix's selection: an objective over the shares and a swap search that lowers it.
//!
//! A selection is a set of units (a session, or the two sessions of a pair). Every label a turn or a session carries
//! (`outcome:ask`, `cell:find/task/read`, `turns:1` ...) belongs to one dimension, and a dimension is a set of labels that
//! share a total: the outcomes of the turns, the cells of the turns, the sessions by length. A dimension is aimed at a
//! share per label, and its error is the sum over its labels of the squared distance between the share the chosen units
//! hold and the share aimed at:
//!
//! `E_d = sum_l (c_l / N_d - s_l)^2 = A / N^2 - 2 B / N + S` with `A = sum c_l^2`, `B = sum c_l s_l`, `S = sum s_l^2`.
//!
//! The three sums are kept as units are added and taken away, so what a unit would change is read off the labels it
//! carries, never off the whole dimension. The objective is the weighted sum of the errors; a share is of the realised
//! total of its dimension, so the targets stay shares of what is chosen however long the chosen sessions are. The cells and
//! the (kind, field) pairs are balanced with a small weight: their floors are hard requirements and live outside the
//! objective, and the equal share above the floor gives way to the shares of the issue, which are what the model is
//! judged on.
//!
//! Hard requirements, which a swap never breaks: every floored label keeps at least `min(floor, what it holds)`, the
//! ceilings hold, and at least `multi_floor` sessions have two turns or more (as many as the input holds).

use std::collections::BTreeMap;

/// Dimensions of the objective, in the order [`crate::mix`] labels them.
pub const NDIMS: usize = 9;

/// The weight of the equal-share dimensions (cells, then the (kind, field) pairs): the floors guarantee what they must,
/// the equal share above a floor yields to the shares of the issue.
pub const BALANCE_WEIGHT: f64 = 0.05;

/// The units of a round that are tried as the one in and the one out of a swap.
const CANDIDATES: usize = 64;
/// Rounds of the swap search at most; it stops at the first that changes nothing.
const ROUNDS: usize = 800;
/// A swap must lower the objective by more than this.
const EPSILON: f64 = 1e-13;

/// The weight of the shortfall of sessions with two turns or more against their floor.
const MULTI_WEIGHT: f64 = 1000.0;

/// The weight of a floored label's shortfall (a share of its floor, squared). It dwarfs the share errors, so a floor is
/// filled before a share is bent, and units that fill several floors at once are taken first.
const FLOOR_WEIGHT: f64 = 1.0;

/// The penalty of a label that holds `c` turns against a floor of `need`.
fn short(need: u32, c: i64) -> f64 {
    if need == 0 {
        return 0.0;
    }
    let left = (i64::from(need) - c).max(0) as f64 / f64::from(need);
    FLOOR_WEIGHT * left * left
}

fn weight(dim: usize) -> f64 {
    if dim < 2 { BALANCE_WEIGHT } else { 1.0 }
}

/// What the objective is aimed at.
#[derive(Debug, Default)]
pub struct Space {
    /// The dimension of each label.
    pub dim: Vec<usize>,
    /// The share each label is aimed at within its dimension; `0` when it has none.
    pub share: Vec<f64>,
    /// Whether the label has a share (an untargeted label counts in its dimension's total and nowhere else).
    pub targeted: Vec<bool>,
    /// `sum s^2` of each dimension.
    pub s2: [f64; NDIMS],
    /// A dimension with no share at all is left out.
    pub active: [bool; NDIMS],
    /// The turns a label has at least (`0` for none).
    pub need: Vec<u32>,
    /// The sessions of two turns or more the selection has at least (`0` for none), and the sessions it is aimed at.
    pub multi_floor: f64,
    pub want: f64,
}

impl Space {
    #[must_use]
    pub fn new(
        dim: Vec<usize>,
        share: &[Option<f64>],
        need: Vec<u32>,
        multi_floor: usize,
        want: usize,
    ) -> Self {
        let mut s2 = [0.0; NDIMS];
        let mut active = [false; NDIMS];
        for (l, s) in share.iter().enumerate() {
            if let Some(s) = s {
                s2[dim[l]] += s * s;
                active[dim[l]] = true;
            }
        }
        Self {
            targeted: share.iter().map(Option::is_some).collect(),
            share: share.iter().map(|s| s.unwrap_or(0.0)).collect(),
            dim,
            s2,
            active,
            need,
            multi_floor: multi_floor as f64,
            want: want.max(1) as f64,
        }
    }
}

/// A unit as the labels it carries.
#[derive(Debug, Default, Clone)]
pub struct Vector {
    /// `(label, count)` sorted by label.
    pub labels: Vec<(u32, u32)>,
    /// `(dimension, count)`: how much the unit adds to each total.
    pub dims: Vec<(u8, u32)>,
    pub sessions: u32,
    /// Sessions of two turns or more.
    pub multi: u32,
    pub pronoun: u32,
    /// Turns that point at a row.
    pub refs: u32,
    pub undo: u32,
    pub turns: u32,
}

/// The ceilings: pronoun references of the turns that point at a row, undo turns of the turns.
#[derive(Debug, Clone, Copy)]
pub struct Ceilings {
    pub pronoun: f64,
    pub undo: f64,
}

fn energy(a: f64, b: f64, n: f64, s2: f64) -> f64 {
    if n <= 0.0 {
        s2
    } else {
        a / (n * n) - 2.0 * b / n + s2
    }
}

/// What a selection holds so far.
pub struct State<'s> {
    sp: &'s Space,
    pub c: Vec<u32>,
    n: [i64; NDIMS],
    a: [f64; NDIMS],
    b: [f64; NDIMS],
    /// The shortfall of the floored labels, summed.
    shortfalls: f64,
    pub sessions: usize,
    pub multi: usize,
    pub pronoun: usize,
    pub refs: usize,
    pub undo: usize,
    pub turns: usize,
}

impl<'s> State<'s> {
    #[must_use]
    pub fn new(sp: &'s Space) -> Self {
        Self {
            sp,
            c: vec![0; sp.dim.len()],
            n: [0; NDIMS],
            a: [0.0; NDIMS],
            b: [0.0; NDIMS],
            shortfalls: sp.need.iter().map(|n| short(*n, 0)).sum(),
            sessions: 0,
            multi: 0,
            pronoun: 0,
            refs: 0,
            undo: 0,
            turns: 0,
        }
    }

    /// The total of a dimension: the labelled turns (or sessions) chosen.
    #[must_use]
    pub fn total(&self, dim: usize) -> usize {
        usize::try_from(self.n[dim]).unwrap_or(0)
    }

    /// The objective.
    #[must_use]
    pub fn objective(&self) -> f64 {
        (0..NDIMS)
            .filter(|d| self.sp.active[*d])
            .map(|d| weight(d) * energy(self.a[d], self.b[d], self.n[d] as f64, self.sp.s2[d]))
            .sum::<f64>()
            + self.shortfall(self.multi)
            + self.shortfalls
    }

    /// The penalty for `multi` sessions of two turns or more against the floor.
    fn shortfall(&self, multi: usize) -> f64 {
        let short = (self.sp.multi_floor - multi as f64).max(0.0) / self.sp.want;
        MULTI_WEIGHT * short * short
    }

    /// What the objective would change by if `u` were added (`sign` 1) or taken away (`sign` -1).
    #[must_use]
    pub fn delta(&self, u: &Vector, sign: i64) -> f64 {
        let sf = sign as f64;
        let mut da = [0.0; NDIMS];
        let mut db = [0.0; NDIMS];
        for &(l, k) in &u.labels {
            let l = l as usize;
            if !self.sp.targeted[l] {
                continue;
            }
            let d = self.sp.dim[l];
            let (c, k) = (f64::from(self.c[l]), f64::from(k));
            da[d] += sf * 2.0 * c * k + k * k;
            db[d] += sf * k * self.sp.share[l];
        }
        let mut out = 0.0;
        for &(l, k) in &u.labels {
            let need = self.sp.need[l as usize];
            if need > 0 {
                let c = i64::from(self.c[l as usize]);
                out += short(need, c + sign * i64::from(k)) - short(need, c);
            }
        }
        for &(d, m) in &u.dims {
            let d = usize::from(d);
            if !self.sp.active[d] {
                continue;
            }
            let n0 = self.n[d] as f64;
            let n1 = n0 + sf * f64::from(m);
            out += weight(d)
                * (energy(self.a[d] + da[d], self.b[d] + db[d], n1, self.sp.s2[d])
                    - energy(self.a[d], self.b[d], n0, self.sp.s2[d]));
        }
        let multi = (self.multi as i64 + sign * i64::from(u.multi)).max(0) as usize;
        out + self.shortfall(multi) - self.shortfall(self.multi)
    }

    /// Add (`sign` 1) or take away (`sign` -1) `u`.
    pub fn apply(&mut self, u: &Vector, sign: i64) {
        let sf = sign as f64;
        for &(l, k) in &u.labels {
            let l = l as usize;
            let d = self.sp.dim[l];
            let kf = f64::from(k);
            let need = self.sp.need[l];
            if need > 0 {
                let c = i64::from(self.c[l]);
                self.shortfalls += short(need, c + sign * i64::from(k)) - short(need, c);
            }
            if self.sp.targeted[l] {
                self.a[d] += sf * 2.0 * f64::from(self.c[l]) * kf + kf * kf;
                self.b[d] += sf * kf * self.sp.share[l];
            }
            self.c[l] = if sign > 0 {
                self.c[l] + k
            } else {
                self.c[l] - k
            };
        }
        for &(d, m) in &u.dims {
            self.n[usize::from(d)] += sign * i64::from(m);
        }
        let step = |v: usize, by: u32| -> usize {
            if sign > 0 {
                v + by as usize
            } else {
                v - by as usize
            }
        };
        self.sessions = step(self.sessions, u.sessions);
        self.multi = step(self.multi, u.multi);
        self.pronoun = step(self.pronoun, u.pronoun);
        self.refs = step(self.refs, u.refs);
        self.undo = step(self.undo, u.undo);
        self.turns = step(self.turns, u.turns);
    }

    /// Would adding `u` leave the ceilings held? Checked on the counts after the unit, so the share at the end is under
    /// whatever the order the units were taken in.
    #[must_use]
    pub fn allows(&self, u: &Vector, caps: &Ceilings) -> bool {
        let ok_pronoun = u.pronoun == 0
            || (self.pronoun + u.pronoun as usize) as f64
                <= caps.pronoun * (self.refs + u.refs as usize) as f64 + 1e-9;
        let ok_undo = u.undo == 0
            || (self.undo + u.undo as usize) as f64
                <= caps.undo * (self.turns + u.turns as usize) as f64 + 1e-9;
        ok_pronoun && ok_undo
    }

    fn ceilings_held(&self, caps: &Ceilings) -> bool {
        self.pronoun as f64 <= caps.pronoun * self.refs as f64 + 1e-9
            && self.undo as f64 <= caps.undo * self.turns as f64 + 1e-9
    }

    /// Does taking `u` away alone leave every floored label at `min(need, what it holds)`?
    fn removable(&self, u: &Vector) -> bool {
        u.labels.iter().all(|&(l, k)| {
            let need = self.sp.need[l as usize];
            need == 0 || self.c[l as usize] - k >= need.min(self.c[l as usize])
        })
    }
}

/// The search: swap a chosen unit for an unchosen one of the same size while the objective falls.
///
/// A swap is kept only if every floored label stays at `min(floor, what it held)`, the ceilings hold and the sessions with
/// two turns or more stay at `min(multi_floor, what they were)`. Pure: the same input gives the same selection.
pub fn polish(
    state: &mut State<'_>,
    vectors: &[Vector],
    ties: &[u64],
    taken: &mut [bool],
    caps: &Ceilings,
    multi_floor: usize,
) {
    let per_member = |v: &Vector, d: f64| d / f64::from(v.sessions.max(1));
    for _ in 0..ROUNDS {
        let mut accepted = 0_usize;
        for size in [1_u32, 2] {
            let mut adds: Vec<(f64, u64, usize)> = Vec::new();
            let mut removes: Vec<(f64, u64, usize)> = Vec::new();
            for (i, v) in vectors.iter().enumerate() {
                if v.sessions != size {
                    continue;
                }
                if taken[i] {
                    if state.removable(v) {
                        removes.push((per_member(v, state.delta(v, -1)), ties[i], i));
                    }
                } else if state.allows(v, caps) {
                    adds.push((per_member(v, state.delta(v, 1)), ties[i], i));
                }
            }
            let order = |x: &(f64, u64, usize), y: &(f64, u64, usize)| {
                x.0.total_cmp(&y.0).then(x.1.cmp(&y.1)).then(x.2.cmp(&y.2))
            };
            for list in [&mut adds, &mut removes] {
                if list.len() > CANDIDATES {
                    list.select_nth_unstable_by(CANDIDATES, order);
                    list.truncate(CANDIDATES);
                }
                list.sort_unstable_by(order);
            }
            let mut gone = vec![false; removes.len()];
            for (_, _, i) in &adds {
                let before = state.objective();
                for (k, (_, _, r)) in removes.iter().enumerate() {
                    if gone[k] || taken[*i] {
                        continue;
                    }
                    let held_multi = state.multi;
                    let held: Vec<u32> = vectors[*r]
                        .labels
                        .iter()
                        .map(|(l, _)| state.c[*l as usize])
                        .collect();
                    state.apply(&vectors[*r], -1);
                    state.apply(&vectors[*i], 1);
                    let floors = vectors[*r]
                        .labels
                        .iter()
                        .zip(&held)
                        .all(|(&(l, _), before)| {
                            let need = state.sp.need[l as usize];
                            need == 0 || state.c[l as usize] >= need.min(*before)
                        });
                    let keep = floors
                        && state.ceilings_held(caps)
                        && state.multi >= multi_floor.min(held_multi)
                        && state.objective() < before - EPSILON;
                    if keep {
                        taken[*r] = false;
                        taken[*i] = true;
                        gone[k] = true;
                        accepted += 1;
                        break;
                    }
                    state.apply(&vectors[*i], -1);
                    state.apply(&vectors[*r], 1);
                }
            }
        }
        if accepted == 0 {
            break;
        }
    }
}

/// Labels by name for the report: the counts of a state as the maps the report reads.
#[must_use]
pub fn counts_by_name(names: &[String], state: &State<'_>) -> BTreeMap<String, usize> {
    names
        .iter()
        .zip(&state.c)
        .filter(|(_, c)| **c > 0)
        .map(|(n, c)| (n.clone(), *c as usize))
        .collect()
}

//! TEMPERATURE AND TOP-P SAMPLING, for rollouts (#1171, M7). The phone decodes greedily and never calls this: a
//! generation with `temperature == 0.0` takes the engine's greedy path unchanged. A rollout asks for `temperature > 0`
//! and the engine picks with [`pick`] from the tokens the grammar (if any) allows.
//!
//! Pure and engine-free so it is built, linted and tested without llama.cpp.

/// A small seeded generator (splitmix64): the same seed gives the same decodes, which is what makes a rollout
/// reproducible. Not for anything that needs to be unpredictable.
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    #[must_use]
    pub const fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `[0, 1)`.
    pub fn unit(&mut self) -> f64 {
        // 53 random bits: the mantissa of an f64
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// How many of the best tokens the nucleus is cut from. The mass beyond 256 tokens of a model this size is noise, and
/// sorting a 248K vocabulary at every token is not free.
pub const POOL: usize = 256;

/// Pick one of `candidates` (`(id, logit)`, disallowed tokens already left out): softmax at `temperature`, keep the
/// smallest set of best tokens whose probability reaches `top_p` (`>= 1.0` keeps all of the pool), draw one.
/// Returns the id, or `None` when there is no candidate. `temperature <= 0` is the greedy pick (the first of equals).
pub fn pick(
    candidates: &[(usize, f32)],
    temperature: f32,
    top_p: f32,
    rng: &mut Rng,
) -> Option<usize> {
    if candidates.is_empty() {
        return None;
    }
    let mut pool: Vec<(usize, f32)> = candidates.to_vec();
    let by_logit = |a: &(usize, f32), b: &(usize, f32)| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0));
    if pool.len() > POOL {
        pool.select_nth_unstable_by(POOL - 1, by_logit);
        pool.truncate(POOL);
    }
    pool.sort_unstable_by(by_logit);
    if temperature <= 0.0 {
        return pool.first().map(|c| c.0);
    }
    let best = pool[0].1;
    let mut weights: Vec<f64> = pool
        .iter()
        .map(|c| f64::from((c.1 - best) / temperature).exp())
        .collect();
    let total: f64 = weights.iter().sum();
    weights.iter_mut().for_each(|w| *w /= total);
    let mut keep = pool.len();
    if top_p < 1.0 {
        let mut mass = 0.0;
        for (i, w) in weights.iter().enumerate() {
            mass += w;
            if mass >= f64::from(top_p) {
                keep = i + 1;
                break;
            }
        }
    }
    let kept: f64 = weights[..keep].iter().sum();
    let mut draw = rng.unit() * kept;
    for (c, w) in pool[..keep].iter().zip(&weights) {
        if draw < *w {
            return Some(c.0);
        }
        draw -= w;
    }
    Some(pool[keep - 1].0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens() -> Vec<(usize, f32)> {
        vec![(7, 1.0), (3, 5.0), (9, 4.9), (1, -2.0)]
    }

    #[test]
    fn zero_temperature_is_the_best_token() {
        assert_eq!(pick(&tokens(), 0.0, 1.0, &mut Rng::new(1)), Some(3));
        assert_eq!(pick(&[], 0.0, 1.0, &mut Rng::new(1)), None);
    }

    #[test]
    fn a_seed_repeats_and_seeds_differ() {
        let run = |seed| {
            let mut rng = Rng::new(seed);
            (0..64)
                .map(|_| pick(&tokens(), 1.0, 1.0, &mut rng).unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(run(5), run(5));
        assert_ne!(run(5), run(6));
    }

    #[test]
    fn top_p_cuts_the_tail() {
        // 3 and 9 hold nearly all the mass; a nucleus of 0.9 never reaches 7 or 1
        let mut rng = Rng::new(11);
        for _ in 0..500 {
            let id = pick(&tokens(), 1.0, 0.9, &mut rng).unwrap();
            assert!(id == 3 || id == 9, "{id}");
        }
    }

    #[test]
    fn a_low_temperature_is_nearly_greedy_and_a_high_one_spreads() {
        let count = |temperature| {
            let mut rng = Rng::new(2);
            (0..400)
                .filter(|_| pick(&tokens(), temperature, 1.0, &mut rng) == Some(3))
                .count()
        };
        assert_eq!(count(0.01), 400);
        assert!(count(3.0) < 300);
    }

    #[test]
    fn a_long_list_is_cut_to_the_pool() {
        let many: Vec<(usize, f32)> = (0..2000).map(|i| (i, -(i as f32))).collect();
        let mut rng = Rng::new(3);
        for _ in 0..50 {
            assert!(pick(&many, 2.0, 1.0, &mut rng).unwrap() < POOL);
        }
    }
}

//! The generator's only source of randomness: SplitMix64 from a seed, so a world is a pure
//! function of its seed on every platform and no dependency decides the stream.

/// A seeded stream. `fork` derives an independent stream from a label, so adding a draw to one
/// section of a world never shifts the draws of another.
#[derive(Debug, Clone)]
pub struct Rng(u64);

fn mix(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Rng {
    #[must_use]
    pub fn new(seed: u64) -> Self {
        Self(mix(seed ^ 0x9E37_79B9_7F4A_7C15))
    }

    /// An independent stream named by `label`.
    #[must_use]
    pub fn fork(&self, label: &str) -> Self {
        let hash = blake3::hash(label.as_bytes());
        let mut bytes = [0_u8; 8];
        bytes.copy_from_slice(&hash.as_bytes()[..8]);
        Self::new(self.0 ^ u64::from_le_bytes(bytes))
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        mix(self.0)
    }

    /// Uniform in `0..n`; `0` when `n` is `0`.
    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            return 0;
        }
        (self.next_u64() % n as u64) as usize
    }

    /// Uniform in `low..=high`.
    pub fn range(&mut self, low: i64, high: i64) -> i64 {
        if high <= low {
            return low;
        }
        low + (self.next_u64() % (high - low + 1) as u64) as i64
    }

    /// A float in `[0, 1)`.
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1_u64 << 53) as f64
    }

    /// True with probability `p`.
    pub fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }

    /// One of `items`; panics only on an empty slice, which no pool is.
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }

    /// One of `items` by weight.
    pub fn weighted<'a, T>(&mut self, items: &'a [(T, u32)]) -> &'a T {
        let total: u32 = items.iter().map(|(_, weight)| *weight).sum();
        let mut roll = self.below(total.max(1) as usize) as u32;
        for (item, weight) in items {
            if roll < *weight {
                return item;
            }
            roll -= *weight;
        }
        &items[items.len() - 1].0
    }

    /// `count` distinct indices of `0..len`, in draw order.
    pub fn sample(&mut self, len: usize, count: usize) -> Vec<usize> {
        let mut pool: Vec<usize> = (0..len).collect();
        let mut out = Vec::new();
        for _ in 0..count.min(len) {
            out.push(pool.swap_remove(self.below(pool.len())));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_seed_is_a_stream_and_a_fork_is_another() {
        let mut a = Rng::new(7);
        let mut b = Rng::new(7);
        assert_eq!(a.next_u64(), b.next_u64());
        assert_ne!(
            Rng::new(7).fork("x").next_u64(),
            Rng::new(7).fork("y").next_u64()
        );
    }

    #[test]
    fn ranges_stay_inside_their_bounds() {
        let mut rng = Rng::new(1);
        for _ in 0..1000 {
            assert!((3..=9).contains(&rng.range(3, 9)));
            assert!(rng.below(5) < 5);
        }
    }
}

use std::collections::HashSet;
use std::hash::{BuildHasherDefault, Hasher};

/// Small, non-cryptographic hasher for engine-internal tables.
///
/// Hive keys are trusted, tiny integer structs (Hex/Piece tuples). Rust's
/// default HashMap hasher is intentionally DoS-resistant, which is useful for
/// untrusted network input but expensive in a search engine that performs
/// millions of lookups per second. This hasher trades collision resistance for
/// throughput. It must never be used for security-sensitive/untrusted tables.
#[derive(Default)]
pub struct FastHasher {
    state: u64,
}

impl FastHasher {
    #[inline(always)]
    fn mix(&mut self, value: u64) {
        let x = value.wrapping_add(0x9E37_79B9_7F4A_7C15);
        self.state ^= x;
        self.state = self
            .state
            .rotate_left(27)
            .wrapping_mul(0x3C79_AC49_2BA7_B653)
            .wrapping_add(0x1C69_B3F7_4AC4_AE35);
    }
}

impl Hasher for FastHasher {
    #[inline(always)]
    fn finish(&self) -> u64 {
        self.state
    }

    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        let mut chunks = bytes.chunks_exact(8);
        for chunk in &mut chunks {
            self.mix(u64::from_le_bytes(chunk.try_into().expect("8-byte chunk")));
        }
        let rem = chunks.remainder();
        if !rem.is_empty() {
            let mut tail = [0_u8; 8];
            tail[..rem.len()].copy_from_slice(rem);
            self.mix(u64::from_le_bytes(tail) ^ ((rem.len() as u64) << 56));
        }
    }

    #[inline(always)]
    fn write_u8(&mut self, i: u8) { self.mix(i as u64); }
    #[inline(always)]
    fn write_u16(&mut self, i: u16) { self.mix(i as u64); }
    #[inline(always)]
    fn write_u32(&mut self, i: u32) { self.mix(i as u64); }
    #[inline(always)]
    fn write_u64(&mut self, i: u64) { self.mix(i); }
    #[inline(always)]
    fn write_usize(&mut self, i: usize) { self.mix(i as u64); }
    #[inline(always)]
    fn write_i8(&mut self, i: i8) { self.mix(i as u8 as u64); }
    #[inline(always)]
    fn write_i16(&mut self, i: i16) { self.mix(i as u16 as u64); }
    #[inline(always)]
    fn write_i32(&mut self, i: i32) { self.mix(i as u32 as u64); }
    #[inline(always)]
    fn write_i64(&mut self, i: i64) { self.mix(i as u64); }
    #[inline(always)]
    fn write_isize(&mut self, i: isize) { self.mix(i as usize as u64); }
}

pub type FastBuildHasher = BuildHasherDefault<FastHasher>;
pub type FastHashSet<K> = HashSet<K, FastBuildHasher>;

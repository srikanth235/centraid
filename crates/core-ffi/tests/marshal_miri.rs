//! The unsafe surface, under miri.
//!
//! `cargo miri test -p centraid-core-ffi --test marshal_miri`.
//!
//! Miri cannot run this crate's other tests: they open a vault, SQLite is a C
//! library, and miri does not execute foreign code. So the unsafe surface is
//! **confined** to `src/marshal.rs`'s four pointer functions — that confinement
//! exists for this test, and this test is what makes it worth having.
//!
//! What miri checks here:
//!
//! - [`slice_of`] reconstructs a slice from a pointer and a length without
//!   reading out of bounds, and refuses a null pointer with a non-zero length
//!   *before* dereferencing it.
//! - [`hand_over`] writes both out-pointers and transfers ownership with
//!   `capacity == len`, which is the precondition [`reclaim`] relies on.
//! - [`reclaim`] is `hand_over`'s exact inverse: no leak, no double free, no
//!   capacity mismatch. A `Vec` rebuilt with a capacity the allocator did not
//!   give it is undefined behaviour that happens to work, and miri is the only
//!   thing that says so.
//! - The empty-buffer corner: `hand_over` of an empty `Vec` must not hand back
//!   a dangling non-null pointer.

use centraid_core_ffi::marshal;

#[test]
fn a_slice_is_reconstructed_without_reading_past_its_length() {
    let bytes = vec![1_u8, 2, 3, 4, 5];
    // SAFETY: `bytes` is live for the whole borrow and holds exactly 5 bytes.
    let borrowed = unsafe { marshal::slice_of(bytes.as_ptr(), bytes.len()) }.expect("non-null");
    assert_eq!(borrowed, &[1, 2, 3, 4, 5]);
    // A SHORTER length reads a prefix and nothing more.
    // SAFETY: 3 <= 5.
    let prefix = unsafe { marshal::slice_of(bytes.as_ptr(), 3) }.expect("non-null");
    assert_eq!(prefix, &[1, 2, 3]);
    drop(bytes);
}

#[test]
fn a_null_pointer_with_a_nonzero_length_is_refused_before_any_dereference() {
    // SAFETY: the function refuses null before dereferencing, which is the
    // property under test; miri would report the dereference otherwise.
    assert!(unsafe { marshal::slice_of(std::ptr::null(), 8) }.is_none());
}

#[test]
fn a_null_pointer_with_length_zero_is_the_empty_slice() {
    // SAFETY: length zero never dereferences.
    let empty = unsafe { marshal::slice_of(std::ptr::null(), 0) }.expect("the empty slice");
    assert!(empty.is_empty());
}

#[test]
fn hand_over_and_reclaim_are_exact_inverses() {
    for size in [1_usize, 2, 7, 64, 1_000] {
        let bytes: Vec<u8> = (0..size).map(|index| (index % 251) as u8).collect();
        let expected = bytes.clone();
        let mut buf: *mut u8 = std::ptr::null_mut();
        let mut len: usize = 0;
        // SAFETY: both out-pointers are live locals.
        unsafe { marshal::hand_over(bytes, &raw mut buf, &raw mut len) };
        assert!(!buf.is_null());
        assert_eq!(len, size);
        // SAFETY: `buf`/`len` are what `hand_over` reported, so the bytes are
        // initialised and the region is exactly `len` long.
        let read = unsafe { std::slice::from_raw_parts(buf, len) };
        assert_eq!(read, expected.as_slice());
        // SAFETY: the exact pair `hand_over` produced, reclaimed once. Miri
        // reports a capacity mismatch here if `hand_over` did not shrink.
        unsafe { marshal::reclaim(buf, len) };
    }
}

/// An empty answer must not hand back a dangling non-null pointer.
#[test]
fn an_empty_buffer_is_still_a_real_allocation() {
    let mut buf: *mut u8 = std::ptr::null_mut();
    let mut len: usize = 0;
    // SAFETY: live out-pointers.
    unsafe { marshal::hand_over(Vec::new(), &raw mut buf, &raw mut len) };
    assert!(
        !buf.is_null(),
        "an empty buffer still gets a pointer, so a caller need not special-case it"
    );
    assert_eq!(len, 0);
    // SAFETY: the pair `hand_over` produced. This is the corner the `reserve_exact(1)`
    // in `hand_over` exists for — without it, reclaiming a zero-capacity
    // allocation is undefined.
    unsafe { marshal::reclaim(buf, len) };
}

#[test]
fn a_null_handle_is_refused_before_any_dereference() {
    // SAFETY: null is refused before the reference is formed.
    assert!(unsafe { marshal::handle_of(std::ptr::null_mut()) }.is_none());
}

/// Many round trips, so a leak shows as a leak rather than as noise.
///
/// Miri's leak check runs at the end of the test binary, so a `hand_over`
/// without its `reclaim` fails here even though nothing in the loop asserts it.
#[test]
fn a_thousand_round_trips_leak_nothing() {
    for index in 0..1_000_usize {
        let bytes = vec![(index % 256) as u8; (index % 32) + 1];
        let mut buf: *mut u8 = std::ptr::null_mut();
        let mut len: usize = 0;
        // SAFETY: live out-pointers.
        unsafe { marshal::hand_over(bytes, &raw mut buf, &raw mut len) };
        // SAFETY: the pair just produced, reclaimed exactly once.
        unsafe { marshal::reclaim(buf, len) };
    }
}

//! A STREAMING STORED ZIP WRITER (#1185, owner decision D17: a large export is a file written
//! as it is read, never built in memory).
//!
//! [`ZipWriter`] writes an archive to any `Write + Seek` sink (a file, or a `Cursor` for a small
//! archive) one entry at a time. Each entry is copied from a [`Read`] in [`CHUNK`]-byte pieces
//! through ONE buffer the writer owns for its lifetime, so memory is bounded by construction: the
//! size of an entry never changes what the writer holds. The only things that grow are the
//! central directory's records (about 60 bytes an entry), which the archive needs at its end.
//!
//! - **Stored, not compressed.** Every reader opens it, and documents are usually compressed
//!   already.
//! - **The CRC is known only after the bytes went through**, so the entry's local header is
//!   written with a zero CRC and patched by seeking back (the sink is `Seek`). The size is
//!   declared up front, which lets a header say whether the entry needs ZIP64 and lets the
//!   writer refuse a reader that gives more or fewer bytes than it promised.
//! - **ZIP64** is used for an entry of 4 GiB or more, an entry that starts at or after 4 GiB, a
//!   central directory that does, and an archive of 65 535 entries or more. Smaller archives are
//!   plain ZIP, byte for byte what Notes' export has always written.
//! - **Names are UTF-8** (general purpose flag bit 11) with `/` as the separator.
//!
//! [`stored_entries`] reads back an archive this writer made (tests, and a future import).

use std::io::{self, Read, Seek, SeekFrom, Write};

/// The most the writer asks a [`Read`] for at once, and the size of its one buffer.
pub const CHUNK: usize = 64 * 1024;

/// An entry or offset at or past this needs ZIP64.
const ZIP64_AT: u64 = 0xFFFF_FFFF;
/// Entries at or past this need the ZIP64 end record.
const ENTRIES_AT: u64 = 0xFFFF;

const LOCAL: u32 = 0x0403_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const END: u32 = 0x0605_4b50;
const END64: u32 = 0x0606_4b50;
const LOCATOR64: u32 = 0x0706_4b50;
/// General purpose flags: bit 11, names are UTF-8.
const UTF8: u16 = 0x0800;
/// 1980-01-01, the zip epoch: an export carries no timestamps of its own.
const DATE: u16 = 0x0021;

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

/// A stored archive being written entry by entry. See the module header.
pub struct ZipWriter<W: Write + Seek> {
    out: W,
    /// Where the next byte goes: the sink's length so far.
    pos: u64,
    /// The central directory's records, kept until [`Self::finish`].
    central: Vec<u8>,
    entries: u64,
    /// The one copy buffer, [`CHUNK`] long, allocated once.
    buffer: Box<[u8]>,
    zip64_at: u64,
}

impl<W: Write + Seek> ZipWriter<W> {
    /// A writer at the start of `out`.
    pub fn new(out: W) -> Self {
        Self {
            out,
            pos: 0,
            central: Vec::new(),
            entries: 0,
            buffer: vec![0_u8; CHUNK].into_boxed_slice(),
            zip64_at: ZIP64_AT,
        }
    }

    /// The same with the ZIP64 threshold lowered, so a test reaches the 64-bit records without
    /// writing four gibibytes.
    #[cfg(test)]
    fn with_zip64_at(out: W, zip64_at: u64) -> Self {
        Self {
            zip64_at,
            ..Self::new(out)
        }
    }

    /// How many entries have been written.
    #[must_use]
    pub const fn entries(&self) -> u64 {
        self.entries
    }

    /// Add one entry named `name`, whose `size` bytes come from `data`.
    ///
    /// # Errors
    /// The sink's or the reader's error; a name longer than 65 535 bytes; a reader that gives
    /// more or fewer than `size` bytes (the entry is then not valid and the archive must be
    /// abandoned).
    pub fn add<R: Read>(&mut self, name: &str, size: u64, mut data: R) -> io::Result<()> {
        let name_bytes = name.as_bytes();
        let name_len = u16::try_from(name_bytes.len()).map_err(|_| invalid("name too long"))?;
        let offset = self.pos;
        let big = size >= self.zip64_at;
        let extra: u16 = if big { 20 } else { 0 };
        let mut head = Vec::with_capacity(30 + name_bytes.len() + usize::from(extra));
        head.extend_from_slice(&LOCAL.to_le_bytes());
        head.extend_from_slice(&(if big { 45_u16 } else { 20 }).to_le_bytes());
        head.extend_from_slice(&UTF8.to_le_bytes());
        head.extend_from_slice(&0_u16.to_le_bytes()); // stored
        head.extend_from_slice(&0_u16.to_le_bytes()); // time
        head.extend_from_slice(&DATE.to_le_bytes());
        head.extend_from_slice(&0_u32.to_le_bytes()); // crc, patched below
        let small = if big { 0xFFFF_FFFF } else { size as u32 };
        head.extend_from_slice(&small.to_le_bytes());
        head.extend_from_slice(&small.to_le_bytes());
        head.extend_from_slice(&name_len.to_le_bytes());
        head.extend_from_slice(&extra.to_le_bytes());
        head.extend_from_slice(name_bytes);
        if big {
            head.extend_from_slice(&1_u16.to_le_bytes());
            head.extend_from_slice(&16_u16.to_le_bytes());
            head.extend_from_slice(&size.to_le_bytes());
            head.extend_from_slice(&size.to_le_bytes());
        }
        self.out.write_all(&head)?;
        self.pos += head.len() as u64;

        let mut crc = flate2::Crc::new();
        let mut copied: u64 = 0;
        loop {
            let read = match data.read(&mut self.buffer) {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            };
            copied += read as u64;
            if copied > size {
                return Err(invalid("an entry grew while it was being written"));
            }
            crc.update(&self.buffer[..read]);
            self.out.write_all(&self.buffer[..read])?;
        }
        if copied != size {
            return Err(invalid("an entry shrank while it was being written"));
        }
        self.pos += size;
        let crc = crc.sum();
        self.out.seek(SeekFrom::Start(offset + 14))?;
        self.out.write_all(&crc.to_le_bytes())?;
        self.out.seek(SeekFrom::Start(self.pos))?;

        self.record(name_bytes, crc, size, offset);
        Ok(())
    }

    /// The central directory's record of an entry that was written.
    fn record(&mut self, name: &[u8], crc: u32, size: u64, offset: u64) {
        let (big_size, big_offset) = (size >= self.zip64_at, offset >= self.zip64_at);
        let mut extra: Vec<u8> = Vec::new();
        if big_size {
            extra.extend_from_slice(&size.to_le_bytes());
            extra.extend_from_slice(&size.to_le_bytes());
        }
        if big_offset {
            extra.extend_from_slice(&offset.to_le_bytes());
        }
        let zip64 = !extra.is_empty();
        let central = &mut self.central;
        central.extend_from_slice(&CENTRAL.to_le_bytes());
        let version: u16 = if zip64 { 45 } else { 20 };
        central.extend_from_slice(&version.to_le_bytes()); // made by
        central.extend_from_slice(&version.to_le_bytes()); // needed
        central.extend_from_slice(&UTF8.to_le_bytes());
        central.extend_from_slice(&0_u16.to_le_bytes()); // stored
        central.extend_from_slice(&0_u16.to_le_bytes()); // time
        central.extend_from_slice(&DATE.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        let sized = if big_size { 0xFFFF_FFFF } else { size as u32 };
        central.extend_from_slice(&sized.to_le_bytes());
        central.extend_from_slice(&sized.to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        let extra_len = if zip64 { extra.len() as u16 + 4 } else { 0 };
        central.extend_from_slice(&extra_len.to_le_bytes());
        // comment length, disk, internal and external attributes.
        central.extend_from_slice(&[0; 10]);
        let placed = if big_offset {
            0xFFFF_FFFF
        } else {
            offset as u32
        };
        central.extend_from_slice(&placed.to_le_bytes());
        central.extend_from_slice(name);
        if zip64 {
            central.extend_from_slice(&1_u16.to_le_bytes());
            central.extend_from_slice(&(extra.len() as u16).to_le_bytes());
            central.extend_from_slice(&extra);
        }
        self.entries += 1;
    }

    /// Write the central directory and the end records, and give the sink back.
    ///
    /// # Errors
    /// The sink's error.
    pub fn finish(mut self) -> io::Result<W> {
        let start = self.pos;
        let size = self.central.len() as u64;
        self.out.write_all(&self.central)?;
        self.pos += size;
        let zip64 = self.entries >= ENTRIES_AT || start >= self.zip64_at || size >= self.zip64_at;
        let mut end: Vec<u8> = Vec::new();
        if zip64 {
            end.extend_from_slice(&END64.to_le_bytes());
            end.extend_from_slice(&44_u64.to_le_bytes());
            end.extend_from_slice(&45_u16.to_le_bytes());
            end.extend_from_slice(&45_u16.to_le_bytes());
            end.extend_from_slice(&0_u32.to_le_bytes());
            end.extend_from_slice(&0_u32.to_le_bytes());
            end.extend_from_slice(&self.entries.to_le_bytes());
            end.extend_from_slice(&self.entries.to_le_bytes());
            end.extend_from_slice(&size.to_le_bytes());
            end.extend_from_slice(&start.to_le_bytes());
            end.extend_from_slice(&LOCATOR64.to_le_bytes());
            end.extend_from_slice(&0_u32.to_le_bytes());
            end.extend_from_slice(&self.pos.to_le_bytes());
            end.extend_from_slice(&1_u32.to_le_bytes());
        }
        end.extend_from_slice(&END.to_le_bytes());
        end.extend_from_slice(&[0, 0, 0, 0]);
        let count = if zip64 { 0xFFFF } else { self.entries as u16 };
        end.extend_from_slice(&count.to_le_bytes());
        end.extend_from_slice(&count.to_le_bytes());
        let (sized, placed) = if zip64 {
            (0xFFFF_FFFF, 0xFFFF_FFFF)
        } else {
            (size as u32, start as u32)
        };
        end.extend_from_slice(&sized.to_le_bytes());
        end.extend_from_slice(&placed.to_le_bytes());
        end.extend_from_slice(&0_u16.to_le_bytes());
        self.out.write_all(&end)?;
        self.out.flush()?;
        Ok(self.out)
    }
}

fn u16_at(bytes: &[u8], at: usize) -> io::Result<u16> {
    bytes
        .get(at..at + 2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .ok_or_else(|| invalid("archive cut short"))
}

fn u32_at(bytes: &[u8], at: usize) -> io::Result<u32> {
    bytes
        .get(at..at + 4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .ok_or_else(|| invalid("archive cut short"))
}

fn u64_at(bytes: &[u8], at: usize) -> io::Result<u64> {
    bytes
        .get(at..at + 8)
        .map(|b| u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
        .ok_or_else(|| invalid("archive cut short"))
}

/// Every entry of a STORED archive (this writer's, or any stored zip with no archive comment) as
/// `(name, bytes)`, found through the central directory and checked against its CRC. It holds
/// the whole archive, so it is for tests and small imports, not for a large export.
///
/// # Errors
/// `InvalidData` for anything that is not a well-formed stored archive.
pub fn stored_entries(bytes: &[u8]) -> io::Result<Vec<(String, Vec<u8>)>> {
    let end = bytes
        .len()
        .checked_sub(22)
        .filter(|end| u32_at(bytes, *end).is_ok_and(|sig| sig == END))
        .ok_or_else(|| invalid("no end record"))?;
    let mut count = u64::from(u16_at(bytes, end + 10)?);
    let mut at = u64::from(u32_at(bytes, end + 16)?);
    if count == 0xFFFF || at == 0xFFFF_FFFF {
        let locator = end.checked_sub(20).ok_or_else(|| invalid("no locator"))?;
        if u32_at(bytes, locator)? != LOCATOR64 {
            return Err(invalid("no ZIP64 locator"));
        }
        let record = usize::try_from(u64_at(bytes, locator + 8)?).map_err(|_| invalid("offset"))?;
        if u32_at(bytes, record)? != END64 {
            return Err(invalid("no ZIP64 end record"));
        }
        count = u64_at(bytes, record + 32)?;
        at = u64_at(bytes, record + 48)?;
    }
    let mut at = usize::try_from(at).map_err(|_| invalid("offset"))?;
    let mut out = Vec::new();
    for _ in 0..count {
        if u32_at(bytes, at)? != CENTRAL {
            return Err(invalid("bad central record"));
        }
        if u16_at(bytes, at + 10)? != 0 {
            return Err(invalid("not stored"));
        }
        let crc = u32_at(bytes, at + 16)?;
        let mut size = u64::from(u32_at(bytes, at + 24)?);
        let name_len = usize::from(u16_at(bytes, at + 28)?);
        let extra_len = usize::from(u16_at(bytes, at + 30)?);
        let mut local = u64::from(u32_at(bytes, at + 42)?);
        let name = bytes
            .get(at + 46..at + 46 + name_len)
            .ok_or_else(|| invalid("archive cut short"))?;
        let name = String::from_utf8(name.to_vec()).map_err(|_| invalid("name is not UTF-8"))?;
        if size == 0xFFFF_FFFF || local == 0xFFFF_FFFF {
            let mut field = at + 46 + name_len;
            let stop = field + extra_len;
            while field + 4 <= stop {
                let (id, len) = (
                    u16_at(bytes, field)?,
                    usize::from(u16_at(bytes, field + 2)?),
                );
                if id == 1 {
                    let mut next = field + 4;
                    if size == 0xFFFF_FFFF {
                        size = u64_at(bytes, next)?;
                        next += 16;
                    }
                    if local == 0xFFFF_FFFF {
                        local = u64_at(bytes, next)?;
                    }
                }
                field += 4 + len;
            }
        }
        let local = usize::try_from(local).map_err(|_| invalid("offset"))?;
        if u32_at(bytes, local)? != LOCAL {
            return Err(invalid("bad local header"));
        }
        let data = local
            + 30
            + usize::from(u16_at(bytes, local + 26)?)
            + usize::from(u16_at(bytes, local + 28)?);
        let size = usize::try_from(size).map_err(|_| invalid("size"))?;
        let body = bytes
            .get(data..data + size)
            .ok_or_else(|| invalid("archive cut short"))?;
        let mut check = flate2::Crc::new();
        check.update(body);
        if check.sum() != crc {
            return Err(invalid("crc mismatch"));
        }
        out.push((name, body.to_vec()));
        at += 46 + name_len + extra_len;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            zip.add(name, bytes.len() as u64, *bytes).expect("added");
        }
        zip.finish().expect("finished").into_inner()
    }

    #[test]
    fn entries_round_trip_through_the_central_directory() {
        let bytes = archive(&[("A.md", b"hello"), ("Trip/B.md", b"[[A]]"), ("empty", b"")]);
        let read = stored_entries(&bytes).expect("read");
        assert_eq!(
            read,
            vec![
                ("A.md".to_owned(), b"hello".to_vec()),
                ("Trip/B.md".to_owned(), b"[[A]]".to_vec()),
                ("empty".to_owned(), Vec::new()),
            ]
        );
    }

    #[test]
    fn an_empty_archive_is_just_the_end_record() {
        let bytes = archive(&[]);
        assert_eq!(bytes.len(), 22);
        assert_eq!(&bytes[..4], b"PK\x05\x06");
        assert!(stored_entries(&bytes).expect("read").is_empty());
    }

    #[test]
    fn a_name_that_is_not_ascii_is_flagged_utf8_and_read_back() {
        let bytes = archive(&[("Café/日本語 ✓.txt", b"x")]);
        // The general purpose flag, bit 11, in both the local and the central header.
        assert_eq!(u16_at(&bytes, 6).unwrap() & UTF8, UTF8);
        let end = bytes.len() - 22;
        let central = u32_at(&bytes, end + 16).unwrap() as usize;
        assert_eq!(u16_at(&bytes, central + 8).unwrap() & UTF8, UTF8);
        assert_eq!(stored_entries(&bytes).unwrap()[0].0, "Café/日本語 ✓.txt");
    }

    /// A reader that records the largest buffer it was ever asked to fill.
    struct Counting<R> {
        inner: R,
        widest: usize,
    }

    impl<R: Read> Read for Counting<R> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.widest = self.widest.max(buf.len());
            self.inner.read(buf)
        }
    }

    /// A sink that keeps nothing but how far it was written, and the sizes of its writes.
    struct Discard {
        at: u64,
        len: u64,
        widest_write: usize,
    }

    impl Write for Discard {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.widest_write = self.widest_write.max(buf.len());
            self.at += buf.len() as u64;
            self.len = self.len.max(self.at);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Seek for Discard {
        fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
            if let SeekFrom::Start(at) = to {
                self.at = at;
            }
            Ok(self.at)
        }
    }

    #[test]
    fn memory_is_bounded_by_the_chunk_not_by_the_entry() {
        // The structure: ONE buffer of CHUNK bytes, the only thing an entry is read into, and the
        // only thing written from. An entry far larger than it never asks for more.
        let size = (CHUNK as u64) * 40 + 123;
        let mut zip = ZipWriter::new(Discard {
            at: 0,
            len: 0,
            widest_write: 0,
        });
        assert_eq!(zip.buffer.len(), CHUNK);
        let mut data = Counting {
            inner: io::repeat(7).take(size),
            widest: 0,
        };
        zip.add("big.bin", size, &mut data).expect("added");
        assert!(data.widest <= CHUNK, "asked for {}", data.widest);
        let sink = zip.finish().expect("finished");
        assert!(sink.widest_write <= CHUNK, "wrote {}", sink.widest_write);
        assert!(sink.len > size);
    }

    #[test]
    fn a_reader_that_gives_the_wrong_length_is_an_error() {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        assert!(zip.add("long", 3, &b"abcd"[..]).is_err());
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        assert!(zip.add("short", 5, &b"abc"[..]).is_err());
    }

    #[test]
    fn an_entry_past_the_zip64_line_gets_64_bit_sizes_and_the_archive_an_end_record() {
        let mut zip = ZipWriter::with_zip64_at(Cursor::new(Vec::new()), 10);
        zip.add("small", 3, &b"abc"[..]).expect("added");
        zip.add("large.bin", 12, &b"twelve bytes"[..])
            .expect("added");
        zip.add("after", 2, &b"ok"[..]).expect("added");
        let bytes = zip.finish().expect("finished").into_inner();
        // The large entry's local header: version 45, 0xFFFFFFFF sizes and the 64-bit extra.
        let local = bytes
            .windows(4)
            .position(|w| w == b"PK\x03\x04")
            .and_then(|first| {
                (first..bytes.len() - 4)
                    .filter(|at| &bytes[*at..*at + 4] == b"PK\x03\x04")
                    .nth(1)
            })
            .expect("second local header");
        assert_eq!(u16_at(&bytes, local + 4).unwrap(), 45);
        assert_eq!(u32_at(&bytes, local + 18).unwrap(), 0xFFFF_FFFF);
        assert_eq!(u16_at(&bytes, local + 28).unwrap(), 20);
        // The end: the locator and the ZIP64 end record come before the plain end record.
        let end = bytes.len() - 22;
        assert_eq!(u16_at(&bytes, end + 10).unwrap(), 0xFFFF);
        assert_eq!(u32_at(&bytes, end - 20).unwrap(), LOCATOR64);
        let read = stored_entries(&bytes).expect("read");
        assert_eq!(
            read,
            vec![
                ("small".to_owned(), b"abc".to_vec()),
                ("large.bin".to_owned(), b"twelve bytes".to_vec()),
                ("after".to_owned(), b"ok".to_vec()),
            ]
        );
    }
}

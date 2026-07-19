use std::io::{Cursor, Read, Seek, SeekFrom, Write};

use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use anyhow::{Context, Result, bail};
use flate2::read::DeflateDecoder;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

pub const MAGIC: &[u8; 4] = b"CBSF";
pub const VERSION: u8 = 2;
pub const HEADER_BYTES: usize = 37;
pub const TRAILER_BYTES: usize = 13;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_DIRECTORY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Directory {
    pub frame_size: u32,
    pub total_size: u64,
    pub sealed_lens: Vec<u32>,
}

fn frame_aad(sha: &str, index: usize, count: usize) -> String {
    format!("blob:{sha}:v{VERSION}:f{index}/{count}")
}

fn directory_aad(sha: &str, count: usize) -> String {
    format!("blobdir:{sha}:v{VERSION}:n{count}")
}

fn nonce_for(key: &[u8; 32], aad: &[u8], plain: &[u8]) -> [u8; 12] {
    let mut body_mac = <HmacSha256 as Mac>::new_from_slice(key).expect("fixed HMAC key");
    body_mac.update(plain);
    let body_hash = body_mac.finalize().into_bytes();
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).expect("fixed HMAC key");
    mac.update(b"cbsf-nonce\0");
    mac.update(aad);
    mac.update(b"\0");
    mac.update(&body_hash);
    mac.finalize().into_bytes()[..NONCE_BYTES]
        .try_into()
        .expect("nonce length")
}

fn seal(key: &[u8; 32], aad: &[u8], plain: &[u8]) -> Result<Vec<u8>> {
    let nonce = nonce_for(key, aad, plain);
    let cipher = Aes256Gcm::new_from_slice(key).context("invalid CBSF key")?;
    let body = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad })
        .map_err(|_| anyhow::anyhow!("CBSF seal failed"))?;
    let mut output = Vec::with_capacity(NONCE_BYTES + body.len());
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&body);
    Ok(output)
}

fn open(key: &[u8; 32], aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
    if sealed.len() < NONCE_BYTES + TAG_BYTES {
        bail!("CBSF sealed value truncated");
    }
    let cipher = Aes256Gcm::new_from_slice(key).context("invalid CBSF key")?;
    cipher
        .decrypt(
            Nonce::from_slice(&sealed[..NONCE_BYTES]),
            Payload {
                msg: &sealed[NONCE_BYTES..],
                aad,
            },
        )
        .map_err(|_| anyhow::anyhow!("CBSF authentication failed"))
}

fn encode_directory(directory: &Directory) -> Result<Vec<u8>> {
    let count = u32::try_from(directory.sealed_lens.len()).context("too many CBSF frames")?;
    let mut bytes = Vec::with_capacity(16 + directory.sealed_lens.len() * 4);
    bytes.extend_from_slice(&directory.frame_size.to_be_bytes());
    bytes.extend_from_slice(&directory.total_size.to_be_bytes());
    bytes.extend_from_slice(&count.to_be_bytes());
    for len in &directory.sealed_lens {
        bytes.extend_from_slice(&len.to_be_bytes());
    }
    Ok(bytes)
}

fn decode_directory(bytes: &[u8], frame_count: usize) -> Result<Directory> {
    if bytes.len() != 16 + frame_count * 4 {
        bail!("CBSF directory size mismatch");
    }
    let frame_size = u32::from_be_bytes(bytes[0..4].try_into()?);
    let total_size = u64::from_be_bytes(bytes[4..12].try_into()?);
    let encoded_count = u32::from_be_bytes(bytes[12..16].try_into()?);
    if encoded_count as usize != frame_count {
        bail!("CBSF directory frame count mismatch");
    }
    let sealed_lens = bytes[16..]
        .chunks_exact(4)
        .map(|part| u32::from_be_bytes(part.try_into().expect("four-byte chunk")))
        .collect();
    Ok(Directory {
        frame_size,
        total_size,
        sealed_lens,
    })
}

fn decode_frame_body(body: &[u8], expected_len: usize) -> Result<Vec<u8>> {
    let (&algorithm, payload) = body
        .split_first()
        .context("CBSF frame has no algorithm byte")?;
    let mut plain = Vec::with_capacity(expected_len);
    let limit = u64::try_from(expected_len)?.saturating_add(1);
    match algorithm {
        0 => plain.extend_from_slice(payload),
        1 => {
            let decoder =
                zstd::stream::read::Decoder::new(payload).context("CBSF zstd frame failed")?;
            decoder
                .take(limit)
                .read_to_end(&mut plain)
                .context("CBSF zstd frame failed")?;
        }
        2 => {
            DeflateDecoder::new(payload)
                .take(limit)
                .read_to_end(&mut plain)
                .context("CBSF deflate frame failed")?;
        }
        other => bail!("unknown CBSF compression algorithm {other}"),
    }
    if plain.len() != expected_len {
        bail!("CBSF frame plaintext size mismatch");
    }
    Ok(plain)
}

/// Seal a seekable object using store-only frames. The input is read twice —
/// once for the content address and once for encryption — and memory remains
/// bounded by the configured frame size.
pub fn seal_stored_object_io<R: Read + Seek, W: Write>(
    key: &[u8; 32],
    input: &mut R,
    output: &mut W,
    frame_size: usize,
) -> Result<Directory> {
    if frame_size == 0 || frame_size > MAX_FRAME_BYTES {
        bail!("invalid CBSF frame size");
    }

    input.seek(SeekFrom::Start(0))?;
    let mut digest = Sha256::new();
    let mut total_size = 0_u64;
    let mut hash_buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = input.read(&mut hash_buffer)?;
        if read == 0 {
            break;
        }
        total_size = total_size
            .checked_add(read as u64)
            .context("CBSF input size overflow")?;
        digest.update(&hash_buffer[..read]);
    }
    let sha_bytes: [u8; 32] = digest.finalize().into();
    let sha = hex::encode(sha_bytes);
    let frame_count_u64 = total_size.div_ceil(frame_size as u64);
    let frame_count = usize::try_from(frame_count_u64).context("too many CBSF frames")?;
    let directory_plain_bytes = 16_usize
        .checked_add(
            frame_count
                .checked_mul(4)
                .context("CBSF directory overflow")?,
        )
        .context("CBSF directory overflow")?;
    if directory_plain_bytes + NONCE_BYTES + TAG_BYTES > MAX_DIRECTORY_BYTES {
        bail!("CBSF directory exceeds memory cap");
    }

    output.write_all(MAGIC)?;
    output.write_all(&[VERSION])?;
    output.write_all(&sha_bytes)?;
    input.seek(SeekFrom::Start(0))?;
    let mut sealed_lens = Vec::with_capacity(frame_count);
    let mut remaining = total_size;
    for index in 0..frame_count {
        let plain_len = usize::try_from(remaining.min(frame_size as u64))?;
        let mut body = vec![0_u8; plain_len + 1];
        body[0] = 0;
        input.read_exact(&mut body[1..])?;
        let sealed = seal(key, frame_aad(&sha, index, frame_count).as_bytes(), &body)?;
        sealed_lens.push(u32::try_from(sealed.len())?);
        output.write_all(&sealed)?;
        remaining -= plain_len as u64;
    }
    let directory = Directory {
        frame_size: frame_size as u32,
        total_size,
        sealed_lens,
    };
    let directory_plain = encode_directory(&directory)?;
    let sealed_directory = seal(
        key,
        directory_aad(&sha, frame_count).as_bytes(),
        &directory_plain,
    )?;
    output.write_all(&sealed_directory)?;
    output.write_all(MAGIC)?;
    output.write_all(&[VERSION])?;
    output.write_all(&u32::try_from(sealed_directory.len())?.to_be_bytes())?;
    output.write_all(&u32::try_from(frame_count)?.to_be_bytes())?;
    Ok(directory)
}

/// Authenticate and open one seekable CBSF object while retaining at most one
/// encrypted frame, one plaintext frame, and the bounded directory in memory.
pub fn open_object_io<R: Read + Seek, W: Write>(
    key: &[u8; 32],
    input: &mut R,
    output: &mut W,
) -> Result<Directory> {
    let sealed_len = input.seek(SeekFrom::End(0))?;
    if sealed_len < (HEADER_BYTES + TRAILER_BYTES) as u64 {
        bail!("CBSF object truncated");
    }
    input.seek(SeekFrom::Start(0))?;
    let mut header = [0_u8; HEADER_BYTES];
    input.read_exact(&mut header)?;
    if &header[..4] != MAGIC || header[4] != VERSION {
        bail!("CBSF header mismatch");
    }
    let sha = hex::encode(&header[5..HEADER_BYTES]);
    input.seek(SeekFrom::End(-(TRAILER_BYTES as i64)))?;
    let mut trailer = [0_u8; TRAILER_BYTES];
    input.read_exact(&mut trailer)?;
    if &trailer[..4] != MAGIC || trailer[4] != VERSION {
        bail!("CBSF trailer mismatch");
    }
    let directory_len = u32::from_be_bytes(trailer[5..9].try_into()?) as usize;
    let frame_count = u32::from_be_bytes(trailer[9..13].try_into()?) as usize;
    if directory_len > MAX_DIRECTORY_BYTES {
        bail!("CBSF directory exceeds memory cap");
    }
    let directory_start = sealed_len
        .checked_sub((TRAILER_BYTES + directory_len) as u64)
        .context("CBSF directory overruns object")?;
    if directory_start < HEADER_BYTES as u64 {
        bail!("CBSF directory overruns frames");
    }
    input.seek(SeekFrom::Start(directory_start))?;
    let mut sealed_directory = vec![0_u8; directory_len];
    input.read_exact(&mut sealed_directory)?;
    let directory_plain = open(
        key,
        directory_aad(&sha, frame_count).as_bytes(),
        &sealed_directory,
    )?;
    let directory = decode_directory(&directory_plain, frame_count)?;
    if directory.frame_size == 0 || directory.frame_size as usize > MAX_FRAME_BYTES {
        bail!("invalid CBSF frame size");
    }
    if directory.total_size.div_ceil(directory.frame_size as u64) != frame_count as u64 {
        bail!("CBSF directory frame count does not match plaintext size");
    }

    input.seek(SeekFrom::Start(HEADER_BYTES as u64))?;
    let mut cursor = HEADER_BYTES as u64;
    let mut digest = Sha256::new();
    let mut plain_total = 0_u64;
    for (index, len) in directory.sealed_lens.iter().enumerate() {
        let end = cursor
            .checked_add(*len as u64)
            .context("CBSF frame overflow")?;
        if end > directory_start {
            bail!("CBSF frame overruns directory");
        }
        if (*len as usize) > MAX_FRAME_BYTES + 1 + NONCE_BYTES + TAG_BYTES {
            bail!("CBSF frame exceeds memory cap");
        }
        let mut sealed_frame = vec![0_u8; *len as usize];
        input.read_exact(&mut sealed_frame)?;
        let body = open(
            key,
            frame_aad(&sha, index, frame_count).as_bytes(),
            &sealed_frame,
        )?;
        let expected_len = (directory.total_size - plain_total).min(directory.frame_size as u64);
        let plain = decode_frame_body(&body, usize::try_from(expected_len)?)?;
        output.write_all(&plain)?;
        digest.update(&plain);
        plain_total += plain.len() as u64;
        cursor = end;
    }
    if cursor != directory_start || plain_total != directory.total_size {
        bail!("CBSF layout or plaintext size mismatch");
    }
    if hex::encode(digest.finalize()) != sha {
        bail!("CBSF plaintext SHA mismatch");
    }
    Ok(directory)
}

pub fn seal_stored_object(key: &[u8; 32], plain: &[u8], frame_size: usize) -> Result<Vec<u8>> {
    let mut input = Cursor::new(plain);
    let mut output = Vec::new();
    seal_stored_object_io(key, &mut input, &mut output, frame_size)?;
    Ok(output)
}

pub fn open_object(key: &[u8; 32], sealed: &[u8]) -> Result<Vec<u8>> {
    let mut input = Cursor::new(sealed);
    let mut output = Vec::new();
    open_object_io(key, &mut input, &mut output)?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_object_round_trips_and_rejects_tampering() {
        let key = [7_u8; 32];
        let plain = b"cross-language CBSF bytes that span frames";
        let sealed = seal_stored_object(&key, plain, 11).unwrap();
        assert_eq!(open_object(&key, &sealed).unwrap(), plain);
        let mut damaged = sealed;
        damaged[HEADER_BYTES + 14] ^= 1;
        assert!(open_object(&key, &damaged).is_err());
    }

    #[test]
    fn io_surface_round_trips_without_whole_object_buffers() {
        let key = [9_u8; 32];
        let plain = vec![42_u8; 3 * 1024 * 1024 + 17];
        let mut input = Cursor::new(&plain);
        let mut sealed = Cursor::new(Vec::new());
        let directory = seal_stored_object_io(&key, &mut input, &mut sealed, 1024 * 1024).unwrap();
        assert_eq!(directory.sealed_lens.len(), 4);
        sealed.set_position(0);
        let mut opened = Vec::new();
        open_object_io(&key, &mut sealed, &mut opened).unwrap();
        assert_eq!(opened, plain);
    }

    #[test]
    fn compressed_frame_decode_stops_at_the_declared_plaintext_bound() {
        let oversized = vec![42_u8; 1024 * 1024];
        let compressed = zstd::stream::encode_all(Cursor::new(oversized), 1).unwrap();
        let mut body = vec![1_u8];
        body.extend_from_slice(&compressed);
        let error = decode_frame_body(&body, 16).unwrap_err();
        assert!(error.to_string().contains("plaintext size mismatch"));
    }
}

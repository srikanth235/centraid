use std::{
    io::{BufReader, BufWriter, Write},
    path::PathBuf,
};

use anyhow::{Context, Result, bail};
use centraid_data_plane::{cbsf, http_plane, iroh_relay};
use clap::{Parser, Subcommand};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

#[derive(Parser)]
#[command(
    name = "centraid-data-plane",
    version,
    about = "Centraid native byte plane"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Ticketed CAS Range server plus hash/compress/preview workers.
    ServeHttp {
        #[arg(
            long,
            env = "CENTRAID_DATA_PLANE_LISTEN",
            default_value = "127.0.0.1:18891"
        )]
        listen: String,
        #[arg(long, env = "CENTRAID_DATA_PLANE_ROOT")]
        root: PathBuf,
        #[arg(long, env = "CENTRAID_DATA_PLANE_SECRET")]
        ticket_secret: String,
    },
    /// Native iroh request/response relay; tunneled bytes never enter JS.
    ServeIroh {
        #[arg(long, env = "CENTRAID_IROH_SECRET_HEX")]
        secret_key_hex: String,
        #[arg(long, env = "CENTRAID_GATEWAY_URL")]
        upstream_url: String,
        #[arg(long, env = "CENTRAID_GATEWAY_TOKEN")]
        upstream_token: String,
        #[arg(long, env = "CENTRAID_DATA_PLANE_SECRET")]
        control_secret: String,
        #[arg(long, default_value_t = true)]
        n0_relays: bool,
    },
    /// Hash a file through RustCrypto's native streaming implementation.
    Hash { file: PathBuf },
    /// Seal a file as deterministic store-only CBSF v2 frames.
    SealCbsf {
        #[arg(long)]
        key_hex: String,
        #[arg(long, default_value_t = 4 * 1024 * 1024)]
        frame_size: usize,
        input: PathBuf,
        output: PathBuf,
    },
    /// Authenticate and open a CBSF v2 object.
    OpenCbsf {
        #[arg(long)]
        key_hex: String,
        input: PathBuf,
        output: PathBuf,
    },
}

fn key32(encoded: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(encoded).context("key is not hex")?;
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("key must be 32 bytes"))
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    match Cli::parse().command {
        Command::ServeHttp {
            listen,
            root,
            ticket_secret,
        } => {
            if ticket_secret.len() < 32 {
                bail!("ticket secret must contain at least 32 characters");
            }
            http_plane::serve(http_plane::HttpPlaneConfig {
                listen,
                root,
                ticket_secret: ticket_secret.into_bytes(),
            })
            .await
        }
        Command::ServeIroh {
            secret_key_hex,
            upstream_url,
            upstream_token,
            control_secret,
            n0_relays,
        } => {
            iroh_relay::serve(iroh_relay::IrohRelayConfig {
                secret_key: key32(&secret_key_hex)?,
                control_url: upstream_url.clone(),
                control_token: upstream_token.clone(),
                upstream_url,
                upstream_token,
                control_secret,
                use_n0_relays: n0_relays,
                desktop_pairing: false,
            })
            .await
        }
        Command::Hash { file } => {
            let mut file = tokio::fs::File::open(&file)
                .await
                .with_context(|| format!("open {}", file.display()))?;
            let mut digest = Sha256::new();
            let mut buffer = vec![0_u8; 1024 * 1024];
            loop {
                let read = file.read(&mut buffer).await?;
                if read == 0 {
                    break;
                }
                digest.update(&buffer[..read]);
            }
            println!("{}", hex::encode(digest.finalize()));
            Ok(())
        }
        Command::SealCbsf {
            key_hex,
            frame_size,
            input,
            output,
        } => {
            let mut input = BufReader::new(
                std::fs::File::open(&input)
                    .with_context(|| format!("open CBSF input {}", input.display()))?,
            );
            let mut output = BufWriter::new(
                std::fs::File::create(&output)
                    .with_context(|| format!("create CBSF output {}", output.display()))?,
            );
            cbsf::seal_stored_object_io(&key32(&key_hex)?, &mut input, &mut output, frame_size)?;
            output.flush()?;
            Ok(())
        }
        Command::OpenCbsf {
            key_hex,
            input,
            output,
        } => {
            let mut input = BufReader::new(
                std::fs::File::open(&input)
                    .with_context(|| format!("open CBSF input {}", input.display()))?,
            );
            let mut output = BufWriter::new(
                std::fs::File::create(&output)
                    .with_context(|| format!("create CBSF output {}", output.display()))?,
            );
            cbsf::open_object_io(&key32(&key_hex)?, &mut input, &mut output)?;
            output.flush()?;
            Ok(())
        }
    }
}

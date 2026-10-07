//! THE ENGINE'S EYES, AGAINST A REAL MODEL AND A REAL PROJECTOR.
//!
//! `#[ignore]`d and inert without `CENTRAID_ASSIST_MODEL` (the Qwen3.5-0.8B
//! GGUF) and `CENTRAID_ASSIST_MMPROJ` (its vision projector):
//!
//! ```text
//! CENTRAID_ASSIST_MODEL=~/.cache/centraid/models/Qwen3.5-0.8B-Q4_0.gguf \
//! CENTRAID_ASSIST_MMPROJ=~/.cache/centraid/models/Qwen3.5-0.8B-mmproj-F16.gguf \
//!   cargo test --release -p centraid-assist-llama --test real_vision -- --ignored --nocapture
//! ```
//!
//! The first test is also the check that the two files PAIR: the weights are
//! ggml-org's conversion and the projector is unsloth's, and a projector for a
//! different embedding width would fail at attach or describe noise.
//! Set `CENTRAID_ASSIST_CPU=1` to run the CPU path the iOS Simulator takes.

use std::path::PathBuf;
use std::time::Instant;

use centraid_assist::host::ModelLoader;
use centraid_assist::model::{Cancel, Control, Finish, GenerateRequest, ImageInput, MEDIA_MARKER};
use centraid_assist::prompt::{ASSISTANT_TURN, END_OF_TURN};
use centraid_assist_llama::{Config, LlamaLoader};

fn config() -> Config {
    let mut config = Config::default();
    if std::env::var_os("CENTRAID_ASSIST_CPU").is_some() {
        config.gpu_layers = 0;
    }
    config
}

fn paths() -> Option<(PathBuf, PathBuf)> {
    Some((
        PathBuf::from(std::env::var_os("CENTRAID_ASSIST_MODEL")?),
        PathBuf::from(std::env::var_os("CENTRAID_ASSIST_MMPROJ")?),
    ))
}

/// A sample-vault photograph, scaled the way the core scales it.
fn photo(name: &str, edge: u32) -> (u32, u32, Vec<u8>) {
    let path = format!(
        "{}/../core/src/sample/photos/{name}.png",
        env!("CARGO_MANIFEST_DIR")
    );
    let decoded = image::open(&path).expect("a sample photo");
    let scaled = decoded.resize(edge, edge, image::imageops::FilterType::Triangle);
    let rgb = scaled.to_rgb8();
    (rgb.width(), rgb.height(), rgb.into_raw())
}

fn rss_mb() -> u64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<u64>()
        .unwrap_or(0)
        / 1024
}

#[test]
#[ignore = "needs CENTRAID_ASSIST_MODEL and CENTRAID_ASSIST_MMPROJ"]
fn the_projector_pairs_with_the_weights_and_a_photo_is_described() {
    let Some((weights, projector)) = paths() else {
        return;
    };
    let started = Instant::now();
    let model = LlamaLoader::new(config())
        .load(&weights)
        .expect("the model loads");
    println!(
        "weights loaded in {:?}, rss {} MB",
        started.elapsed(),
        rss_mb()
    );
    assert!(!model.has_vision());

    let started = Instant::now();
    model
        .attach_vision(&projector)
        .expect("the projector pairs with the weights");
    println!(
        "projector loaded in {:?}, rss {} MB",
        started.elapsed(),
        rss_mb()
    );
    assert!(model.has_vision());

    for name in [
        std::env::var("CENTRAID_ASSIST_PHOTO").unwrap_or_else(|_| "truckee-river-bend".to_owned()),
        "ana-porch-evening".to_owned(),
        "harbor-lights".to_owned(),
    ] {
        let edge = std::env::var("CENTRAID_ASSIST_EDGE")
            .ok()
            .and_then(|e| e.parse().ok())
            .unwrap_or(448);
        let (width, height, rgb) = photo(&name, edge);
        let images = [ImageInput {
            width,
            height,
            rgb: &rgb,
        }];
        let prompt = format!(
            "<|im_start|>system\nYou are Centraid, a private assistant.<|im_end|>\n\
             <|im_start|>user\n{MEDIA_MARKER}\nWhat is in this photo? Answer in two short sentences.<|im_end|>\n\
             {ASSISTANT_TURN}"
        );
        let cancel = Cancel::new();
        let started = Instant::now();
        let mut first = None;
        let generation = model
            .generate(
                &GenerateRequest {
                    prompt: &prompt,
                    grammar: None,
                    max_tokens: 120,
                    stop: &[END_OF_TURN],
                    temperature: 0.0,
                    cancel: &cancel,
                    images: &images,
                },
                &mut |_| {
                    first.get_or_insert_with(|| started.elapsed());
                    Control::Continue
                },
            )
            .expect("a generation");
        println!(
            "[{name} {width}x{height}] first token {:?}, total {:?}, prompt {} tokens, {} generated, rss {} MB\n  -> {}",
            first.unwrap_or_default(),
            started.elapsed(),
            generation.prompt_tokens,
            generation.generated_tokens,
            rss_mb(),
            generation.text.trim()
        );
        assert_eq!(generation.finish, Finish::Stop);
        assert!(generation.text.trim().len() > 10);
    }
}

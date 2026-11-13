//! Prints, as JSON, the hashes the runtime computes for each catalogue mode. `cargo xtask model-pin`
//! reads it to fill a record; it is not a product surface.

use centraid_assist::native::prompt::ToolsMode;
use centraid_assist::record::runtime_hashes;

fn main() {
    let mut out = serde_json::Map::new();
    for mode in ToolsMode::ALL {
        let (tools, prompt) = runtime_hashes(mode);
        out.insert(
            mode.name().to_owned(),
            serde_json::json!({"tools_hash": tools, "prompt_hash": prompt}),
        );
    }
    println!("{}", serde_json::Value::Object(out));
}

use std::env;
use std::fs;
use std::path::Path;

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BaselineFile {
    durable_baseline: DurableBaseline,
}

#[derive(Deserialize)]
struct DurableBaseline {
    epoch: i64,
    format: i64,
}

fn main() {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/epoch.json");
    println!("cargo:rerun-if-changed={}", source.display());
    let text = fs::read_to_string(&source)
        .unwrap_or_else(|error| panic!("could not read {}: {error}", source.display()));
    let baseline: BaselineFile = serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("could not parse {}: {error}", source.display()));
    let epoch = positive_baseline_integer(baseline.durable_baseline.epoch, "epoch", &source);
    let format = positive_baseline_integer(baseline.durable_baseline.format, "format", &source);
    let out = Path::new(&env::var("OUT_DIR").expect("OUT_DIR")).join("durable_baseline.rs");
    fs::write(
        out,
        format!(
            "pub(crate) const DURABLE_STORE_EPOCH: i64 = {epoch};\npub(crate) const DURABLE_STORE_FORMAT: i64 = {format};\n"
        ),
    )
    .expect("could not write the generated epoch constant");
}

fn positive_baseline_integer(value: i64, name: &str, source: &Path) -> i64 {
    if value > 0 {
        value
    } else {
        panic!(
            "{} must contain a positive durableBaseline.{name}",
            source.display()
        );
    }
}

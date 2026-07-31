use std::env;
use std::fs;
use std::path::Path;

fn main() {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/epoch.json");
    println!("cargo:rerun-if-changed={}", source.display());
    let text = fs::read_to_string(&source)
        .unwrap_or_else(|error| panic!("could not read {}: {error}", source.display()));
    let epoch: i64 = text
        .split(':')
        .nth(1)
        .and_then(|tail| tail.trim().trim_end_matches('}').trim().parse().ok())
        .unwrap_or_else(|| panic!("{} must contain an integer epoch", source.display()));
    let out = Path::new(&env::var("OUT_DIR").expect("OUT_DIR")).join("epoch.rs");
    fs::write(out, format!("pub(crate) const EMBEDDED_EPOCH: i64 = {epoch};\n"))
        .expect("could not write the generated epoch constant");
}

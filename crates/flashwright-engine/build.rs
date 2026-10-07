use sha2::{Digest, Sha256};

fn main() {
    let mut hash = Sha256::new();
    let directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/resident-runtime");
    let manifest = directory.join("sources.txt");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let sources = std::fs::read_to_string(manifest).expect("runtime source manifest must exist");
    for name in sources.lines() {
        let runtime = directory.join(name);
        println!("cargo:rerun-if-changed={}", runtime.display());
        let source = std::fs::read(runtime).expect("shared resident runtime must exist");
        // A literal non-ASCII diagnostic increased the measured installation cost
        // of the whole combined injection on the pinned Chromium.
        assert!(
            source.is_ascii(),
            "resident source {name} must be ASCII; use JavaScript Unicode escapes for literal values"
        );
        hash.update((source.len() as u64).to_le_bytes());
        hash.update(source);
    }
    println!(
        "cargo:rustc-env=FLASHWRIGHT_RUNTIME_SHA256={:x}",
        hash.finalize()
    );
}

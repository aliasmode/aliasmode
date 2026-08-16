use std::{env, fs, path::PathBuf};

fn main() {
    tauri_build::build();

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let source = manifest.join("generated/browser.json");
    println!("cargo:rerun-if-changed={}", source.display());

    let metadata = fs::read_to_string(&source)
        .expect("generated browser metadata is missing; run `bun run desktop:prepare` first");
    let parsed: serde_json::Value =
        serde_json::from_str(&metadata).expect("valid generated browser metadata");
    for key in ["executable", "wrapperVersion"] {
        assert!(
            parsed
                .get(key)
                .and_then(|value| value.as_str())
                .is_some_and(|value| !value.is_empty()),
            "browser metadata is missing {key}"
        );
    }
    assert_eq!(
        parsed.get("executable").and_then(|value| value.as_str()),
        Some("chrome.exe"),
        "browser metadata must target Windows chrome.exe"
    );
    let sha256 = parsed
        .get("sha256")
        .and_then(|value| value.as_str())
        .expect("browser metadata is missing sha256");
    assert!(
        sha256.len() == 64
            && sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            && sha256.bytes().any(|byte| byte != b'0'),
        "browser metadata has an invalid sha256"
    );

    let out = PathBuf::from(env::var("OUT_DIR").expect("build output directory"));
    fs::write(out.join("browser.json"), metadata).expect("write embedded browser metadata");
}

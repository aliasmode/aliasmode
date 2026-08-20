use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read},
    path::{Component, Path, PathBuf},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserMetadata {
    executable: String,
    sha256: String,
    wrapper_version: String,
}

#[derive(Debug, Clone)]
pub struct BrowserRuntime {
    pub executable: PathBuf,
    pub sha256: String,
}

fn embedded_metadata() -> Result<BrowserMetadata, String> {
    serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/browser.json")))
        .map_err(|error| format!("invalid packaged CloakBrowser metadata: {error}"))
}

fn safe_relative_executable(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("packaged CloakBrowser executable path is unsafe".to_owned());
    }
    Ok(path.to_owned())
}

fn hash_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hex::encode(hash.finalize()))
}

pub fn verify_browser_resource(resource_dir: &Path) -> Result<BrowserRuntime, String> {
    let metadata = embedded_metadata()?;
    if metadata.wrapper_version != "0.4.11" || !is_sha256(&metadata.sha256) {
        return Err("packaged CloakBrowser metadata is not approved".to_owned());
    }
    let executable = safe_relative_executable(&metadata.executable)?;
    let root = resource_dir
        .join("cloakbrowser")
        .canonicalize()
        .map_err(|error| format!("packaged CloakBrowser directory is unavailable: {error}"))?;
    let executable = root
        .join(executable)
        .canonicalize()
        .map_err(|error| format!("packaged CloakBrowser executable is unavailable: {error}"))?;
    if !executable.starts_with(&root) || !executable.is_file() {
        return Err("packaged CloakBrowser executable escaped its resource directory".to_owned());
    }
    let actual = hash_file(&executable)
        .map_err(|error| format!("could not hash packaged CloakBrowser: {error}"))?;
    if actual != metadata.sha256 {
        return Err("packaged CloakBrowser SHA-256 does not match build metadata".to_owned());
    }
    Ok(BrowserRuntime {
        executable,
        sha256: actual,
    })
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::{is_sha256, safe_relative_executable};

    #[test]
    fn validates_hash_shape() {
        assert!(is_sha256(&"ab".repeat(32)));
        assert!(!is_sha256(&"AB".repeat(32)));
        assert!(!is_sha256("short"));
    }

    #[test]
    fn rejects_resource_path_escape() {
        assert!(safe_relative_executable("chrome.exe").is_ok());
        assert!(safe_relative_executable("bin/chrome.exe").is_ok());
        assert!(safe_relative_executable("Chromium.app/Contents/MacOS/Chromium").is_ok());
        assert!(safe_relative_executable("../chrome.exe").is_err());
        assert!(safe_relative_executable("/chrome.exe").is_err());
    }
}

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read},
    path::{Component, Path, PathBuf},
};

const CLOAKBROWSER_WRAPPER_VERSION: &str = "0.4.11";
const FIREFOX_VERSION: &str = "152.0.4-beta.30";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserMetadata {
    executable: String,
    sha256: String,
    wrapper_version: String,
    firefox: FirefoxMetadata,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FirefoxMetadata {
    executable: String,
    sha256: String,
    version: String,
    archive_sha256: String,
}

#[derive(Debug, Clone)]
pub struct BrowserRuntime {
    pub executable: PathBuf,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct FirefoxRuntime {
    pub executable: PathBuf,
    pub sha256: String,
}

fn embedded_metadata() -> Result<BrowserMetadata, String> {
    serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/browser.json")))
        .map_err(|error| format!("invalid packaged browser metadata: {error}"))
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

fn verify_resource(
    resource_dir: &Path,
    directory: &str,
    executable: &str,
    expected_sha256: &str,
    name: &str,
) -> Result<(PathBuf, String), String> {
    let executable = safe_relative_executable(executable)?;
    let root = resource_dir
        .join(directory)
        .canonicalize()
        .map_err(|error| format!("packaged {name} directory is unavailable: {error}"))?;
    let executable = root
        .join(executable)
        .canonicalize()
        .map_err(|error| format!("packaged {name} executable is unavailable: {error}"))?;
    if !executable.starts_with(&root) || !executable.is_file() {
        return Err(format!(
            "packaged {name} executable escaped its resource directory"
        ));
    }
    let actual = hash_file(&executable)
        .map_err(|error| format!("could not hash packaged {name}: {error}"))?;
    if actual != expected_sha256 {
        return Err(format!(
            "packaged {name} SHA-256 does not match build metadata"
        ));
    }
    Ok((executable, actual))
}

pub fn verify_browser_resource(resource_dir: &Path) -> Result<BrowserRuntime, String> {
    let metadata = embedded_metadata()?;
    if metadata.wrapper_version != CLOAKBROWSER_WRAPPER_VERSION || !is_sha256(&metadata.sha256) {
        return Err("packaged CloakBrowser metadata is not approved".to_owned());
    }
    let (executable, sha256) = verify_resource(
        resource_dir,
        "cloakbrowser",
        &metadata.executable,
        &metadata.sha256,
        "CloakBrowser",
    )?;
    Ok(BrowserRuntime { executable, sha256 })
}

pub fn verify_firefox_resource(resource_dir: &Path) -> Result<FirefoxRuntime, String> {
    let metadata = embedded_metadata()?;
    if metadata.firefox.version != FIREFOX_VERSION
        || Path::new(&metadata.firefox.executable)
            .file_name()
            .is_none_or(|name| name != "aliasmode.exe")
        || !is_sha256(&metadata.firefox.sha256)
        || !is_sha256(&metadata.firefox.archive_sha256)
    {
        return Err("packaged AliasMode Firefox metadata is not approved".to_owned());
    }
    let (executable, sha256) = verify_resource(
        resource_dir,
        "firefox",
        &metadata.firefox.executable,
        &metadata.firefox.sha256,
        "AliasMode Firefox",
    )?;
    Ok(FirefoxRuntime { executable, sha256 })
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
        assert!(safe_relative_executable("../chrome.exe").is_err());
        assert!(safe_relative_executable("/chrome.exe").is_err());
    }
}

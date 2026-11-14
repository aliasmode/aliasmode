use crate::{
    shutdown,
    sidecar::SidecarSupervisor,
    update_attempt::{self, InstallerHandoff, LastUpdateResult, UpdateFailureReason},
    update_download::{self, DownloadEvent, DownloadFailure, UPDATE_DOWNLOAD_POLICY},
};
use reqwest::{header::ACCEPT, redirect::Policy, Client};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::{ipc::Channel, AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;
use url::Url;

const RELEASES_API: &str = "https://api.github.com/repos/aliasmode/aliasmode/releases?per_page=10";
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
const UPDATE_MANIFEST: &str = "latest-v2.json";
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
const UPDATE_TARGET: &str = "windows-x86_64";
// macOS and Linux read their own feeds: installed Windows clients accept only a one-platform manifest.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const UPDATE_MANIFEST: &str = "latest-macos.json";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const UPDATE_TARGET: &str = "darwin-aarch64";
// Installed Apple Silicon apps accept only a one-platform manifest, so Intel Macs read their own.
#[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
const UPDATE_MANIFEST: &str = "latest-macos-x64.json";
#[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
const UPDATE_TARGET: &str = "darwin-x86_64";
#[cfg(target_os = "linux")]
const UPDATE_MANIFEST: &str = "latest-linux.json";
#[cfg(target_os = "linux")]
const UPDATE_TARGET: &str = "linux-x86_64";
const MAX_RELEASE_HIGHLIGHTS: usize = 3;
const UPDATE_BUSY: &str = "An update operation is already running.";
const CHECK_FAILED: &str = "AliasMode could not check for updates. Try again.";
const DOWNLOAD_INTERRUPTED: &str =
    "The update download was interrupted. Your browsers are still open. Try again.";
const DOWNLOAD_STALLED: &str = "The update download stopped because no data arrived for 1 minute. Your browsers are still open. Check your connection and try again.";
const VERIFY_FAILED: &str =
    "AliasMode could not verify the downloaded update. Your browsers are still open. Try again.";
// The release list is about 400 KB without compression. These limits let a slow link finish it.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CHECK_RETRY_DELAY: Duration = Duration::from_secs(2);
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
const INSTALLATION_UNSAFE: &str = "AliasMode cannot safely update this installation. Close AliasMode and run the full offline installer from the release page. Do not uninstall.";
#[cfg(target_os = "macos")]
const INSTALLATION_UNSAFE: &str = "AliasMode cannot update this copy. Move AliasMode to the Applications folder and open it again, or run the install command again.";
#[cfg(target_os = "linux")]
const INSTALLATION_UNSAFE: &str = "AliasMode cannot update this copy. Close AliasMode and run the install command from aliasmode.com/download again.";
const CLEANUP_FAILED: &str =
    "The update was not installed because AliasMode could not safely close browser services. The current version remains installed.";
const INSTALL_FAILED: &str =
    "AliasMode could not start the verified update. The current version will restart.";

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    body: Option<String>,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Clone, PartialEq)]
struct ReleaseCandidate {
    tag: String,
    version: Version,
    manifest_url: Url,
    highlights: Vec<String>,
}

struct DiscoveredUpdate {
    update: Update,
    highlights: Vec<String>,
    /// The system proxy the update check won on, if any: the installer
    /// download reuses this route instead of connecting directly.
    proxy_url: Option<Url>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "state")]
pub enum UpdateStatus {
    #[serde(rename = "upToDate")]
    UpToDate {
        #[serde(rename = "currentVersion")]
        current_version: String,
    },
    #[serde(rename = "available")]
    Available {
        #[serde(rename = "currentVersion")]
        current_version: String,
        version: String,
        highlights: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum UpdateProgress {
    Preparing,
    Ready {
        version: String,
        highlights: Vec<String>,
    },
    Downloading {
        percent: Option<u8>,
        #[serde(rename = "downloadedBytes")]
        downloaded_bytes: u64,
        #[serde(rename = "totalBytes")]
        total_bytes: Option<u64>,
    },
    /// The download failed and starts again where it stopped.
    Reconnecting,
    Verifying,
    ClosingBrowsers,
    Installing,
}

#[derive(Default)]
pub struct UpdateCoordinator(Mutex<()>);

fn release_highlights(body: Option<&str>) -> Vec<String> {
    let Some(body) = body else {
        return Vec::new();
    };
    let mut lines = body.lines().map(str::trim);
    if lines.find(|line| *line == "## Highlights").is_none() {
        return Vec::new();
    }
    lines
        .take_while(|line| !line.starts_with('#'))
        .filter_map(|line| line.strip_prefix("- ").map(str::trim))
        .filter(|line| !line.is_empty())
        .take(MAX_RELEASE_HIGHLIGHTS)
        .map(str::to_owned)
        .collect()
}

fn download_percent(downloaded: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|total| *total > 0)?;
    Some((downloaded.saturating_mul(100) / total).min(100) as u8)
}

fn download_failure_message(failure: DownloadFailure) -> &'static str {
    match failure {
        DownloadFailure::Stalled => DOWNLOAD_STALLED,
        DownloadFailure::Interrupted => DOWNLOAD_INTERRUPTED,
    }
}

/// No total time limit: the download policy ends only a transfer that stops receiving bytes.
/// Compression stays off so a resumed range matches the bytes already received.
/// The download reuses the route that won the update check: when the check
/// only succeeded through the system proxy, the download goes through it
/// too instead of connecting directly.
fn download_client(proxy_url: Option<&Url>) -> Result<Client, String> {
    let builder = Client::builder()
        .no_gzip()
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(user_agent());
    let builder = match proxy_url {
        Some(proxy_url) => builder
            .proxy(reqwest::Proxy::all(proxy_url.clone()).map_err(|error| error.to_string())?),
        None => builder.no_proxy(),
    };
    builder.build().map_err(|error| error.to_string())
}

fn parse_canonical_tag(tag: &str) -> Option<Version> {
    let version = Version::parse(tag.strip_prefix('v')?).ok()?;
    (format!("v{version}") == tag).then_some(version)
}

fn is_release_asset_url(url: &Url, tag: &str, name: &str) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path() == format!("/aliasmode/aliasmode/releases/download/{tag}/{name}")
}

fn release_manifest_url(release: &GithubRelease) -> Option<Url> {
    let manifests: Vec<&GithubAsset> = release
        .assets
        .iter()
        .filter(|asset| asset.name == UPDATE_MANIFEST)
        .collect();
    if manifests.len() != 1 {
        return None;
    }
    let url = Url::parse(&manifests[0].browser_download_url).ok()?;
    is_release_asset_url(&url, &release.tag_name, UPDATE_MANIFEST).then_some(url)
}

fn newest_release(current: &Version, releases: &[GithubRelease]) -> Option<ReleaseCandidate> {
    releases
        .iter()
        .filter(|release| !release.draft)
        .filter_map(|release| {
            let version = parse_canonical_tag(&release.tag_name)?;
            if release.prerelease == version.pre.is_empty()
                || (current.pre.is_empty() && !version.pre.is_empty())
                || (!version.pre.is_empty()
                    && current.pre.as_str().split('.').next()
                        != version.pre.as_str().split('.').next())
                || version <= *current
            {
                return None;
            }
            Some(ReleaseCandidate {
                tag: release.tag_name.clone(),
                version,
                manifest_url: release_manifest_url(release)?,
                highlights: release_highlights(release.body.as_deref()),
            })
        })
        .max_by(|left, right| left.version.cmp(&right.version))
}

fn user_agent() -> String {
    format!("AliasMode/{} release-updater", env!("CARGO_PKG_VERSION"))
}

/// Runs a short update request again once after a failure.
async fn retry_once<T, Operation, Attempt>(mut operation: Operation) -> Result<T, String>
where
    Operation: FnMut() -> Attempt,
    Attempt: std::future::Future<Output = Result<T, String>>,
{
    match operation().await {
        Ok(value) => Ok(value),
        Err(error) => {
            eprintln!("AliasMode update request failed, retrying once: {error}");
            tokio::time::sleep(CHECK_RETRY_DELAY).await;
            operation().await
        }
    }
}

/// A proxy the operating system is configured to use, detected the same way
/// the sidecar detects it for Cloud requests and engine downloads: the
/// Windows per-user proxy settings first, then the conventional environment
/// variables. Nothing detected (or a PAC-only configuration) means the
/// update traffic connects directly, exactly as it did before.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SystemProxy {
    host: String,
    port: u16,
    bypass: Vec<String>,
}

impl SystemProxy {
    fn url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }
}

fn is_loopback_host(host: &str) -> bool {
    let normalized = host.trim().trim_matches(['[', ']']).to_lowercase();
    normalized == "localhost" || normalized == "127.0.0.1" || normalized == "::1"
}

fn matches_bypass(host: &str, bypass: &[String]) -> bool {
    let name = host.trim().trim_matches(['[', ']']).to_lowercase();
    if name.is_empty() {
        return false;
    }
    bypass.iter().any(|raw| {
        let pattern = raw.trim().to_lowercase();
        if pattern.is_empty() {
            return false;
        }
        if pattern == "<local>" {
            return !name.contains('.');
        }
        let normalized = pattern
            .strip_prefix("*.")
            .or_else(|| pattern.strip_prefix('*'))
            .unwrap_or(&pattern);
        if pattern.starts_with("*.") {
            name == normalized || name.ends_with(&format!(".{normalized}"))
        } else {
            name == pattern
        }
    })
}

fn proxy_applies_to(host: &str, proxy: &SystemProxy) -> bool {
    !is_loopback_host(host) && !matches_bypass(host, &proxy.bypass)
}

fn normalize_proxy_address(raw: &str) -> Option<(String, u16)> {
    let mut value = raw.trim().to_string();
    if value.is_empty() {
        return None;
    }
    let entries: Vec<String> = value
        .split(';')
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect();
    if entries.iter().any(|entry| entry.contains('=')) {
        let pick = |scheme: &str| {
            entries.iter().find_map(|entry| {
                let (key, rest) = entry.split_once('=')?;
                key.trim()
                    .eq_ignore_ascii_case(scheme)
                    .then(|| rest.trim().to_string())
            })
        };
        value = pick("https").or_else(|| pick("http")).unwrap_or_default();
    }
    if value.is_empty() {
        return None;
    }
    let has_scheme = value.contains("://");
    let parsed = Url::parse(&if has_scheme {
        value.clone()
    } else {
        format!("http://{value}")
    })
    .ok()?;
    if !has_scheme && parsed.port().is_none() {
        return None;
    }
    let host = parsed.host_str()?.trim_matches(['[', ']']).to_string();
    if host.is_empty() {
        return None;
    }
    Some((host, parsed.port().unwrap_or(80)))
}

#[derive(Debug, Default)]
struct WindowsProxySettings {
    enabled: bool,
    proxy: Option<String>,
    bypass: Vec<String>,
    pac: bool,
}

fn registry_value(output: &str, name: &str) -> Option<String> {
    for line in output.lines() {
        let line = line.trim_start();
        let Some(rest) = line.strip_prefix(name) else {
            continue;
        };
        if !rest.chars().next().is_some_and(char::is_whitespace) {
            continue;
        }
        let rest = rest.trim_start();
        let Some(type_at) = rest.find("REG_") else {
            continue;
        };
        let value = rest[type_at..]
            .splitn(2, char::is_whitespace)
            .nth(1)?
            .trim()
            .to_string();
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

fn parse_windows_proxy_settings(output: &str) -> WindowsProxySettings {
    let enable = registry_value(output, "ProxyEnable");
    WindowsProxySettings {
        enabled: enable.as_deref() == Some("0x1") || enable.as_deref() == Some("1"),
        proxy: registry_value(output, "ProxyServer"),
        bypass: registry_value(output, "ProxyOverride")
            .map(|value| {
                value
                    .split(';')
                    .map(|entry| entry.trim().to_string())
                    .filter(|entry| !entry.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
        pac: registry_value(output, "AutoConfigURL").is_some(),
    }
}

enum WindowsProxy {
    NotApplicable,
    Pac,
    Found(SystemProxy),
    Missing,
}

fn read_windows_proxy() -> WindowsProxy {
    if !cfg!(target_os = "windows") {
        return WindowsProxy::NotApplicable;
    }
    let Ok(output) = std::process::Command::new("reg")
        .args([
            "query",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
        ])
        .output()
    else {
        return WindowsProxy::Missing;
    };
    if !output.status.success() {
        return WindowsProxy::Missing;
    }
    let settings = parse_windows_proxy_settings(&String::from_utf8_lossy(&output.stdout));
    if settings.pac {
        return WindowsProxy::Pac;
    }
    if !settings.enabled {
        return WindowsProxy::Missing;
    }
    let Some(raw) = settings.proxy else {
        return WindowsProxy::Missing;
    };
    match normalize_proxy_address(&raw) {
        Some((host, port)) => WindowsProxy::Found(SystemProxy {
            host,
            port,
            bypass: settings.bypass,
        }),
        None => WindowsProxy::Missing,
    }
}

fn detect_system_proxy() -> Option<SystemProxy> {
    match read_windows_proxy() {
        WindowsProxy::Pac => return None,
        WindowsProxy::Found(proxy) => return Some(proxy),
        WindowsProxy::NotApplicable | WindowsProxy::Missing => {}
    }
    let raw = std::env::var("HTTPS_PROXY")
        .or_else(|_| std::env::var("https_proxy"))
        .or_else(|_| std::env::var("HTTP_PROXY"))
        .or_else(|_| std::env::var("http_proxy"))
        .unwrap_or_default();
    let (host, port) = normalize_proxy_address(&raw)?;
    let bypass = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .unwrap_or_default()
        .split(',')
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect();
    Some(SystemProxy { host, port, bypass })
}

fn releases_client(proxy: Option<&SystemProxy>, timeout: Duration) -> Result<Client, String> {
    // The gzip feature asks GitHub to compress the list to about a tenth of its size.
    let builder = Client::builder()
        .redirect(Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .user_agent(user_agent());
    let builder = match proxy {
        Some(proxy) => {
            builder.proxy(reqwest::Proxy::all(proxy.url()).map_err(|error| error.to_string())?)
        }
        None => builder.no_proxy(),
    };
    builder.build().map_err(|error| error.to_string())
}

async fn send_releases_request(
    client: &Client,
    url: &str,
) -> Result<reqwest::Response, reqwest::Error> {
    client
        .get(url)
        .header(ACCEPT, "application/vnd.github+json")
        .send()
        .await
}

async fn read_releases(response: reqwest::Response) -> Result<Vec<GithubRelease>, String> {
    if !response.status().is_success() {
        return Err(format!("GitHub returned {}", response.status()));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

/// Direct first, like the sidecar: a transport failure on the direct
/// attempt is retried once through the detected system proxy, while any
/// HTTP response — even an error status — proves the direct route works.
/// When both routes fail, the direct error is the one reported.
async fn fetch_releases(url: &str, timeout: Duration) -> Result<Vec<GithubRelease>, String> {
    let direct = releases_client(None, timeout)?;
    let response = match send_releases_request(&direct, url).await {
        Ok(response) => response,
        Err(direct_error) => {
            let host = Url::parse(url)
                .ok()
                .and_then(|parsed| parsed.host_str().map(str::to_string));
            let Some(proxy) = host.as_deref().and_then(|host| {
                detect_system_proxy().filter(|proxy| proxy_applies_to(host, proxy))
            }) else {
                return Err(direct_error.to_string());
            };
            let proxied = releases_client(Some(&proxy), timeout)?;
            match send_releases_request(&proxied, url).await {
                Ok(response) => response,
                Err(_) => return Err(direct_error.to_string()),
            }
        }
    };
    read_releases(response).await
}

fn update_artifact_name(version: &Version) -> String {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        format!("AliasMode_{version}_aarch64.app.tar.gz")
    } else if cfg!(target_os = "macos") {
        format!("AliasMode_{version}_x64.app.tar.gz")
    } else if cfg!(target_os = "linux") {
        format!("AliasMode_{version}_x86_64-linux.tar.gz")
    } else {
        format!("AliasMode_{version}_x64-setup.exe")
    }
}

fn validate_manifest_result(
    candidate: &ReleaseCandidate,
    version: &str,
    target: &str,
    download_url: &Url,
    signature: &str,
    raw_json: &Value,
) -> Result<(), String> {
    let manifest_version = Version::parse(version).map_err(|error| error.to_string())?;
    if manifest_version != candidate.version || target != UPDATE_TARGET {
        return Err("release manifest identity did not match its GitHub release".to_owned());
    }

    if !is_release_asset_url(
        download_url,
        &candidate.tag,
        &update_artifact_name(&candidate.version),
    ) {
        return Err("release manifest installer URL was not an AliasMode release asset".to_owned());
    }

    let raw_version = raw_json
        .get("version")
        .and_then(Value::as_str)
        .and_then(|value| Version::parse(value.strip_prefix('v').unwrap_or(value)).ok())
        .ok_or_else(|| "release manifest version was invalid".to_owned())?;
    let platforms = raw_json
        .get("platforms")
        .and_then(Value::as_object)
        .ok_or_else(|| "release manifest platforms were invalid".to_owned())?;
    let platform = platforms
        .get(UPDATE_TARGET)
        .and_then(Value::as_object)
        .ok_or_else(|| "release manifest did not contain the update for this system".to_owned())?;
    let raw_url = platform
        .get("url")
        .and_then(Value::as_str)
        .and_then(|value| Url::parse(value).ok())
        .ok_or_else(|| "release manifest installer URL was invalid".to_owned())?;
    let raw_signature = platform
        .get("signature")
        .and_then(Value::as_str)
        .ok_or_else(|| "release manifest signature was invalid".to_owned())?;

    if raw_version != candidate.version
        || platforms.len() != 1
        || raw_url != *download_url
        || raw_signature != signature
        || signature.trim().is_empty()
    {
        return Err("release manifest contents were inconsistent".to_owned());
    }
    Ok(())
}

/// Build an updater on one route and ask it for the update. The caller
/// records which route won, so the installer download can reuse it.
async fn check_update_on_route(
    app: &AppHandle,
    handoff: Option<&InstallerHandoff>,
    candidate: &ReleaseCandidate,
    proxy_url: Option<Url>,
) -> Result<Update, String> {
    let builder = app.updater_builder().target(UPDATE_TARGET);
    let builder = match proxy_url {
        Some(proxy_url) => builder.proxy(proxy_url),
        None => builder.no_proxy(),
    };
    let builder = builder
        .configure_client(|client| {
            client
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(CHECK_TIMEOUT)
        })
        .version_comparator(|_, _| true);
    let builder = if let Some(handoff) = handoff {
        let app_handle = app.clone();
        let sidecar = app.state::<SidecarSupervisor>().inner().clone();
        builder
            .on_before_exit(move || {
                let _ = sidecar.kill_owned();
                app_handle.cleanup_before_exit();
            })
            .relaunch_args([handoff.relaunch_argument()])
            .clear_installer_args()
            .installer_args(handoff.installer_arguments())
    } else {
        builder
    };
    let updater = builder
        .endpoints(vec![candidate.manifest_url.clone()])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;
    retry_once(|| async { updater.check().await.map_err(|error| error.to_string()) })
        .await?
        .ok_or_else(|| "selected GitHub release returned no update".to_owned())
}

async fn discover_update(
    app: &AppHandle,
    handoff: Option<&InstallerHandoff>,
) -> Result<Option<DiscoveredUpdate>, String> {
    let current = Version::parse(env!("CARGO_PKG_VERSION")).map_err(|error| error.to_string())?;
    let releases = retry_once(|| fetch_releases(RELEASES_API, CHECK_TIMEOUT)).await?;
    let Some(candidate) = newest_release(&current, &releases) else {
        return Ok(None);
    };

    // Direct first, like the rest of the app: only a failed check is retried
    // once through the detected system proxy, and when both routes fail the
    // direct error is the one reported. The route that wins the check is the
    // route the installer download reuses.
    let (update, proxy_url) = match check_update_on_route(app, handoff, &candidate, None).await {
        Ok(update) => (update, None),
        Err(direct_error) => {
            let proxy_url = detect_system_proxy()
                .filter(|proxy| {
                    candidate
                        .manifest_url
                        .host_str()
                        .is_some_and(|host| proxy_applies_to(host, proxy))
                })
                .and_then(|proxy| Url::parse(&proxy.url()).ok());
            match proxy_url {
                Some(proxy_url) => (
                    check_update_on_route(app, handoff, &candidate, Some(proxy_url.clone()))
                        .await
                        .map_err(|_| direct_error)?,
                    Some(proxy_url),
                ),
                None => return Err(direct_error),
            }
        }
    };
    validate_manifest_result(
        &candidate,
        &update.version,
        &update.target,
        &update.download_url,
        &update.signature,
        &update.raw_json,
    )?;
    Ok(Some(DiscoveredUpdate {
        update,
        highlights: candidate.highlights,
        proxy_url,
    }))
}

#[tauri::command]
pub async fn check_for_updates(
    app: AppHandle,
    coordinator: tauri::State<'_, UpdateCoordinator>,
) -> Result<UpdateStatus, String> {
    if !cfg!(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    )) {
        return Err("AliasMode updates are not available on this system.".to_owned());
    }
    let _guard = coordinator
        .0
        .try_lock()
        .map_err(|_| UPDATE_BUSY.to_owned())?;
    let current_version = env!("CARGO_PKG_VERSION").to_owned();
    match discover_update(&app, None).await {
        Ok(Some(discovered)) => Ok(UpdateStatus::Available {
            current_version,
            version: discovered.update.version,
            highlights: discovered.highlights,
        }),
        Ok(None) => Ok(UpdateStatus::UpToDate { current_version }),
        Err(error) => {
            eprintln!("AliasMode update check failed: {error}");
            Err(CHECK_FAILED.to_owned())
        }
    }
}

#[tauri::command]
pub fn last_update_result(app: AppHandle) -> Result<Option<LastUpdateResult>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "AliasMode could not read the last update result.".to_owned())?;
    update_attempt::last_update_result(&data_dir)
        .map_err(|_| "AliasMode could not read the last update result.".to_owned())
}

fn restart_after_install_failure(app: AppHandle, error: impl std::fmt::Display) {
    eprintln!("AliasMode update installation failed: {error}");
    app.dialog()
        .message("AliasMode could not start the verified update. The current version will restart.")
        .title("AliasMode update failed")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::Ok)
        .show(move |_| app.request_restart());
}

fn record_update_failure(
    data_dir: &std::path::Path,
    attempt_id: &str,
    reason: UpdateFailureReason,
) {
    if update_attempt::record_failure(data_dir, attempt_id, reason).is_err() {
        eprintln!("AliasMode could not store the failed update result");
    }
}

/// Keeps the cause of a failed update step. The app writes its error text only to its
/// standard error, and that is lost when the app starts from the desktop.
fn log_update_failure(data_dir: &std::path::Path, version: &str, step: &str, error: &str) {
    use std::io::Write;
    let logs = data_dir.join("logs");
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let written = std::fs::create_dir_all(&logs).and_then(|()| {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs.join("desktop-update.log"))?;
        writeln!(
            file,
            "{seconds} update from {} to {version} failed at the {step} step: {error}",
            env!("CARGO_PKG_VERSION")
        )
    });
    if written.is_err() {
        eprintln!("AliasMode could not store the cause of the failed update");
    }
}

#[derive(Debug, PartialEq)]
enum UpdatePreparationError {
    Download(String),
    Prepare(String),
    Cleanup(String),
    Install(String),
}

async fn run_verified_update<Download, Prepare, Cleanup, Install>(
    download: Download,
    prepare: Prepare,
    cleanup: Cleanup,
    install: Install,
) -> Result<(), UpdatePreparationError>
where
    Download: std::future::Future<Output = Result<Vec<u8>, String>>,
    Prepare: std::future::Future<Output = Result<(), String>>,
    Cleanup: std::future::Future<Output = Result<(), String>>,
    Install: FnOnce(&[u8]) -> Result<(), String>,
{
    let bytes = download.await.map_err(UpdatePreparationError::Download)?;
    prepare.await.map_err(UpdatePreparationError::Prepare)?;
    cleanup.await.map_err(UpdatePreparationError::Cleanup)?;
    install(&bytes).map_err(UpdatePreparationError::Install)
}

/// Windows: the NSIS installer takes over and ends this process, so a return is a failure.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn install_verified_update(
    update: &Update,
    bytes: &[u8],
    _app: &AppHandle,
    _handoff: &InstallerHandoff,
) -> Result<(), String> {
    update.install(bytes).map_err(|error| error.to_string())?;
    Err("the verified installer returned without transferring control".to_owned())
}

/// macOS and Linux: the app bundle or folder is swapped and the call returns; nothing
/// restarts the app for us.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn install_verified_update(
    update: &Update,
    bytes: &[u8],
    app: &AppHandle,
    handoff: &InstallerHandoff,
) -> Result<(), String> {
    // Started first, so the relaunch still happens if this process dies during the swap.
    let mut relaunch =
        update_attempt::spawn_relaunch_after_exit(handoff).map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    let installed = update.install(bytes).map_err(|error| error.to_string());
    // The updater's own Linux step replaces an AppImage file; this app is a folder.
    #[cfg(target_os = "linux")]
    let installed = {
        let _ = update;
        update_attempt::replace_linux_install(&handoff.canonical_root, bytes)
            .map_err(|error| error.to_string())
    };
    if let Err(error) = installed {
        let _ = relaunch.kill();
        return Err(error);
    }
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn update_now(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: tauri::State<'_, SidecarSupervisor>,
    coordinator: tauri::State<'_, UpdateCoordinator>,
    on_progress: Channel<UpdateProgress>,
) -> Result<(), String> {
    if !cfg!(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    )) {
        return Err("AliasMode updates are not available on this system.".to_owned());
    }
    let _guard = coordinator
        .0
        .try_lock()
        .map_err(|_| UPDATE_BUSY.to_owned())?;
    let _ = on_progress.send(UpdateProgress::Preparing);
    let handoff = InstallerHandoff::prepare().map_err(|error| {
        eprintln!("AliasMode update install-root preparation failed: {error}");
        INSTALLATION_UNSAFE.to_owned()
    })?;
    let data_dir = app.path().app_data_dir().map_err(|_| {
        eprintln!("AliasMode update app-data path was unavailable");
        INSTALLATION_UNSAFE.to_owned()
    })?;
    let discovered = match discover_update(&app, cfg!(windows).then_some(&handoff)).await {
        Ok(Some(discovered)) => discovered,
        Ok(None) => return Err("AliasMode is already up to date.".to_owned()),
        Err(error) => {
            eprintln!("AliasMode update recheck failed: {error}");
            log_update_failure(&data_dir, "the newest release", "check", &error);
            return Err(CHECK_FAILED.to_owned());
        }
    };
    let _ = on_progress.send(UpdateProgress::Ready {
        version: discovered.update.version.clone(),
        highlights: discovered.highlights,
    });
    let download_proxy_url = discovered.proxy_url.clone();
    let update = discovered.update;
    let expected_version = update.version.clone();
    let sidecar = sidecar.inner().clone();
    let download_progress = on_progress.clone();
    let verifying_progress = on_progress.clone();
    let download_data_dir = data_dir.clone();
    let cleanup_progress = on_progress.clone();
    let install_progress = on_progress.clone();
    let install_window = window.clone();
    let preparation_handoff = handoff.clone();
    let install_handoff = handoff.clone();
    let install_app = app.clone();
    let preparation_data_dir = data_dir.clone();
    let preparation_version = expected_version.clone();
    match run_verified_update(
        async {
            let log = |step: &str, error: &str| {
                eprintln!("AliasMode update {step} failed: {error}");
                log_update_failure(&download_data_dir, &expected_version, step, error);
            };
            let client = download_client(download_proxy_url.as_ref()).map_err(|error| {
                log("download", &error);
                DOWNLOAD_INTERRUPTED.to_owned()
            })?;
            let mut last_reported = None;
            let bytes = update_download::download(
                &client,
                &update.download_url,
                &UPDATE_DOWNLOAD_POLICY,
                |event| match event {
                    DownloadEvent::Progress { downloaded, total } => {
                        // Report each percent and each megabyte, so a slow link still moves.
                        let percent = download_percent(downloaded, total);
                        let shown = (percent, downloaded / 1_000_000);
                        if last_reported != Some(shown) {
                            let _ = download_progress.send(UpdateProgress::Downloading {
                                percent,
                                downloaded_bytes: downloaded,
                                total_bytes: total,
                            });
                            last_reported = Some(shown);
                        }
                    }
                    DownloadEvent::Retrying => {
                        let _ = download_progress.send(UpdateProgress::Reconnecting);
                        last_reported = None;
                    }
                },
            )
            .await
            .map_err(|error| {
                log("download", &error.to_string());
                download_failure_message(error.failure).to_owned()
            })?;
            let _ = verifying_progress.send(UpdateProgress::Verifying);
            // The same key and check as before; only the transfer is the app's own.
            update.verify(&bytes).map_err(|error| {
                log("signature check", &error.to_string());
                VERIFY_FAILED.to_owned()
            })?;
            Ok(bytes)
        },
        async move {
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            update_attempt::validate_registered_install(
                &preparation_handoff,
                env!("CARGO_PKG_VERSION"),
            )
            .map_err(|error| error.to_string())?;
            update_attempt::begin_attempt(
                &preparation_data_dir,
                &preparation_handoff,
                env!("CARGO_PKG_VERSION"),
                &preparation_version,
            )
            .map_err(|error| error.to_string())
        },
        async {
            let _ = cleanup_progress.send(UpdateProgress::ClosingBrowsers);
            shutdown::graceful_sidecar_cleanup(&sidecar).await
        },
        |bytes| {
            let _ = install_progress.send(UpdateProgress::Installing);
            let _ = install_window.hide();
            install_verified_update(&update, bytes, &install_app, &install_handoff)
        },
    )
    .await
    {
        // macOS and Linux: the app is replaced and this process is exiting for the relaunch.
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        Ok(()) => Ok(()),
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        Ok(()) => {
            record_update_failure(&data_dir, &handoff.id, UpdateFailureReason::InstallerLaunch);
            let _ = window.show();
            let _ = window.set_focus();
            restart_after_install_failure(app, "the installer returned unexpectedly");
            Err(INSTALL_FAILED.to_owned())
        }
        // The download step already logged its cause and chose the message.
        Err(UpdatePreparationError::Download(message)) => Err(message),
        Err(UpdatePreparationError::Prepare(error)) => {
            eprintln!("AliasMode update install-root validation failed: {error}");
            Err(INSTALLATION_UNSAFE.to_owned())
        }
        Err(UpdatePreparationError::Cleanup(error)) => {
            eprintln!("AliasMode update browser cleanup failed: {error}");
            record_update_failure(&data_dir, &handoff.id, UpdateFailureReason::BrowserCleanup);
            shutdown::exit_after_update_cleanup_failure(app, &sidecar, error);
            Err(CLEANUP_FAILED.to_owned())
        }
        Err(UpdatePreparationError::Install(error)) => {
            record_update_failure(&data_dir, &handoff.id, UpdateFailureReason::InstallerLaunch);
            log_update_failure(&data_dir, &expected_version, "install", &error);
            let _ = window.show();
            let _ = window.set_focus();
            restart_after_install_failure(app, error);
            Err(INSTALL_FAILED.to_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        download_failure_message, download_percent, fetch_releases, is_release_asset_url,
        log_update_failure, newest_release, normalize_proxy_address, parse_windows_proxy_settings,
        proxy_applies_to, release_highlights, retry_once, run_verified_update,
        update_artifact_name, validate_manifest_result, DownloadFailure, GithubAsset,
        GithubRelease, ReleaseCandidate, SystemProxy, UpdateCoordinator, UpdatePreparationError,
        UpdateProgress, UpdateStatus, CHECK_FAILED, CHECK_TIMEOUT, DOWNLOAD_INTERRUPTED,
        DOWNLOAD_STALLED, UPDATE_MANIFEST, UPDATE_TARGET,
    };
    use semver::Version;
    use serde_json::json;
    use std::cell::Cell;
    use url::Url;

    #[test]
    fn windows_proxy_output_is_parsed_without_interpreting_pac_settings() {
        let parsed = parse_windows_proxy_settings(
            "\n    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ       http=proxy.example:80;https=secure.example:443\n    ProxyOverride  REG_SZ       <local>;*.example.test\n",
        );
        assert!(parsed.enabled);
        assert_eq!(
            parsed.proxy.as_deref(),
            Some("http=proxy.example:80;https=secure.example:443")
        );
        assert_eq!(
            parsed.bypass,
            vec!["<local>".to_string(), "*.example.test".to_string()]
        );
        assert!(!parsed.pac);
        assert!(
            parse_windows_proxy_settings("    AutoConfigURL    REG_SZ    http://proxy/pac.js\n")
                .pac
        );
        assert!(!parse_windows_proxy_settings("    ProxyEnable    REG_DWORD    0x0\n").enabled);
    }

    #[test]
    fn system_proxy_addresses_normalize_like_the_sidecar() {
        assert_eq!(
            normalize_proxy_address(" http://proxy.example:8080 "),
            Some(("proxy.example".to_string(), 8080))
        );
        assert_eq!(
            normalize_proxy_address("http=old.example:80; https=new.example:443"),
            Some(("new.example".to_string(), 443))
        );
        assert_eq!(normalize_proxy_address("broken"), None);
        assert_eq!(normalize_proxy_address(""), None);
    }

    #[test]
    fn system_proxy_applies_unless_bypassed_or_loopback() {
        let proxy = SystemProxy {
            host: "proxy.example".to_string(),
            port: 20122,
            bypass: vec!["*.example.test".to_string(), "<local>".to_string()],
        };
        assert!(proxy_applies_to("api.github.com", &proxy));
        assert!(!proxy_applies_to("service.example.test", &proxy));
        assert!(!proxy_applies_to("printer", &proxy));
        assert!(!proxy_applies_to("localhost", &proxy));
        assert!(!proxy_applies_to("127.0.0.1", &proxy));
    }

    fn manifest_url(tag: &str) -> String {
        format!("https://github.com/aliasmode/aliasmode/releases/download/{tag}/{UPDATE_MANIFEST}")
    }

    fn release(tag: &str, draft: bool, prerelease: bool, manifest_count: usize) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_owned(),
            draft,
            prerelease,
            body: None,
            assets: (0..manifest_count)
                .map(|_| GithubAsset {
                    name: UPDATE_MANIFEST.to_owned(),
                    browser_download_url: manifest_url(tag),
                })
                .collect(),
        }
    }

    fn candidate(version: &str) -> ReleaseCandidate {
        let tag = format!("v{version}");
        ReleaseCandidate {
            manifest_url: Url::parse(&manifest_url(&tag)).unwrap(),
            tag,
            version: Version::parse(version).unwrap(),
            highlights: Vec::new(),
        }
    }

    fn update_json(version: &str, url: &str, signature: &str) -> serde_json::Value {
        json!({
            "version": version,
            "platforms": {
                UPDATE_TARGET: {
                    "url": url,
                    "signature": signature,
                }
            }
        })
    }

    #[test]
    fn extracts_only_curated_release_highlights() {
        let body = "Intro text\n\n## Highlights\n- Faster updates\n- Clear progress\n- Better tabs\n- Hidden fourth item\n\n## Details\n- Internal work";
        assert_eq!(
            release_highlights(Some(body)),
            ["Faster updates", "Clear progress", "Better tabs"]
        );
    }

    #[test]
    fn ignores_release_bodies_without_the_highlights_section() {
        assert!(release_highlights(None).is_empty());
        assert!(release_highlights(Some("## Changes\n- Not curated")).is_empty());
        assert!(release_highlights(Some("## highlights\n- Wrong heading")).is_empty());
    }

    #[test]
    fn selected_release_keeps_its_own_highlights() {
        let current = Version::parse("0.1.0-beta.35").unwrap();
        let mut older = release("v0.1.0-beta.36", false, true, 1);
        older.body = Some("## Highlights\n- Older change".to_owned());
        let mut newest = release("v0.1.0-beta.37", false, true, 1);
        newest.body = Some("## Highlights\n- Newest change".to_owned());

        assert_eq!(
            newest_release(&current, &[newest, older])
                .unwrap()
                .highlights,
            ["Newest change"]
        );
    }

    #[test]
    fn beta_selects_newest_beta_or_stable_release() {
        let current = Version::parse("0.1.0-beta.35").unwrap();
        let releases = vec![
            release("v0.1.0-beta.36", false, true, 1),
            release("v0.1.0", false, false, 1),
            release("v9.0.0", true, false, 1),
        ];
        assert_eq!(
            newest_release(&current, &releases).unwrap().version,
            Version::parse("0.1.0").unwrap()
        );
    }

    #[test]
    fn beta_rejects_other_prerelease_channels() {
        let current = Version::parse("0.1.0-beta.35").unwrap();
        for incompatible in [
            release("v0.1.0-rc.1", false, true, 1),
            release("v0.2.0-alpha.1", false, true, 1),
        ] {
            assert!(newest_release(&current, &[incompatible]).is_none());
        }
        assert_eq!(
            newest_release(&current, &[release("v0.2.0-beta.1", false, true, 1)])
                .unwrap()
                .version,
            Version::parse("0.2.0-beta.1").unwrap()
        );
    }

    #[test]
    fn stable_ignores_prereleases() {
        let current = Version::parse("1.0.0").unwrap();
        let releases = vec![
            release("v2.0.0-beta.1", false, true, 1),
            release("v1.1.0", false, false, 1),
        ];
        assert_eq!(
            newest_release(&current, &releases).unwrap().version,
            Version::parse("1.1.0").unwrap()
        );
    }

    #[test]
    fn ignores_invalid_release_metadata() {
        let current = Version::parse("0.1.0-beta.35").unwrap();
        for invalid in [
            release("0.1.0-beta.36", false, true, 1),
            release("v0.1.0-beta.36", true, true, 1),
            release("v0.1.0-beta.36", false, false, 1),
            release("v0.1.0-beta.36", false, true, 0),
            release("v0.1.0-beta.36", false, true, 2),
        ] {
            assert!(newest_release(&current, &[invalid]).is_none());
        }
    }

    #[test]
    fn accepts_only_exact_aliasmode_release_asset_urls() {
        let tag = "v0.1.0-beta.36";
        let valid = Url::parse(&manifest_url(tag)).unwrap();
        assert!(is_release_asset_url(&valid, tag, UPDATE_MANIFEST));
        for invalid in [
            "http://github.com/aliasmode/aliasmode/releases/download/v0.1.0-beta.36/latest-v2.json",
            "https://example.com/aliasmode/aliasmode/releases/download/v0.1.0-beta.36/latest-v2.json",
            "https://github.com/other/aliasmode/releases/download/v0.1.0-beta.36/latest-v2.json",
            "https://github.com/aliasmode/aliasmode/releases/download/v0.1.0-beta.36/latest-v2.json?raw=1",
        ] {
            assert!(!is_release_asset_url(
                &Url::parse(invalid).unwrap(),
                tag,
                UPDATE_MANIFEST
            ));
        }
    }

    #[test]
    fn ignores_the_legacy_manifest_seen_by_beta46() {
        let current = Version::parse("0.1.0-beta.47").unwrap();
        let tag = "v0.1.0-beta.48";
        let legacy = GithubRelease {
            tag_name: tag.to_owned(),
            draft: false,
            prerelease: true,
            body: None,
            assets: vec![GithubAsset {
                name: "latest.json".to_owned(),
                browser_download_url: format!(
                    "https://github.com/aliasmode/aliasmode/releases/download/{tag}/latest.json"
                ),
            }],
        };

        assert!(newest_release(&current, &[legacy]).is_none());
    }

    #[test]
    fn binds_manifest_to_release_version_target_and_installer() {
        let candidate = candidate("0.1.0-beta.36");
        let installer = format!(
            "https://github.com/aliasmode/aliasmode/releases/download/v0.1.0-beta.36/{}",
            update_artifact_name(&candidate.version)
        );
        let installer = installer.as_str();
        let url = Url::parse(installer).unwrap();
        let raw = update_json("0.1.0-beta.36", installer, "signed");
        assert!(validate_manifest_result(
            &candidate,
            "0.1.0-beta.36",
            UPDATE_TARGET,
            &url,
            "signed",
            &raw,
        )
        .is_ok());

        let wrong_version = update_json("0.1.0-beta.37", installer, "signed");
        assert!(validate_manifest_result(
            &candidate,
            "0.1.0-beta.36",
            UPDATE_TARGET,
            &url,
            "signed",
            &wrong_version,
        )
        .is_err());
    }

    #[test]
    fn failed_verified_download_cannot_start_preparation_cleanup_or_install() {
        let preparation_started = Cell::new(false);
        let cleanup_started = Cell::new(false);
        let install_started = Cell::new(false);
        let result = tauri::async_runtime::block_on(run_verified_update(
            async { Err::<Vec<u8>, String>("bad signature".to_owned()) },
            async {
                preparation_started.set(true);
                Ok(())
            },
            async {
                cleanup_started.set(true);
                Ok(())
            },
            |_| {
                install_started.set(true);
                Ok(())
            },
        ));
        assert_eq!(
            result,
            Err(UpdatePreparationError::Download("bad signature".to_owned()))
        );
        assert!(!preparation_started.get());
        assert!(!cleanup_started.get());
        assert!(!install_started.get());
    }

    #[test]
    fn every_update_stage_runs_in_order_after_verified_download() {
        let stage = Cell::new(0);
        let result = tauri::async_runtime::block_on(run_verified_update(
            async {
                stage.set(1);
                Ok(vec![1, 2, 3])
            },
            async {
                assert_eq!(stage.get(), 1);
                stage.set(2);
                Ok(())
            },
            async {
                assert_eq!(stage.get(), 2);
                stage.set(3);
                Ok(())
            },
            |bytes| {
                assert_eq!(stage.get(), 3);
                assert_eq!(bytes, [1, 2, 3]);
                stage.set(4);
                Ok(())
            },
        ));
        assert_eq!(result, Ok(()));
        assert_eq!(stage.get(), 4);
    }

    #[test]
    fn preparation_failure_cannot_start_cleanup_or_install() {
        let cleanup_started = Cell::new(false);
        let install_started = Cell::new(false);
        let result = tauri::async_runtime::block_on(run_verified_update(
            async { Ok(vec![1, 2, 3]) },
            async { Err("install root mismatch".to_owned()) },
            async {
                cleanup_started.set(true);
                Ok(())
            },
            |_| {
                install_started.set(true);
                Ok(())
            },
        ));
        assert_eq!(
            result,
            Err(UpdatePreparationError::Prepare(
                "install root mismatch".to_owned(),
            ))
        );
        assert!(!cleanup_started.get());
        assert!(!install_started.get());
    }

    #[test]
    fn cleanup_failure_cannot_start_install() {
        let install_started = Cell::new(false);
        let result = tauri::async_runtime::block_on(run_verified_update(
            async { Ok(vec![1, 2, 3]) },
            async { Ok(()) },
            async { Err("browser cleanup unconfirmed".to_owned()) },
            |_| {
                install_started.set(true);
                Ok(())
            },
        ));
        assert_eq!(
            result,
            Err(UpdatePreparationError::Cleanup(
                "browser cleanup unconfirmed".to_owned(),
            ))
        );
        assert!(!install_started.get());
    }

    #[test]
    fn install_failure_is_not_reported_as_success() {
        let result = tauri::async_runtime::block_on(run_verified_update(
            async { Ok(vec![1, 2, 3]) },
            async { Ok(()) },
            async { Ok(()) },
            |_| Err("installer could not start".to_owned()),
        ));
        assert_eq!(
            result,
            Err(UpdatePreparationError::Install(
                "installer could not start".to_owned(),
            ))
        );
    }

    #[test]
    fn calculates_bounded_download_percentages() {
        assert_eq!(download_percent(25, Some(100)), Some(25));
        assert_eq!(download_percent(150, Some(100)), Some(100));
        assert_eq!(download_percent(25, Some(0)), None);
        assert_eq!(download_percent(25, None), None);
    }

    #[test]
    fn serializes_update_progress_for_the_ipc_channel() {
        assert_eq!(
            serde_json::to_value(UpdateProgress::Preparing).unwrap(),
            json!({ "phase": "preparing" })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Ready {
                version: "0.1.0-beta.37".to_owned(),
                highlights: vec!["Newest change".to_owned()],
            })
            .unwrap(),
            json!({
                "phase": "ready",
                "version": "0.1.0-beta.37",
                "highlights": ["Newest change"],
            })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Downloading {
                percent: Some(42),
                downloaded_bytes: 42,
                total_bytes: Some(100),
            })
            .unwrap(),
            json!({ "phase": "downloading", "percent": 42, "downloadedBytes": 42, "totalBytes": 100 })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Downloading {
                percent: None,
                downloaded_bytes: 7,
                total_bytes: None,
            })
            .unwrap(),
            json!({ "phase": "downloading", "percent": null, "downloadedBytes": 7, "totalBytes": null })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Reconnecting).unwrap(),
            json!({ "phase": "reconnecting" })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Verifying).unwrap(),
            json!({ "phase": "verifying" })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::ClosingBrowsers).unwrap(),
            json!({ "phase": "closingBrowsers" })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Installing).unwrap(),
            json!({ "phase": "installing" })
        );
    }

    #[test]
    fn keeps_the_cause_of_a_failed_install() {
        let directory = tempfile::tempdir().unwrap();
        log_update_failure(
            directory.path(),
            "0.1.0-beta.99",
            "install",
            "Operation not permitted (os error 1)",
        );
        log_update_failure(
            directory.path(),
            "0.1.0-beta.99",
            "download",
            "second failure",
        );
        let text =
            std::fs::read_to_string(directory.path().join("logs/desktop-update.log")).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with(
            "to 0.1.0-beta.99 failed at the install step: Operation not permitted (os error 1)"
        ));
        assert!(lines[1].ends_with("to 0.1.0-beta.99 failed at the download step: second failure"));
    }

    #[test]
    fn coordinator_rejects_overlapping_operations() {
        let coordinator = UpdateCoordinator::default();
        let _operation = coordinator.0.try_lock().unwrap();
        assert!(coordinator.0.try_lock().is_err());
    }

    #[test]
    fn serializes_only_safe_update_status_fields() {
        let status = UpdateStatus::Available {
            current_version: "0.1.0-beta.35".to_owned(),
            version: "0.1.0-beta.36".to_owned(),
            highlights: vec!["Faster updates".to_owned()],
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            json!({
                "state": "available",
                "currentVersion": "0.1.0-beta.35",
                "version": "0.1.0-beta.36",
                "highlights": ["Faster updates"],
            }),
        );
    }

    #[test]
    fn download_failures_name_the_download_step_not_the_check() {
        assert_eq!(
            download_failure_message(DownloadFailure::Stalled),
            DOWNLOAD_STALLED
        );
        assert_eq!(
            download_failure_message(DownloadFailure::Interrupted),
            DOWNLOAD_INTERRUPTED
        );
        for message in [DOWNLOAD_STALLED, DOWNLOAD_INTERRUPTED] {
            assert_ne!(message, CHECK_FAILED);
            assert!(message.contains("download"));
            assert!(message.contains("Your browsers are still open."));
        }
    }

    #[test]
    fn retries_a_failed_update_request_once() {
        let attempts = std::cell::Cell::new(0);
        let result = tauri::async_runtime::block_on(retry_once(|| {
            attempts.set(attempts.get() + 1);
            let attempt = attempts.get();
            async move {
                if attempt == 1 {
                    Err("timed out".to_owned())
                } else {
                    Ok(attempt)
                }
            }
        }));
        assert_eq!(result, Ok(2));

        attempts.set(0);
        let result = tauri::async_runtime::block_on(retry_once(|| {
            attempts.set(attempts.get() + 1);
            async { Err::<(), _>("still down".to_owned()) }
        }));
        assert_eq!(result, Err("still down".to_owned()));
        assert_eq!(attempts.get(), 2);
    }

    /// Serves a release list of `size` bytes at about `bytes_per_second`, like a slow link.
    fn serve_slow_release_list(size: usize, bytes_per_second: usize) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/releases", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                std::thread::spawn(move || {
                    let mut request = Vec::new();
                    let mut byte = [0_u8; 1];
                    while !request.ends_with(b"\r\n\r\n")
                        && stream.read(&mut byte).unwrap_or(0) == 1
                    {
                        request.push(byte[0]);
                    }
                    let release = r#"{"tag_name":"v0.1.0-beta.99","draft":false,"prerelease":true,"body":"","assets":[]}"#;
                    let padding = size.saturating_sub(release.len() + 2);
                    let body = format!("[{release}{}]", " ".repeat(padding));
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                        body.len()
                    );
                    let step = bytes_per_second / 10;
                    for chunk in body.as_bytes().chunks(step) {
                        if stream.write_all(chunk).is_err() {
                            return;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                });
            }
        });
        url
    }

    #[test]
    fn the_old_five_second_check_fails_on_a_slow_link_and_the_new_limit_finishes() {
        // About 400 KB at 64 KB/s (512 kbit/s) takes about 6.5 s.
        let url = serve_slow_release_list(416_000, 64_000);
        let old =
            tauri::async_runtime::block_on(fetch_releases(&url, std::time::Duration::from_secs(5)));
        assert!(old.is_err(), "the old limit unexpectedly finished");
        let new = tauri::async_runtime::block_on(fetch_releases(&url, CHECK_TIMEOUT)).unwrap();
        assert_eq!(new.len(), 1);
        assert_eq!(new[0].tag_name, "v0.1.0-beta.99");
    }
}

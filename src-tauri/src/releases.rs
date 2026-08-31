use crate::{
    shutdown,
    sidecar::SidecarSupervisor,
    update_attempt::{self, InstallerHandoff, LastUpdateResult, UpdateFailureReason},
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
const UPDATE_MANIFEST: &str = "latest-v2.json";
const UPDATE_TARGET: &str = "windows-x86_64";
const MAX_RELEASE_HIGHLIGHTS: usize = 3;
const UPDATE_BUSY: &str = "An update operation is already running.";
const CHECK_FAILED: &str = "AliasMode could not check for updates. Try again.";
const DOWNLOAD_FAILED: &str = "AliasMode could not download and verify the update. Try again.";
const INSTALLATION_UNSAFE: &str = "AliasMode cannot safely update this installation. Close AliasMode and run the full offline installer from the release page. Do not uninstall.";
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
    },
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

async fn fetch_releases() -> Result<Vec<GithubRelease>, String> {
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(5))
        .user_agent(format!(
            "AliasMode/{} release-updater",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(RELEASES_API)
        .header(ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("GitHub returned {}", response.status()));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
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

    let installer_name = format!("AliasMode_{}_x64-setup.exe", candidate.version);
    if !is_release_asset_url(download_url, &candidate.tag, &installer_name) {
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
        .ok_or_else(|| "release manifest did not contain the Windows x64 update".to_owned())?;
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

async fn discover_update(
    app: &AppHandle,
    handoff: Option<&InstallerHandoff>,
) -> Result<Option<DiscoveredUpdate>, String> {
    let current = Version::parse(env!("CARGO_PKG_VERSION")).map_err(|error| error.to_string())?;
    let releases = fetch_releases().await?;
    let Some(candidate) = newest_release(&current, &releases) else {
        return Ok(None);
    };

    let builder = app
        .updater_builder()
        .target(UPDATE_TARGET)
        .no_proxy()
        .configure_client(|client| {
            client
                .connect_timeout(Duration::from_secs(10))
                .read_timeout(Duration::from_secs(30))
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
    let update = updater
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "selected GitHub release returned no update".to_owned())?;
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
    }))
}

#[tauri::command]
pub async fn check_for_updates(
    app: AppHandle,
    coordinator: tauri::State<'_, UpdateCoordinator>,
) -> Result<UpdateStatus, String> {
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

#[tauri::command]
pub async fn update_now(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: tauri::State<'_, SidecarSupervisor>,
    coordinator: tauri::State<'_, UpdateCoordinator>,
    on_progress: Channel<UpdateProgress>,
) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("AliasMode updates are available only in the Windows desktop app.".to_owned());
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
    let discovered = match discover_update(&app, Some(&handoff)).await {
        Ok(Some(discovered)) => discovered,
        Ok(None) => return Err("AliasMode is already up to date.".to_owned()),
        Err(error) => {
            eprintln!("AliasMode update recheck failed: {error}");
            return Err(CHECK_FAILED.to_owned());
        }
    };
    let _ = on_progress.send(UpdateProgress::Ready {
        version: discovered.update.version.clone(),
        highlights: discovered.highlights,
    });
    let update = discovered.update;
    let expected_version = update.version.clone();
    let sidecar = sidecar.inner().clone();
    let download_progress = on_progress.clone();
    let verifying_progress = on_progress.clone();
    let cleanup_progress = on_progress.clone();
    let install_progress = on_progress.clone();
    let install_window = window.clone();
    let preparation_handoff = handoff.clone();
    let preparation_data_dir = data_dir.clone();
    let preparation_version = expected_version.clone();
    match run_verified_update(
        async {
            let mut downloaded = 0_u64;
            let mut last_reported = None;
            update
                .download(
                    move |chunk_length, content_length| {
                        downloaded = downloaded.saturating_add(chunk_length as u64);
                        let percent = download_percent(downloaded, content_length);
                        if last_reported != Some(percent) {
                            let _ = download_progress.send(UpdateProgress::Downloading { percent });
                            last_reported = Some(percent);
                        }
                    },
                    move || {
                        let _ = verifying_progress.send(UpdateProgress::Verifying);
                    },
                )
                .await
                .map_err(|error| error.to_string())
        },
        async move {
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
            update.install(bytes).map_err(|error| error.to_string())?;
            Err("the verified installer returned without transferring control".to_owned())
        },
    )
    .await
    {
        Ok(()) => {
            record_update_failure(&data_dir, &handoff.id, UpdateFailureReason::InstallerLaunch);
            let _ = window.show();
            let _ = window.set_focus();
            restart_after_install_failure(app, "the installer returned unexpectedly");
            Err(INSTALL_FAILED.to_owned())
        }
        Err(UpdatePreparationError::Download(error)) => {
            eprintln!("AliasMode update download or signature verification failed: {error}");
            Err(DOWNLOAD_FAILED.to_owned())
        }
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
        download_percent, is_release_asset_url, newest_release, release_highlights,
        run_verified_update, validate_manifest_result, GithubAsset, GithubRelease,
        ReleaseCandidate, UpdateCoordinator, UpdatePreparationError, UpdateProgress, UpdateStatus,
        UPDATE_MANIFEST, UPDATE_TARGET,
    };
    use semver::Version;
    use serde_json::json;
    use std::cell::Cell;
    use url::Url;

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
        let installer = "https://github.com/aliasmode/aliasmode/releases/download/v0.1.0-beta.36/AliasMode_0.1.0-beta.36_x64-setup.exe";
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
            serde_json::to_value(UpdateProgress::Downloading { percent: Some(42) }).unwrap(),
            json!({ "phase": "downloading", "percent": 42 })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Downloading { percent: None }).unwrap(),
            json!({ "phase": "downloading", "percent": null })
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
}

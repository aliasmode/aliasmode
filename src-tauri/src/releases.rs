use crate::{shutdown, sidecar::SidecarSupervisor};
use reqwest::{header::ACCEPT, redirect::Policy, Client};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;
use url::Url;

const RELEASES_API: &str = "https://api.github.com/repos/aliasmode/aliasmode/releases?per_page=10";
const UPDATE_TARGET: &str = "windows-x86_64";
const UPDATE_BUSY: &str = "An update operation is already running.";
const CHECK_FAILED: &str = "AliasMode could not check for updates. Try again.";
const DOWNLOAD_FAILED: &str = "AliasMode could not download and verify the update. Try again.";

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
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Clone, PartialEq)]
struct ReleaseCandidate {
    tag: String,
    version: Version,
    manifest_url: Url,
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
    },
}

#[derive(Default)]
pub struct UpdateCoordinator(Mutex<()>);

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
        .filter(|asset| asset.name == "latest.json")
        .collect();
    if manifests.len() != 1 {
        return None;
    }
    let url = Url::parse(&manifests[0].browser_download_url).ok()?;
    is_release_asset_url(&url, &release.tag_name, "latest.json").then_some(url)
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

async fn discover_update(app: &AppHandle) -> Result<Option<Update>, String> {
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
    Ok(Some(update))
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
    match discover_update(&app).await {
        Ok(Some(update)) => Ok(UpdateStatus::Available {
            current_version,
            version: update.version,
        }),
        Ok(None) => Ok(UpdateStatus::UpToDate { current_version }),
        Err(error) => {
            eprintln!("AliasMode update check failed: {error}");
            Err(CHECK_FAILED.to_owned())
        }
    }
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

#[derive(Debug, PartialEq)]
enum UpdatePreparationError {
    Download(String),
    Cleanup(String),
}

async fn prepare_verified_update<Download, Cleanup>(
    download: Download,
    cleanup: Cleanup,
) -> Result<Vec<u8>, UpdatePreparationError>
where
    Download: std::future::Future<Output = Result<Vec<u8>, String>>,
    Cleanup: std::future::Future<Output = Result<(), String>>,
{
    let bytes = download.await.map_err(UpdatePreparationError::Download)?;
    cleanup.await.map_err(UpdatePreparationError::Cleanup)?;
    Ok(bytes)
}

#[tauri::command]
pub async fn update_now(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: tauri::State<'_, SidecarSupervisor>,
    coordinator: tauri::State<'_, UpdateCoordinator>,
) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("AliasMode updates are available only in the Windows desktop app.".to_owned());
    }
    let _guard = coordinator
        .0
        .try_lock()
        .map_err(|_| UPDATE_BUSY.to_owned())?;
    let update = match discover_update(&app).await {
        Ok(Some(update)) => update,
        Ok(None) => return Err("AliasMode is already up to date.".to_owned()),
        Err(error) => {
            eprintln!("AliasMode update recheck failed: {error}");
            return Err(CHECK_FAILED.to_owned());
        }
    };
    let sidecar = sidecar.inner().clone();
    let bytes = match prepare_verified_update(
        async {
            update
                .download(|_, _| {}, || {})
                .await
                .map_err(|error| error.to_string())
        },
        async {
            let _ = window.hide();
            shutdown::graceful_sidecar_cleanup(&sidecar).await
        },
    )
    .await
    {
        Ok(bytes) => bytes,
        Err(UpdatePreparationError::Download(error)) => {
            eprintln!("AliasMode update download or signature verification failed: {error}");
            return Err(DOWNLOAD_FAILED.to_owned());
        }
        Err(UpdatePreparationError::Cleanup(error)) => {
            shutdown::exit_after_cleanup_failure(app, &sidecar, error);
            return Ok(());
        }
    };

    if let Err(error) = update.install(&bytes) {
        restart_after_install_failure(app, error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        is_release_asset_url, newest_release, prepare_verified_update, validate_manifest_result,
        GithubAsset, GithubRelease, ReleaseCandidate, UpdateCoordinator, UpdatePreparationError,
        UpdateStatus, UPDATE_TARGET,
    };
    use semver::Version;
    use serde_json::json;
    use std::cell::Cell;
    use url::Url;

    fn manifest_url(tag: &str) -> String {
        format!("https://github.com/aliasmode/aliasmode/releases/download/{tag}/latest.json")
    }

    fn release(tag: &str, draft: bool, prerelease: bool, manifest_count: usize) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_owned(),
            draft,
            prerelease,
            assets: (0..manifest_count)
                .map(|_| GithubAsset {
                    name: "latest.json".to_owned(),
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
        assert!(is_release_asset_url(&valid, tag, "latest.json"));
        for invalid in [
            "http://github.com/aliasmode/aliasmode/releases/download/v0.1.0-beta.36/latest.json",
            "https://example.com/aliasmode/aliasmode/releases/download/v0.1.0-beta.36/latest.json",
            "https://github.com/other/aliasmode/releases/download/v0.1.0-beta.36/latest.json",
            "https://github.com/aliasmode/aliasmode/releases/download/v0.1.0-beta.36/latest.json?raw=1",
        ] {
            assert!(!is_release_asset_url(&Url::parse(invalid).unwrap(), tag, "latest.json"));
        }
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
    fn failed_verified_download_cannot_start_cleanup() {
        let cleanup_started = Cell::new(false);
        let result = tauri::async_runtime::block_on(prepare_verified_update(
            async { Err::<Vec<u8>, String>("bad signature".to_owned()) },
            async {
                cleanup_started.set(true);
                Ok(())
            },
        ));
        assert_eq!(
            result,
            Err(UpdatePreparationError::Download("bad signature".to_owned()))
        );
        assert!(!cleanup_started.get());
    }

    #[test]
    fn cleanup_starts_only_after_verified_download() {
        let stage = Cell::new(0);
        let result = tauri::async_runtime::block_on(prepare_verified_update(
            async {
                stage.set(1);
                Ok(vec![1, 2, 3])
            },
            async {
                assert_eq!(stage.get(), 1);
                stage.set(2);
                Ok(())
            },
        ));
        assert_eq!(result.unwrap(), vec![1, 2, 3]);
        assert_eq!(stage.get(), 2);
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
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            json!({
                "state": "available",
                "currentVersion": "0.1.0-beta.35",
                "version": "0.1.0-beta.36",
            }),
        );
    }
}

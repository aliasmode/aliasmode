use reqwest::{header::ACCEPT, redirect::Policy, Client};
use semver::Version;
use serde::Deserialize;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

const RELEASES_API: &str = "https://api.github.com/repos/aliasmode/aliasmode/releases?per_page=10";
const DOWNLOAD_PAGE: &str = "https://aliasmode.com/download/";
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
}

fn parse_tag(tag: &str) -> Option<Version> {
    Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()
}

fn newest_release<'a>(
    current: &Version,
    releases: &'a [GithubRelease],
) -> Option<(&'a str, Version)> {
    releases
        .iter()
        .filter(|release| !release.draft)
        .filter_map(|release| {
            parse_tag(&release.tag_name).map(|version| (release.tag_name.as_str(), version))
        })
        .filter(|(_, version)| version > current)
        .max_by(|(_, left), (_, right)| left.cmp(right))
}

pub async fn check_for_release(app: AppHandle) {
    if let Err(error) = check_for_release_inner(&app).await {
        eprintln!("AliasMode release check failed: {error}");
    }
}

async fn check_for_release_inner(app: &AppHandle) -> Result<(), String> {
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(5))
        .user_agent(format!(
            "AliasMode/{} release-notifier",
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
    if response.content_length().unwrap_or(0) > MAX_RESPONSE_BYTES as u64 {
        return Err("GitHub response exceeded the size limit".to_owned());
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("GitHub response exceeded the size limit".to_owned());
    }
    let releases: Vec<GithubRelease> =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let current = Version::parse(env!("CARGO_PKG_VERSION")).map_err(|error| error.to_string())?;
    if let Some((tag, _)) = newest_release(&current, &releases) {
        app.notification()
            .builder()
            .title("AliasMode update available")
            .body(format!(
                "AliasMode {tag} is available. Get it only from {DOWNLOAD_PAGE}"
            ))
            .show()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{newest_release, GithubRelease};
    use semver::Version;

    fn release(tag: &str, draft: bool) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_owned(),
            draft,
        }
    }

    #[test]
    fn selects_newer_stable_or_beta_release() {
        let current = Version::parse("0.1.0-beta.1").unwrap();
        let releases = vec![
            release("v0.1.0-beta.2", false),
            release("0.1.0", false),
            release("v9.0.0", true),
            release("latest", false),
        ];
        let (tag, version) = newest_release(&current, &releases).unwrap();
        assert_eq!(tag, "0.1.0");
        assert_eq!(version, Version::parse("0.1.0").unwrap());
    }

    #[test]
    fn ignores_drafts_malformed_tags_and_older_versions() {
        let current = Version::parse("1.0.0").unwrap();
        let releases = vec![
            release("v2.0.0", true),
            release("broken", false),
            release("v0.9.0", false),
        ];
        assert!(newest_release(&current, &releases).is_none());
    }
}

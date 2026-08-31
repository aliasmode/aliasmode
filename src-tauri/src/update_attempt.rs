use serde::{Deserialize, Serialize};
use std::{
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const ATTEMPT_FILE: &str = "update-attempt.json";
const ATTEMPT_TEMP_FILE: &str = "update-attempt.tmp";
const ATTEMPT_ARGUMENT: &str = "--aliasmode-update-attempt=";
const ATTEMPT_SCHEMA: u8 = 1;
const MANUFACTURER_KEY: &str = r"Software\aliasmode\AliasMode";
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\AliasMode";
const MAX_REGISTRY_STRING_BYTES: u32 = 32 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallerHandoff {
    pub id: String,
    pub canonical_root: PathBuf,
    nsis_root: PathBuf,
}

impl InstallerHandoff {
    pub fn prepare() -> Result<Self, UpdateAttemptError> {
        let executable = std::env::current_exe().map_err(|_| UpdateAttemptError::RunningPath)?;
        let canonical_executable =
            fs::canonicalize(executable).map_err(|_| UpdateAttemptError::RunningPath)?;
        let canonical_root = canonical_executable
            .parent()
            .ok_or(UpdateAttemptError::RunningPath)?
            .to_path_buf();
        Ok(Self {
            id: hex::encode(rand::random::<[u8; 16]>()),
            nsis_root: normal_windows_path(&canonical_root),
            canonical_root,
        })
    }

    pub fn relaunch_argument(&self) -> OsString {
        format!("{ATTEMPT_ARGUMENT}{}", self.id).into()
    }

    pub fn installer_arguments(&self) -> [OsString; 2] {
        [
            format!("/AMATTEMPT={}", self.id).into(),
            nsis_directory_argument(&self.nsis_root),
        ]
    }
}

fn nsis_directory_argument(path: &Path) -> OsString {
    let mut argument = OsString::from("/D=");
    argument.push(path);
    argument
}

fn normal_windows_path(path: &Path) -> PathBuf {
    let text = path.as_os_str().to_string_lossy();
    text.strip_prefix(r"\\?\UNC\")
        .map(|path| PathBuf::from(format!(r"\\{path}")))
        .or_else(|| text.strip_prefix(r"\\?\").map(PathBuf::from))
        .unwrap_or_else(|| path.to_path_buf())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelaunchArgument {
    Missing,
    Valid(String),
    Invalid,
}

pub fn parse_relaunch_argument<I, S>(arguments: I) -> RelaunchArgument
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut values = arguments.into_iter().filter_map(|argument| {
        argument
            .as_ref()
            .to_string_lossy()
            .strip_prefix(ATTEMPT_ARGUMENT)
            .map(str::to_owned)
    });
    let Some(value) = values.next() else {
        return RelaunchArgument::Missing;
    };
    if values.next().is_some() || !valid_attempt_id(&value) {
        return RelaunchArgument::Invalid;
    }
    RelaunchArgument::Valid(value)
}

fn valid_attempt_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpdateFailureReason {
    BrowserCleanup,
    InstallerLaunch,
    InstallationUnconfirmed,
    StartupMismatch,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum StoredAttemptState {
    Pending,
    Succeeded,
    InstalledRelaunchUnconfirmed,
    FailedOrInterrupted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredUpdateAttempt {
    schema_version: u8,
    id: String,
    source_version: String,
    expected_version: String,
    expected_root: PathBuf,
    state: StoredAttemptState,
    failure_reason: Option<UpdateFailureReason>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum LastUpdateResult {
    Succeeded {
        #[serde(rename = "fromVersion")]
        from_version: String,
        version: String,
    },
    InstalledRelaunchUnconfirmed {
        version: String,
    },
    FailedOrInterrupted {
        #[serde(rename = "fromVersion")]
        from_version: String,
        #[serde(rename = "expectedVersion")]
        expected_version: String,
        reason: UpdateFailureReason,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateAttemptError {
    RunningPath,
    RegistrationUnavailable,
    RegistrationMismatch,
    Persistence,
    InvalidRecord,
}

impl std::fmt::Display for UpdateAttemptError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::RunningPath => "the running installation path was unavailable",
            Self::RegistrationUnavailable => {
                "the Windows installation registration was unavailable"
            }
            Self::RegistrationMismatch => {
                "the running installation did not match its Windows registration"
            }
            Self::Persistence => "the update attempt could not be stored",
            Self::InvalidRecord => "the stored update attempt was invalid",
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RegistrationSnapshot {
    manufacturer_root: Option<String>,
    install_location: Option<String>,
    uninstall_string: Option<String>,
    main_binary_name: Option<String>,
    display_version: Option<String>,
}

pub fn validate_registered_install(
    handoff: &InstallerHandoff,
    current_version: &str,
) -> Result<(), UpdateAttemptError> {
    let executable = std::env::current_exe().map_err(|_| UpdateAttemptError::RunningPath)?;
    validate_registration_snapshot(
        &executable,
        current_version,
        &read_registration_snapshot()?,
        Some(&handoff.canonical_root),
    )
    .map(|_| ())
}

fn validate_registration_snapshot(
    executable: &Path,
    current_version: &str,
    registration: &RegistrationSnapshot,
    expected_root: Option<&Path>,
) -> Result<PathBuf, UpdateAttemptError> {
    let executable = fs::canonicalize(executable).map_err(|_| UpdateAttemptError::RunningPath)?;
    let root = executable
        .parent()
        .ok_or(UpdateAttemptError::RunningPath)?
        .to_path_buf();
    if expected_root.is_some_and(|expected| !same_windows_path(expected, &root)) {
        return Err(UpdateAttemptError::RegistrationMismatch);
    }

    let manufacturer_root =
        canonical_registered_path(registration.manufacturer_root.as_deref(), false)?;
    let install_location =
        canonical_registered_path(registration.install_location.as_deref(), false)?;
    let uninstall = canonical_registered_path(registration.uninstall_string.as_deref(), true)?;
    let expected_uninstall = fs::canonicalize(root.join("uninstall.exe"))
        .map_err(|_| UpdateAttemptError::RegistrationMismatch)?;
    let executable_name = executable
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or(UpdateAttemptError::RunningPath)?;

    if !same_windows_path(&root, &manufacturer_root)
        || !same_windows_path(&root, &install_location)
        || !same_windows_path(&expected_uninstall, &uninstall)
        || !registration
            .main_binary_name
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case(executable_name))
        || registration.display_version.as_deref() != Some(current_version)
    {
        return Err(UpdateAttemptError::RegistrationMismatch);
    }
    Ok(root)
}

fn canonical_registered_path(
    value: Option<&str>,
    file: bool,
) -> Result<PathBuf, UpdateAttemptError> {
    let value = value
        .and_then(strip_optional_quotes)
        .ok_or(UpdateAttemptError::RegistrationUnavailable)?;
    let path = fs::canonicalize(value).map_err(|_| UpdateAttemptError::RegistrationMismatch)?;
    if (file && !path.is_file()) || (!file && !path.is_dir()) {
        return Err(UpdateAttemptError::RegistrationMismatch);
    }
    Ok(path)
}

fn strip_optional_quotes(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if let Some(value) = value.strip_prefix('"') {
        return value.strip_suffix('"').filter(|value| !value.is_empty());
    }
    (!value.ends_with('"')).then_some(value)
}

fn same_windows_path(left: &Path, right: &Path) -> bool {
    normal_windows_path(left)
        .as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&normal_windows_path(right).as_os_str().to_string_lossy())
}

#[cfg(windows)]
fn read_registration_snapshot() -> Result<RegistrationSnapshot, UpdateAttemptError> {
    Ok(RegistrationSnapshot {
        manufacturer_root: read_current_user_registry_string(MANUFACTURER_KEY, None)?,
        install_location: read_current_user_registry_string(
            UNINSTALL_KEY,
            Some("InstallLocation"),
        )?,
        uninstall_string: read_current_user_registry_string(
            UNINSTALL_KEY,
            Some("UninstallString"),
        )?,
        main_binary_name: read_current_user_registry_string(UNINSTALL_KEY, Some("MainBinaryName"))?,
        display_version: read_current_user_registry_string(UNINSTALL_KEY, Some("DisplayVersion"))?,
    })
}

#[cfg(windows)]
fn read_current_user_registry_string(
    subkey: &str,
    value_name: Option<&str>,
) -> Result<Option<String>, UpdateAttemptError> {
    use std::ffi::c_void;
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS},
            System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ},
        },
    };

    let subkey: Vec<u16> = subkey.encode_utf16().chain(Some(0)).collect();
    let value_name: Option<Vec<u16>> =
        value_name.map(|value| value.encode_utf16().chain(Some(0)).collect());
    let value_name = value_name
        .as_ref()
        .map_or(PCWSTR::null(), |value| PCWSTR(value.as_ptr()));
    let mut byte_count = 0_u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            value_name,
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut byte_count),
        )
    };
    if status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND {
        return Ok(None);
    }
    if status != ERROR_SUCCESS || byte_count == 0 || byte_count > MAX_REGISTRY_STRING_BYTES {
        return Err(UpdateAttemptError::RegistrationUnavailable);
    }

    let mut value = vec![0_u16; byte_count.div_ceil(2) as usize];
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            value_name,
            RRF_RT_REG_SZ,
            None,
            Some(value.as_mut_ptr().cast::<c_void>()),
            Some(&mut byte_count),
        )
    };
    if status != ERROR_SUCCESS || byte_count as usize > value.len() * 2 {
        return Err(UpdateAttemptError::RegistrationUnavailable);
    }
    value.truncate(byte_count.div_ceil(2) as usize);
    while value.last() == Some(&0) {
        value.pop();
    }
    String::from_utf16(&value)
        .map(Some)
        .map_err(|_| UpdateAttemptError::RegistrationUnavailable)
}

#[cfg(not(windows))]
fn read_registration_snapshot() -> Result<RegistrationSnapshot, UpdateAttemptError> {
    Err(UpdateAttemptError::RegistrationUnavailable)
}

pub fn begin_attempt(
    data_dir: &Path,
    handoff: &InstallerHandoff,
    source_version: &str,
    expected_version: &str,
) -> Result<(), UpdateAttemptError> {
    write_attempt(
        data_dir,
        &StoredUpdateAttempt {
            schema_version: ATTEMPT_SCHEMA,
            id: handoff.id.clone(),
            source_version: source_version.to_owned(),
            expected_version: expected_version.to_owned(),
            expected_root: handoff.canonical_root.clone(),
            state: StoredAttemptState::Pending,
            failure_reason: None,
        },
    )
}

pub fn record_failure(
    data_dir: &Path,
    attempt_id: &str,
    reason: UpdateFailureReason,
) -> Result<(), UpdateAttemptError> {
    let Some(mut attempt) = read_attempt(data_dir)? else {
        return Err(UpdateAttemptError::InvalidRecord);
    };
    if attempt.id != attempt_id || !valid_stored_attempt(&attempt) {
        return Err(UpdateAttemptError::InvalidRecord);
    }
    attempt.state = StoredAttemptState::FailedOrInterrupted;
    attempt.failure_reason = Some(reason);
    write_attempt(data_dir, &attempt)
}

#[derive(Debug, Clone, Copy)]
struct ReconciliationEvidence {
    marker_matches: bool,
    registration_matches: bool,
    current_version_matches: bool,
    relaunch_matches: bool,
}

fn apply_reconciliation(attempt: &mut StoredUpdateAttempt, evidence: ReconciliationEvidence) {
    if evidence.marker_matches
        && evidence.registration_matches
        && evidence.current_version_matches
        && evidence.relaunch_matches
    {
        attempt.state = StoredAttemptState::Succeeded;
        attempt.failure_reason = None;
    } else if evidence.marker_matches
        && evidence.registration_matches
        && evidence.current_version_matches
    {
        attempt.state = StoredAttemptState::InstalledRelaunchUnconfirmed;
        attempt.failure_reason = None;
    } else {
        attempt.state = StoredAttemptState::FailedOrInterrupted;
        attempt
            .failure_reason
            .get_or_insert(if evidence.marker_matches {
                UpdateFailureReason::StartupMismatch
            } else {
                UpdateFailureReason::InstallationUnconfirmed
            });
    }
}

pub fn reconcile_after_startup(
    data_dir: &Path,
    relaunch: &RelaunchArgument,
) -> Result<(), UpdateAttemptError> {
    let Some(mut attempt) = read_attempt(data_dir)? else {
        return Ok(());
    };
    if !valid_stored_attempt(&attempt) {
        return Err(UpdateAttemptError::InvalidRecord);
    }
    if attempt.state == StoredAttemptState::Succeeded {
        return Ok(());
    }

    let marker_matches =
        read_marker(&attempt).is_ok_and(|version| version == attempt.expected_version);
    let current_executable =
        std::env::current_exe().map_err(|_| UpdateAttemptError::RunningPath)?;
    let registration_matches = read_registration_snapshot()
        .and_then(|registration| {
            validate_registration_snapshot(
                &current_executable,
                &attempt.expected_version,
                &registration,
                Some(&attempt.expected_root),
            )
        })
        .is_ok();
    let current_version_matches = env!("CARGO_PKG_VERSION") == attempt.expected_version;
    let relaunch_matches = matches!(relaunch, RelaunchArgument::Valid(id) if id == &attempt.id);

    apply_reconciliation(
        &mut attempt,
        ReconciliationEvidence {
            marker_matches,
            registration_matches,
            current_version_matches,
            relaunch_matches,
        },
    );
    write_attempt(data_dir, &attempt)?;
    if attempt.state == StoredAttemptState::Succeeded {
        let _ = fs::remove_file(marker_path(&attempt));
    }
    Ok(())
}

fn read_marker(attempt: &StoredUpdateAttempt) -> Result<String, UpdateAttemptError> {
    let mut value = String::new();
    File::open(marker_path(attempt))
        .and_then(|mut file| file.read_to_string(&mut value))
        .map_err(|_| UpdateAttemptError::InvalidRecord)?;
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return Err(UpdateAttemptError::InvalidRecord);
    }
    Ok(value.to_owned())
}

fn marker_path(attempt: &StoredUpdateAttempt) -> PathBuf {
    attempt
        .expected_root
        .join(format!(".aliasmode-update-{}.complete", attempt.id))
}

pub fn last_update_result(data_dir: &Path) -> Result<Option<LastUpdateResult>, UpdateAttemptError> {
    let Some(attempt) = read_attempt(data_dir)? else {
        return Ok(None);
    };
    if !valid_stored_attempt(&attempt) {
        return Err(UpdateAttemptError::InvalidRecord);
    }
    Ok(Some(match attempt.state {
        StoredAttemptState::Succeeded => LastUpdateResult::Succeeded {
            from_version: attempt.source_version,
            version: attempt.expected_version,
        },
        StoredAttemptState::InstalledRelaunchUnconfirmed => {
            LastUpdateResult::InstalledRelaunchUnconfirmed {
                version: attempt.expected_version,
            }
        }
        StoredAttemptState::Pending | StoredAttemptState::FailedOrInterrupted => {
            LastUpdateResult::FailedOrInterrupted {
                from_version: attempt.source_version,
                expected_version: attempt.expected_version,
                reason: attempt
                    .failure_reason
                    .unwrap_or(UpdateFailureReason::InstallationUnconfirmed),
            }
        }
    }))
}

fn valid_stored_attempt(attempt: &StoredUpdateAttempt) -> bool {
    attempt.schema_version == ATTEMPT_SCHEMA
        && valid_attempt_id(&attempt.id)
        && !attempt.source_version.is_empty()
        && attempt.source_version.len() <= 64
        && !attempt.expected_version.is_empty()
        && attempt.expected_version.len() <= 64
        && attempt.expected_root.is_absolute()
}

fn read_attempt(data_dir: &Path) -> Result<Option<StoredUpdateAttempt>, UpdateAttemptError> {
    let path = data_dir.join(ATTEMPT_FILE);
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(UpdateAttemptError::Persistence),
    };
    if bytes.len() > 16 * 1024 {
        return Err(UpdateAttemptError::InvalidRecord);
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| UpdateAttemptError::InvalidRecord)
}

fn write_attempt(data_dir: &Path, attempt: &StoredUpdateAttempt) -> Result<(), UpdateAttemptError> {
    fs::create_dir_all(data_dir).map_err(|_| UpdateAttemptError::Persistence)?;
    let bytes = serde_json::to_vec(attempt).map_err(|_| UpdateAttemptError::Persistence)?;
    let temp_path = data_dir.join(ATTEMPT_TEMP_FILE);
    let target_path = data_dir.join(ATTEMPT_FILE);
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp_path)
        .map_err(|_| UpdateAttemptError::Persistence)?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| UpdateAttemptError::Persistence)?;
    drop(file);
    replace_file(&temp_path, &target_path)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), UpdateAttemptError> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        },
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|_| UpdateAttemptError::Persistence)
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), UpdateAttemptError> {
    fs::rename(source, destination).map_err(|_| UpdateAttemptError::Persistence)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_registered_install() -> (tempfile::TempDir, PathBuf, RegistrationSnapshot) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("AliasMode install");
        fs::create_dir(&root).unwrap();
        let executable = root.join("AliasMode.exe");
        let uninstall = root.join("uninstall.exe");
        fs::write(&executable, b"app").unwrap();
        fs::write(&uninstall, b"uninstall").unwrap();
        let quoted_root = format!("\"{}\"", root.display());
        let registration = RegistrationSnapshot {
            manufacturer_root: Some(root.display().to_string()),
            install_location: Some(quoted_root),
            uninstall_string: Some(format!("\"{}\"", uninstall.display())),
            main_binary_name: Some("AliasMode.exe".to_owned()),
            display_version: Some("0.1.0-beta.47".to_owned()),
        };
        (directory, executable, registration)
    }

    fn handoff(root: &Path) -> InstallerHandoff {
        InstallerHandoff {
            id: "0123456789abcdef0123456789abcdef".to_owned(),
            canonical_root: root.to_path_buf(),
            nsis_root: normal_windows_path(root),
        }
    }

    fn stored_attempt(root: &Path) -> StoredUpdateAttempt {
        StoredUpdateAttempt {
            schema_version: ATTEMPT_SCHEMA,
            id: "0123456789abcdef0123456789abcdef".to_owned(),
            source_version: "0.1.0-beta.46".to_owned(),
            expected_version: "0.1.0-beta.47".to_owned(),
            expected_root: root.to_path_buf(),
            state: StoredAttemptState::Pending,
            failure_reason: None,
        }
    }

    #[test]
    fn accepts_only_one_lowercase_attempt_argument() {
        let valid = "--aliasmode-update-attempt=0123456789abcdef0123456789abcdef";
        assert_eq!(
            parse_relaunch_argument([valid]),
            RelaunchArgument::Valid("0123456789abcdef0123456789abcdef".to_owned())
        );
        assert_eq!(
            parse_relaunch_argument(["--background"]),
            RelaunchArgument::Missing
        );
        assert_eq!(
            parse_relaunch_argument([valid, valid]),
            RelaunchArgument::Invalid
        );
        assert_eq!(
            parse_relaunch_argument([
                "--aliasmode-update-attempt=0123456789ABCDEF0123456789ABCDEF"
            ]),
            RelaunchArgument::Invalid
        );
    }

    #[test]
    fn converts_namespaced_paths_and_keeps_nsis_directory_last_ready() {
        assert_eq!(
            normal_windows_path(Path::new(r"\\?\C:\Program Files\AliasMode")),
            PathBuf::from(r"C:\Program Files\AliasMode")
        );
        assert_eq!(
            normal_windows_path(Path::new(r"\\?\UNC\server\share\AliasMode")),
            PathBuf::from(r"\\server\share\AliasMode")
        );
        assert_eq!(
            nsis_directory_argument(Path::new(r"C:\Program Files\AliasMode")),
            OsString::from(r"/D=C:\Program Files\AliasMode")
        );
    }

    #[test]
    fn validates_the_running_root_against_all_registration_values() {
        let (_directory, executable, registration) = create_registered_install();
        let root = fs::canonicalize(executable.parent().unwrap()).unwrap();
        assert_eq!(
            validate_registration_snapshot(
                &executable,
                "0.1.0-beta.47",
                &registration,
                Some(&root)
            )
            .unwrap(),
            root
        );
    }

    #[test]
    fn rejects_missing_stale_or_different_registration_roots() {
        let (directory, executable, registration) = create_registered_install();
        let root = fs::canonicalize(executable.parent().unwrap()).unwrap();

        let mut missing = registration.clone();
        missing.install_location = None;
        assert_eq!(
            validate_registration_snapshot(&executable, "0.1.0-beta.47", &missing, Some(&root)),
            Err(UpdateAttemptError::RegistrationUnavailable)
        );

        let other = directory.path().join("other");
        fs::create_dir(&other).unwrap();
        let mut stale = registration.clone();
        stale.install_location = Some(other.display().to_string());
        assert_eq!(
            validate_registration_snapshot(&executable, "0.1.0-beta.47", &stale, Some(&root)),
            Err(UpdateAttemptError::RegistrationMismatch)
        );

        let mut wrong_version = registration;
        wrong_version.display_version = Some("0.1.0-beta.46".to_owned());
        assert_eq!(
            validate_registration_snapshot(
                &executable,
                "0.1.0-beta.47",
                &wrong_version,
                Some(&root)
            ),
            Err(UpdateAttemptError::RegistrationMismatch)
        );
    }

    #[test]
    fn requires_marker_root_version_and_exact_relaunch_for_success() {
        let directory = tempfile::tempdir().unwrap();
        let mut attempt = stored_attempt(directory.path());
        apply_reconciliation(
            &mut attempt,
            ReconciliationEvidence {
                marker_matches: true,
                registration_matches: true,
                current_version_matches: true,
                relaunch_matches: true,
            },
        );
        assert_eq!(attempt.state, StoredAttemptState::Succeeded);
        assert_eq!(attempt.failure_reason, None);

        let mut no_relaunch = stored_attempt(directory.path());
        apply_reconciliation(
            &mut no_relaunch,
            ReconciliationEvidence {
                marker_matches: true,
                registration_matches: true,
                current_version_matches: true,
                relaunch_matches: false,
            },
        );
        assert_eq!(
            no_relaunch.state,
            StoredAttemptState::InstalledRelaunchUnconfirmed
        );

        for evidence in [
            ReconciliationEvidence {
                marker_matches: false,
                registration_matches: true,
                current_version_matches: true,
                relaunch_matches: true,
            },
            ReconciliationEvidence {
                marker_matches: true,
                registration_matches: false,
                current_version_matches: true,
                relaunch_matches: true,
            },
            ReconciliationEvidence {
                marker_matches: true,
                registration_matches: true,
                current_version_matches: false,
                relaunch_matches: true,
            },
        ] {
            let mut failed = stored_attempt(directory.path());
            apply_reconciliation(&mut failed, evidence);
            assert_eq!(failed.state, StoredAttemptState::FailedOrInterrupted);
            assert!(failed.failure_reason.is_some());
        }
    }

    #[test]
    fn later_complete_evidence_can_replace_an_interrupted_result() {
        let directory = tempfile::tempdir().unwrap();
        let mut attempt = stored_attempt(directory.path());
        attempt.state = StoredAttemptState::FailedOrInterrupted;
        attempt.failure_reason = Some(UpdateFailureReason::InstallationUnconfirmed);
        apply_reconciliation(
            &mut attempt,
            ReconciliationEvidence {
                marker_matches: true,
                registration_matches: true,
                current_version_matches: true,
                relaunch_matches: true,
            },
        );
        assert_eq!(attempt.state, StoredAttemptState::Succeeded);
        assert_eq!(attempt.failure_reason, None);
    }

    #[test]
    fn stores_safe_attempts_atomically_and_serializes_no_path_to_ipc() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let handoff = handoff(&root);
        begin_attempt(directory.path(), &handoff, "0.1.0-beta.46", "0.1.0-beta.47").unwrap();
        assert_eq!(
            last_update_result(directory.path()).unwrap(),
            Some(LastUpdateResult::FailedOrInterrupted {
                from_version: "0.1.0-beta.46".to_owned(),
                expected_version: "0.1.0-beta.47".to_owned(),
                reason: UpdateFailureReason::InstallationUnconfirmed,
            })
        );
        let value = serde_json::to_value(last_update_result(directory.path()).unwrap()).unwrap();
        let text = value.to_string();
        assert!(!text.contains(&root.display().to_string()));
        assert!(!text.contains(&handoff.id));
    }

    #[test]
    fn records_only_the_matching_attempt_failure() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let handoff = handoff(&root);
        begin_attempt(directory.path(), &handoff, "old", "new").unwrap();
        assert_eq!(
            record_failure(
                directory.path(),
                "ffffffffffffffffffffffffffffffff",
                UpdateFailureReason::InstallerLaunch
            ),
            Err(UpdateAttemptError::InvalidRecord)
        );
        record_failure(
            directory.path(),
            &handoff.id,
            UpdateFailureReason::BrowserCleanup,
        )
        .unwrap();
        assert_eq!(
            last_update_result(directory.path()).unwrap(),
            Some(LastUpdateResult::FailedOrInterrupted {
                from_version: "old".to_owned(),
                expected_version: "new".to_owned(),
                reason: UpdateFailureReason::BrowserCleanup,
            })
        );
    }
}

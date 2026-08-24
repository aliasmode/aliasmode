use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

pub const RUNTIME_PROTOCOL: &str = "aliasmode-runtime-v1";
const RUNTIME_FILE: &str = "agent-runtime.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDescriptor {
    pub protocol: String,
    pub app_version: String,
    pub generation: String,
    pub nonce: String,
    pub port: u16,
    pub desktop_pid: u32,
    pub desktop_started_at: String,
    pub sidecar_pid: u32,
    pub readiness: String,
    pub created_at: u64,
}

pub struct RuntimeDescriptorState {
    path: PathBuf,
    base: RuntimeDescriptor,
    write_lock: Mutex<()>,
}

impl RuntimeDescriptorState {
    pub fn new(
        data_dir: &Path,
        generation: String,
        nonce: String,
        port: u16,
        sidecar_pid: u32,
    ) -> Result<Self, String> {
        if !valid_nonce(&generation) || !valid_nonce(&nonce) {
            return Err("runtime descriptor nonce is invalid".to_owned());
        }
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "system clock is before the Unix epoch".to_owned())?
            .as_secs();
        Ok(Self {
            path: data_dir.join(RUNTIME_FILE),
            base: RuntimeDescriptor {
                protocol: RUNTIME_PROTOCOL.to_owned(),
                app_version: env!("CARGO_PKG_VERSION").to_owned(),
                generation,
                nonce,
                port,
                desktop_pid: std::process::id(),
                desktop_started_at: current_process_start_identity()?,
                sidecar_pid,
                readiness: String::new(),
                created_at,
            },
            write_lock: Mutex::new(()),
        })
    }

    pub fn publish(&self, readiness: &str) -> Result<(), String> {
        if !matches!(
            readiness,
            "local" | "cloud_authenticated" | "sign_in_required"
        ) {
            return Err("runtime readiness state is invalid".to_owned());
        }
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| "runtime descriptor lock failed".to_owned())?;
        let mut descriptor = self.base.clone();
        descriptor.readiness = readiness.to_owned();
        write_atomic(
            &self.path,
            &serde_json::to_vec(&descriptor).map_err(|error| error.to_string())?,
        )
    }

    pub fn remove_owned(&self) -> Result<(), String> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| "runtime descriptor lock failed".to_owned())?;
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        let descriptor: RuntimeDescriptor = serde_json::from_slice(&bytes)
            .map_err(|_| "runtime descriptor is malformed".to_owned())?;
        if descriptor.generation == self.base.generation {
            fs::remove_file(&self.path).map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

fn valid_nonce(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[tauri::command]
pub fn agent_runtime_ready(
    state: tauri::State<'_, RuntimeDescriptorState>,
    readiness: String,
) -> Result<(), String> {
    state.publish(&readiness)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    replace_file(&temporary, path).inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MOVE_FILE_FLAGS,
        },
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let flags = MOVE_FILE_FLAGS(MOVEFILE_REPLACE_EXISTING.0 | MOVEFILE_WRITE_THROUGH.0);
    unsafe { MoveFileExW(PCWSTR(source.as_ptr()), PCWSTR(destination.as_ptr()), flags) }
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn current_process_start_identity() -> Result<String, String> {
    use windows::Win32::{
        Foundation::FILETIME,
        System::Threading::{GetCurrentProcess, GetProcessTimes},
    };
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    }
    .map_err(|error| error.to_string())?;
    Ok(((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime)).to_string())
}

#[cfg(not(windows))]
fn current_process_start_identity() -> Result<String, String> {
    let stat = fs::read_to_string("/proc/self/stat").map_err(|error| error.to_string())?;
    let end = stat
        .rfind(')')
        .ok_or_else(|| "process stat is malformed".to_owned())?;
    stat[end + 2..]
        .split_whitespace()
        .nth(19)
        .filter(|value| value.bytes().all(|byte| byte.is_ascii_digit()))
        .map(str::to_owned)
        .ok_or_else(|| "process start identity is unavailable".to_owned())
}

#[cfg(test)]
mod tests {
    use super::{RuntimeDescriptor, RuntimeDescriptorState, RUNTIME_PROTOCOL};

    #[test]
    fn descriptor_publish_is_replaceable_and_generation_scoped() {
        let dir = tempfile::tempdir().unwrap();
        let first =
            RuntimeDescriptorState::new(dir.path(), "a".repeat(64), "c".repeat(64), 50400, 222)
                .unwrap();
        first.publish("local").unwrap();
        let path = dir.path().join("agent-runtime.json");
        let local: RuntimeDescriptor =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(local.protocol, RUNTIME_PROTOCOL);
        assert_eq!(local.readiness, "local");
        assert_eq!(local.sidecar_pid, 222);

        first.publish("cloud_authenticated").unwrap();
        let updated: RuntimeDescriptor =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(updated.readiness, "cloud_authenticated");

        let replacement =
            RuntimeDescriptorState::new(dir.path(), "b".repeat(64), "d".repeat(64), 50401, 333)
                .unwrap();
        replacement.publish("sign_in_required").unwrap();
        first.remove_owned().unwrap();
        assert!(path.is_file());
        replacement.remove_owned().unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn rejects_an_unknown_readiness_state() {
        let dir = tempfile::tempdir().unwrap();
        let state =
            RuntimeDescriptorState::new(dir.path(), "c".repeat(64), "e".repeat(64), 50400, 222)
                .unwrap();
        assert!(state.publish("starting").is_err());
        assert!(!dir.path().join("agent-runtime.json").exists());
    }
}

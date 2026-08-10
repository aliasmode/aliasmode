use crate::{browser::BrowserRuntime, credentials};
use reqwest::{redirect::Policy, Client};
use serde::Deserialize;
use std::{
    ffi::OsString,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::AppHandle;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::{sync::watch, time::timeout};
use zeroize::Zeroize;

const PROTOCOL: &str = "aliasmode-desktop-v1";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(8 * 60);

#[derive(Debug, Deserialize)]
struct ReadyRecord {
    protocol: String,
    event: String,
    nonce: String,
    pid: u32,
    port: u16,
}

#[derive(Debug, Deserialize)]
struct HealthRecord {
    ok: bool,
    version: String,
    root: String,
    instance: String,
}

#[derive(Debug, Deserialize)]
struct CredentialSetRecord {
    protocol: String,
    event: String,
    nonce: String,
    request: u64,
    key: String,
    secret: String,
}

impl Drop for CredentialSetRecord {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

#[derive(Debug, Deserialize)]
struct CredentialDeleteRecord {
    protocol: String,
    event: String,
    nonce: String,
    request: u64,
    key: String,
}

#[derive(Debug, Clone)]
enum ChildStatus {
    Running,
    ShutdownComplete,
    ShutdownFailed,
    Exited(Option<i32>),
}

struct SidecarInner {
    child: Mutex<Option<CommandChild>>,
    nonce: String,
    status: watch::Sender<ChildStatus>,
    shutting_down: Arc<AtomicBool>,
    cleanup_confirmed: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct SidecarSupervisor(Arc<SidecarInner>);

impl SidecarSupervisor {
    fn write_control(&self, value: &serde_json::Value) -> Result<(), String> {
        let mut child = self
            .0
            .child
            .lock()
            .map_err(|_| "sidecar handle lock failed".to_owned())?;
        child
            .as_mut()
            .ok_or_else(|| "AliasMode sidecar is not running".to_owned())?
            .write(format!("{value}\n").as_bytes())
            .map_err(|_| "could not write to the owned sidecar".to_owned())
    }

    pub fn request_shutdown(&self) -> Result<(), String> {
        if self.0.shutting_down.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let command = serde_json::json!({
            "protocol": PROTOCOL,
            "command": "shutdown",
            "nonce": self.0.nonce,
        });
        let mut child = self
            .0
            .child
            .lock()
            .map_err(|_| "sidecar handle lock failed".to_owned())?;
        child
            .as_mut()
            .ok_or_else(|| "AliasMode sidecar is not running".to_owned())?
            .write(format!("{command}\n").as_bytes())
            .map_err(|_| "could not request graceful sidecar shutdown".to_owned())
    }

    pub async fn wait_for_shutdown(&self) -> Result<(), String> {
        let mut status = self.0.status.subscribe();
        let wait = async {
            let mut completed = self.0.cleanup_confirmed.load(Ordering::Acquire);
            loop {
                match status.borrow().clone() {
                    ChildStatus::Running => {}
                    ChildStatus::ShutdownComplete => completed = true,
                    ChildStatus::ShutdownFailed => {
                        return Err("sidecar reported unconfirmed browser cleanup".to_owned())
                    }
                    ChildStatus::Exited(code) => {
                        return if (completed || self.0.cleanup_confirmed.load(Ordering::Acquire))
                            && code == Some(0)
                        {
                            Ok(())
                        } else {
                            Err(format!(
                                "sidecar exited before confirmed cleanup (code {code:?})"
                            ))
                        };
                    }
                }
                status
                    .changed()
                    .await
                    .map_err(|_| "sidecar status channel closed".to_owned())?;
            }
        };
        timeout(SHUTDOWN_TIMEOUT, wait)
            .await
            .map_err(|_| "sidecar graceful shutdown timed out".to_owned())?
    }

    pub fn kill_owned(&self) -> Result<(), String> {
        self.0.shutting_down.store(true, Ordering::Release);
        let child = self
            .0
            .child
            .lock()
            .map_err(|_| "sidecar handle lock failed".to_owned())?
            .take();
        if let Some(child) = child {
            child
                .kill()
                .map_err(|_| "could not terminate the owned sidecar".to_owned())?;
        }
        Ok(())
    }
}

fn parse_ready_line(line: &[u8], nonce: &str, pid: u32) -> Result<Option<u16>, String> {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
        return Ok(None);
    };
    if value.get("protocol").and_then(|value| value.as_str()) != Some(PROTOCOL)
        || value.get("event").and_then(|value| value.as_str()) != Some("ready")
    {
        return Ok(None);
    }
    let record: ReadyRecord = serde_json::from_value(value)
        .map_err(|_| "sidecar emitted malformed readiness data".to_owned())?;
    if record.protocol != PROTOCOL
        || record.event != "ready"
        || record.nonce != nonce
        || record.pid != pid
        || record.port == 0
    {
        return Err("sidecar readiness proof did not match the owned process".to_owned());
    }
    Ok(Some(record.port))
}

fn parse_credential_set(line: &[u8], nonce: &str) -> Option<CredentialSetRecord> {
    let record = serde_json::from_slice::<CredentialSetRecord>(line).ok()?;
    if record.protocol == PROTOCOL
        && record.event == "credential-set"
        && record.nonce == nonce
        && record.request > 0
        && record.key == "refresh_token"
    {
        Some(record)
    } else {
        None
    }
}

fn parse_credential_delete(line: &[u8], nonce: &str) -> Option<CredentialDeleteRecord> {
    let record = serde_json::from_slice::<CredentialDeleteRecord>(line).ok()?;
    if record.protocol == PROTOCOL
        && record.event == "credential-delete"
        && record.nonce == nonce
        && record.request > 0
        && matches!(record.key.as_str(), "refresh_token" | "device_credential")
    {
        Some(record)
    } else {
        None
    }
}

fn verify_health_record(record: &HealthRecord, nonce: &str, root: &Path) -> Result<(), String> {
    if !record.ok
        || record.version != VERSION
        || record.instance != nonce
        || Path::new(&record.root) != root
    {
        return Err("sidecar health proof did not match the desktop instance".to_owned());
    }
    Ok(())
}

async fn wait_for_health(port: u16, nonce: &str, root: &Path) -> Result<(), String> {
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| error.to_string())?;
    let url = format!("http://127.0.0.1:{port}/ui/api/health");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(response) = client.get(&url).send().await {
            if response.status().is_success() && response.content_length().unwrap_or(0) <= 16 * 1024
            {
                if let Ok(bytes) = response.bytes().await {
                    if bytes.len() <= 16 * 1024 {
                        if let Ok(record) = serde_json::from_slice::<HealthRecord>(&bytes) {
                            if verify_health_record(&record, nonce, root).is_ok() {
                                return Ok(());
                            }
                        }
                    }
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("sidecar health endpoint did not prove readiness".to_owned());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn command_args(data_dir: &Path) -> Vec<OsString> {
    vec![
        "start".into(),
        "--desktop-stdio".into(),
        "--desktop-root".into(),
        data_dir.as_os_str().to_owned(),
        "--state-root".into(),
        data_dir.as_os_str().to_owned(),
        "--db".into(),
        data_dir.join("profiles.sqlite").into_os_string(),
        "--data-root".into(),
        data_dir.join("profiles").into_os_string(),
        "--port".into(),
        "0".into(),
    ]
}

pub async fn launch_and_verify(
    app: &AppHandle,
    data_dir: &Path,
    browser: &BrowserRuntime,
    nonce: &str,
) -> Result<(SidecarSupervisor, u16), String> {
    let command = app
        .shell()
        .sidecar("aliasmode-sidecar")
        .map_err(|error| error.to_string())?
        .args(command_args(data_dir))
        .current_dir(data_dir)
        .env("ALIASMODE_DESKTOP_NONCE", nonce)
        .env("ALIASMODE_DESKTOP_VERSION", VERSION)
        .env("CLOAKBROWSER_BINARY_PATH", &browser.executable)
        .env("CLOAKBROWSER_BINARY_SHA256", &browser.sha256)
        .env("CLOAKBROWSER_DOWNLOAD_URL", "")
        .env("ALIASMODE_ACCESS_TOKEN", "")
        .env("ALIASMODE_REFRESH_TOKEN", "")
        .env("ALIASMODE_DEVICE_CREDENTIAL", "")
        .env("ALIASMODE_QUEUE_ENCRYPTION_KEY", "")
        .env("HUB_URL", "")
        .env("HUB_PASSWORD", "");

    let (mut events, child) = command.spawn().map_err(|error| error.to_string())?;
    let pid = child.pid();
    let ready = match timeout(STARTUP_TIMEOUT, async {
        loop {
            match events.recv().await {
                Some(CommandEvent::Stdout(line)) => {
                    if let Some(port) = parse_ready_line(&line, nonce, pid)? {
                        return Ok(port);
                    }
                }
                Some(CommandEvent::Stderr(line)) => {
                    eprintln!(
                        "AliasMode sidecar startup: {}",
                        String::from_utf8_lossy(&line)
                    );
                }
                Some(CommandEvent::Error(_)) => {
                    return Err("sidecar output channel failed during startup".to_owned())
                }
                Some(CommandEvent::Terminated(exit)) => {
                    return Err(format!(
                        "sidecar exited during startup (code {:?})",
                        exit.code
                    ))
                }
                Some(_) => {}
                None => return Err("sidecar output channel closed during startup".to_owned()),
            }
        }
    })
    .await
    {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill();
            return Err("sidecar readiness timed out".to_owned());
        }
    };

    let port = match ready {
        Ok(port) => port,
        Err(error) => {
            let _ = child.kill();
            return Err(error);
        }
    };
    if let Err(error) = wait_for_health(port, nonce, data_dir).await {
        let _ = child.kill();
        return Err(error);
    }

    let (status, _) = watch::channel(ChildStatus::Running);
    let shutting_down = Arc::new(AtomicBool::new(false));
    let cleanup_confirmed = Arc::new(AtomicBool::new(false));
    let supervisor = SidecarSupervisor(Arc::new(SidecarInner {
        child: Mutex::new(Some(child)),
        nonce: nonce.to_owned(),
        status: status.clone(),
        shutting_down: shutting_down.clone(),
        cleanup_confirmed: cleanup_confirmed.clone(),
    }));
    let app = app.clone();
    let expected_nonce = nonce.to_owned();
    let control = supervisor.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(mut line) => {
                    if let Some(mut record) = parse_credential_set(&line, &expected_nonce) {
                        let request = record.request;
                        let secret = std::mem::take(&mut record.secret);
                        let ok = credentials::store_refresh_token(secret).is_ok();
                        line.zeroize();
                        let response = serde_json::json!({
                            "protocol": PROTOCOL,
                            "event": "credential-result",
                            "nonce": expected_nonce.as_str(),
                            "request": request,
                            "ok": ok,
                        });
                        if control.write_control(&response).is_err() {
                            eprintln!("AliasMode credential acknowledgement failed");
                        }
                        continue;
                    }
                    if let Some(record) = parse_credential_delete(&line, &expected_nonce) {
                        let ok = credentials::delete_cloud_credential(&record.key).is_ok();
                        line.zeroize();
                        let response = serde_json::json!({
                            "protocol": PROTOCOL,
                            "event": "credential-result",
                            "nonce": expected_nonce.as_str(),
                            "request": record.request,
                            "ok": ok,
                        });
                        if control.write_control(&response).is_err() {
                            eprintln!("AliasMode credential acknowledgement failed");
                        }
                        continue;
                    }
                    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&line) {
                        let protocol = value.get("protocol").and_then(|value| value.as_str());
                        let nonce = value.get("nonce").and_then(|value| value.as_str());
                        let event = value.get("event").and_then(|value| value.as_str());
                        if protocol == Some(PROTOCOL) && nonce == Some(expected_nonce.as_str()) {
                            if event == Some("shutdown-complete") {
                                cleanup_confirmed.store(true, Ordering::Release);
                                status.send_replace(ChildStatus::ShutdownComplete);
                            } else if event == Some("shutdown-failed") {
                                status.send_replace(ChildStatus::ShutdownFailed);
                            }
                        }
                    }
                    line.zeroize();
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("AliasMode sidecar: {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Error(_) => {
                    status.send_replace(ChildStatus::ShutdownFailed);
                }
                CommandEvent::Terminated(exit) => {
                    status.send_replace(ChildStatus::Exited(exit.code));
                    if !shutting_down.load(Ordering::Acquire) {
                        app.exit(1);
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    Ok((supervisor, port))
}

#[cfg(test)]
mod tests {
    use super::{
        parse_credential_delete, parse_credential_set, parse_ready_line, verify_health_record,
        HealthRecord, PROTOCOL, VERSION,
    };
    use std::path::Path;

    const NONCE: &str = "abababababababababababababababababababababababababababababababab";

    #[test]
    fn accepts_only_nonce_and_pid_bound_readiness() {
        let line = serde_json::json!({
            "protocol": PROTOCOL,
            "event": "ready",
            "nonce": NONCE,
            "pid": 42,
            "port": 49152,
        });
        assert_eq!(
            parse_ready_line(line.to_string().as_bytes(), NONCE, 42).unwrap(),
            Some(49152)
        );
        assert!(parse_ready_line(line.to_string().as_bytes(), NONCE, 7).is_err());
        assert_eq!(
            parse_ready_line(b"ordinary log line", NONCE, 42).unwrap(),
            None
        );
    }

    #[test]
    fn accepts_only_nonce_bound_refresh_token_persistence() {
        let line = serde_json::json!({
            "protocol": PROTOCOL,
            "event": "credential-set",
            "nonce": NONCE,
            "request": 1,
            "key": "refresh_token",
            "secret": "rotated-refresh",
        });
        assert!(parse_credential_set(line.to_string().as_bytes(), NONCE).is_some());
        assert!(parse_credential_set(line.to_string().as_bytes(), &"cd".repeat(32)).is_none());

        let wrong_key = serde_json::json!({
            "protocol": PROTOCOL,
            "event": "credential-set",
            "nonce": NONCE,
            "request": 1,
            "key": "access_token",
            "secret": "access",
        });
        assert!(parse_credential_set(wrong_key.to_string().as_bytes(), NONCE).is_none());

        let delete = serde_json::json!({
            "protocol": PROTOCOL,
            "event": "credential-delete",
            "nonce": NONCE,
            "request": 2,
            "key": "device_credential",
        });
        assert!(parse_credential_delete(delete.to_string().as_bytes(), NONCE).is_some());
        let delete_queue = serde_json::json!({
            "protocol": PROTOCOL,
            "event": "credential-delete",
            "nonce": NONCE,
            "request": 3,
            "key": "queue_encryption_key",
        });
        assert!(parse_credential_delete(delete_queue.to_string().as_bytes(), NONCE).is_none());
    }

    #[test]
    fn health_requires_version_root_and_instance() {
        let record = HealthRecord {
            ok: true,
            version: VERSION.to_owned(),
            root: "C:\\AliasMode".to_owned(),
            instance: NONCE.to_owned(),
        };
        assert!(verify_health_record(&record, NONCE, Path::new("C:\\AliasMode")).is_ok());
        assert!(
            verify_health_record(&record, &"cd".repeat(32), Path::new("C:\\AliasMode")).is_err()
        );
        assert!(verify_health_record(&record, NONCE, Path::new("C:\\Other")).is_err());
    }
}

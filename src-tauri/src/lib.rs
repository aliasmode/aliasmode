mod browser;
mod credentials;
mod releases;
mod runtime_descriptor;
mod shutdown;
mod sidecar;

use credentials::{credential_delete, credential_get, credential_set, CredentialOrigin};
use rand::random;
use std::{
    error::Error,
    ffi::OsStr,
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{
    ipc::CapabilityBuilder, webview::NewWindowResponse, Manager, WebviewUrl, WebviewWindowBuilder,
};

#[derive(Default)]
struct PendingFocus(AtomicBool);

fn boxed(error: impl Into<String>) -> Box<dyn Error> {
    io::Error::other(error.into()).into()
}

fn background_requested<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .any(|arg| arg.as_ref() == OsStr::new("--background"))
}

fn packaged_node_package_version(root: &Path, package: &str) -> Result<String, Box<dyn Error>> {
    let manifest = package
        .split('/')
        .fold(root.join("node_modules"), |path, segment| {
            path.join(segment)
        })
        .join("package.json");
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).map_err(|error| {
            boxed(format!(
                "packaged agent dependency is unavailable: {package}: {error}"
            ))
        })?)?;
    value
        .get("version")
        .and_then(|version| version.as_str())
        .map(str::to_owned)
        .ok_or_else(|| {
            boxed(format!(
                "packaged agent dependency has no version: {package}"
            ))
        })
}

fn configured_local_mode(data_dir: &Path) -> bool {
    fs::read(data_dir.join("config.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|config| {
            config.get("version").and_then(|version| version.as_u64()) == Some(1)
                && config.get("mode").and_then(|mode| mode.as_str()) == Some("local")
        })
}

fn cli_compatible_windows_path(path: &Path) -> PathBuf {
    let text = path.as_os_str().to_string_lossy();
    text.strip_prefix(r"\\?\UNC\")
        .map(|path| PathBuf::from(format!(r"\\{path}")))
        .or_else(|| text.strip_prefix(r"\\?\").map(PathBuf::from))
        .unwrap_or_else(|| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::{background_requested, cli_compatible_windows_path, configured_local_mode};
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    #[test]
    fn recognizes_only_the_explicit_background_switch() {
        assert!(background_requested(["aliasmode.exe", "--background"]));
        assert!(!background_requested([
            "aliasmode.exe",
            "--background-worker"
        ]));
        assert!(!background_requested(["aliasmode.exe"]));
    }

    #[test]
    fn recognizes_configured_local_mode() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!configured_local_mode(dir.path()));
        fs::write(
            dir.path().join("config.json"),
            br#"{"version":1,"mode":"local","localAnalytics":false}"#,
        )
        .unwrap();
        assert!(configured_local_mode(dir.path()));
        fs::write(dir.path().join("config.json"), br#"{"mode":"local"}"#).unwrap();
        assert!(!configured_local_mode(dir.path()));
        fs::write(
            dir.path().join("config.json"),
            br#"{"version":1,"mode":"cloud"}"#,
        )
        .unwrap();
        assert!(!configured_local_mode(dir.path()));
    }

    #[test]
    fn removes_windows_namespace_prefix_before_cli_use() {
        assert_eq!(
            cli_compatible_windows_path(Path::new(r"\\?\C:\Users\AliasMode\playwright")),
            PathBuf::from(r"C:\Users\AliasMode\playwright"),
        );
        assert_eq!(
            cli_compatible_windows_path(Path::new(r"\\?\UNC\server\share\playwright")),
            PathBuf::from(r"\\server\share\playwright"),
        );
    }
}

pub fn run() {
    let background = background_requested(std::env::args_os());
    let app = tauri::Builder::default()
        .manage(PendingFocus::default())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if background_requested(argv) {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            } else {
                app.state::<PendingFocus>().0.store(true, Ordering::Release);
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            credential_get,
            credential_set,
            credential_delete,
            runtime_descriptor::agent_runtime_ready,
        ])
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(data_dir.join("profiles"))?;
            fs::create_dir_all(data_dir.join("inbox"))?;

            let resource_dir = app.path().resource_dir()?;
            let browser = browser::verify_browser_resource(&resource_dir).map_err(boxed)?;
            let playwright_runtime = cli_compatible_windows_path(
                &resource_dir
                    .join("playwright")
                    .canonicalize()
                    .map_err(|error| {
                        boxed(format!(
                            "packaged Playwright runtime is unavailable: {error}"
                        ))
                    })?,
            );
            let playwright_manifest = playwright_runtime
                .join("node_modules")
                .join("playwright-core")
                .join("package.json");
            let node_executable = playwright_runtime.join("node").join("node.exe");
            let worker_script = playwright_runtime.join("worker.mjs");
            let agent_root = playwright_runtime.join("agent");
            if !playwright_manifest.is_file()
                || !node_executable.is_file()
                || !worker_script.is_file()
                || !agent_root.join("mcp-host.mjs").is_file()
                || !agent_root.join("playwright-proxy.mjs").is_file()
                || !agent_root.join("playwright-runner.mjs").is_file()
                || !agent_root.join("runtime-client.mjs").is_file()
            {
                return Err(boxed("packaged Playwright and MCP runtime is incomplete"));
            }
            for (package, expected) in [
                ("playwright-core", "1.58.2"),
                ("@modelcontextprotocol/sdk", "1.30.0"),
                ("@playwright/mcp", "0.0.56"),
                ("playwright", "1.58.0-alpha-2026-01-16"),
            ] {
                if packaged_node_package_version(&playwright_runtime, package)? != expected {
                    return Err(boxed(format!(
                        "packaged agent dependency version mismatch: {package}"
                    )));
                }
            }
            if !cfg!(dev) {
                let helper = std::env::current_exe()?
                    .parent()
                    .ok_or_else(|| boxed("AliasMode installation directory is unavailable"))?
                    .join("aliasmode-mcp.exe");
                if !helper.is_file() {
                    return Err(boxed("installed AliasMode agent helper is unavailable"));
                }
            }
            let nonce = hex::encode(random::<[u8; 32]>());
            let agent_nonce = hex::encode(random::<[u8; 32]>());
            let handle = app.handle().clone();
            let (sidecar, port) = tauri::async_runtime::block_on(sidecar::launch_and_verify(
                &handle,
                &data_dir,
                &browser,
                &playwright_runtime,
                &nonce,
                &agent_nonce,
                background,
            ))
            .map_err(boxed)?;

            let runtime_descriptor = runtime_descriptor::RuntimeDescriptorState::new(
                &data_dir,
                nonce,
                agent_nonce,
                port,
                sidecar.pid(),
            )
            .map_err(boxed)?;
            app.manage(runtime_descriptor);

            let origin = format!("http://127.0.0.1:{port}");
            app.manage(CredentialOrigin(origin.clone()));
            app.manage(sidecar.clone());
            if let Err(error) = app.add_capability(
                CapabilityBuilder::new(format!("loopback-{port}"))
                    .local(false)
                    .window("main")
                    .remote(format!("{origin}/*"))
                    .permission("allow-credential-bridge")
                    .permission("allow-runtime-ready"),
            ) {
                let _ = sidecar.kill_owned();
                return Err(error.into());
            }

            let allowed_port = port;
            let url = format!("{origin}/")
                .parse()
                .map_err(|error| boxed(format!("invalid sidecar URL: {error}")))?;
            let window = match WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("AliasMode")
                .visible(!background)
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 640.0)
                .on_navigation(move |url| {
                    (url.scheme() == "http"
                        && url.host_str() == Some("127.0.0.1")
                        && url.port() == Some(allowed_port))
                        || ((url.scheme() == "https" || url.scheme() == "http")
                            && url.host_str() == Some("tauri.localhost"))
                        || (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                })
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()
            {
                Ok(window) => window,
                Err(error) => {
                    let _ = sidecar.kill_owned();
                    return Err(error.into());
                }
            };

            shutdown::install_close_handler(app.handle().clone(), window.clone(), sidecar, origin);
            if app.state::<PendingFocus>().0.swap(false, Ordering::AcqRel) {
                let _ = window.show();
                let _ = window.set_focus();
            } else if background {
                window.hide()?;
            }
            tauri::async_runtime::spawn(releases::check_for_release(app.handle().clone()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("AliasMode desktop failed");

    app.run(move |app, event| {
        if matches!(event, tauri::RunEvent::Ready) {
            if background {
                let Some(window) = app.get_webview_window("main") else {
                    app.exit(1);
                    return;
                };
                if window.hide().is_err() {
                    app.exit(1);
                    return;
                }
            }
            let runtime = app.state::<runtime_descriptor::RuntimeDescriptorState>();
            runtime.activate();
            if app
                .path()
                .app_data_dir()
                .is_ok_and(|data_dir| configured_local_mode(&data_dir))
                && runtime.publish("local").is_err()
            {
                app.exit(1);
            }
        }
        if matches!(event, tauri::RunEvent::Exit) {
            let _ = app
                .state::<runtime_descriptor::RuntimeDescriptorState>()
                .remove_owned();
            let _ = app.state::<sidecar::SidecarSupervisor>().kill_owned();
        }
    });
}

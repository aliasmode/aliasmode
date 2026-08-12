mod browser;
mod credentials;
mod releases;
mod shutdown;
mod sidecar;

use credentials::{credential_delete, credential_get, credential_set, CredentialOrigin};
use rand::random;
use std::{
    error::Error,
    fs, io,
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

pub fn run() {
    let app = tauri::Builder::default()
        .manage(PendingFocus::default())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
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
        ])
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(data_dir.join("profiles"))?;
            fs::create_dir_all(data_dir.join("inbox"))?;

            let resource_dir = app.path().resource_dir()?;
            let browser = browser::verify_browser_resource(&resource_dir).map_err(boxed)?;
            let playwright_runtime =
                resource_dir
                    .join("playwright")
                    .canonicalize()
                    .map_err(|error| {
                        boxed(format!(
                            "packaged Playwright runtime is unavailable: {error}"
                        ))
                    })?;
            let playwright_manifest = playwright_runtime
                .join("node_modules")
                .join("playwright-core")
                .join("package.json");
            let node_executable = playwright_runtime.join("node").join("node.exe");
            let worker_script = playwright_runtime.join("worker.mjs");
            if !playwright_manifest.is_file()
                || !node_executable.is_file()
                || !worker_script.is_file()
            {
                return Err(boxed("packaged Playwright worker is incomplete"));
            }
            let nonce = hex::encode(random::<[u8; 32]>());
            let handle = app.handle().clone();
            let (sidecar, port) = tauri::async_runtime::block_on(sidecar::launch_and_verify(
                &handle,
                &data_dir,
                &browser,
                &playwright_runtime,
                &nonce,
            ))
            .map_err(boxed)?;

            let origin = format!("http://127.0.0.1:{port}");
            app.manage(CredentialOrigin(origin.clone()));
            app.manage(sidecar.clone());
            if let Err(error) = app.add_capability(
                CapabilityBuilder::new(format!("loopback-{port}"))
                    .local(false)
                    .window("main")
                    .remote(format!("{origin}/*"))
                    .permission("allow-credential-bridge"),
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
                let _ = window.set_focus();
            }
            tauri::async_runtime::spawn(releases::check_for_release(app.handle().clone()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("AliasMode desktop failed");

    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let _ = app.state::<sidecar::SidecarSupervisor>().kill_owned();
        }
    });
}

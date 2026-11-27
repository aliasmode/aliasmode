use crate::{credentials::CredentialOrigin, shutdown, sidecar::SidecarSupervisor};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewWindow,
};

const SETTINGS_FILE: &str = "tray.json";

pub struct TrayState {
    settings_path: PathBuf,
    created: AtomicBool,
}

impl TrayState {
    pub fn new(data_dir: &std::path::Path) -> Self {
        Self {
            settings_path: data_dir.join(SETTINGS_FILE),
            created: AtomicBool::new(false),
        }
    }

    pub fn available(&self) -> bool {
        self.created.load(Ordering::Acquire)
    }

    /// `Some(true)` keeps AliasMode in the tray, `Some(false)` quits, `None` asks on close.
    pub fn preference(&self) -> Option<bool> {
        fs::read(&self.settings_path)
            .ok()
            .and_then(|bytes| parse_preference(&bytes))
    }

    pub fn save_preference(&self, value: Option<bool>) -> Result<(), String> {
        let text = serde_json::json!({ "version": 1, "closeToTray": value }).to_string();
        fs::write(&self.settings_path, text).map_err(|error| error.to_string())
    }
}

fn parse_preference(bytes: &[u8]) -> Option<bool> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    if value.get("version")?.as_u64()? != 1 {
        return None;
    }
    value.get("closeToTray")?.as_bool()
}

pub fn show_window(window: &WebviewWindow) {
    // A --background start hides itself on each page load until a reveal is requested.
    window
        .app_handle()
        .state::<crate::RevealRequested>()
        .0
        .store(true, Ordering::Release);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        show_window(&window);
    }
}

/// The appindicator library is loaded when the tray is built and panics if it is missing.
#[cfg(target_os = "linux")]
fn appindicator_installed() -> bool {
    ["libayatana-appindicator3.so.1", "libappindicator3.so.1"]
        .iter()
        .any(|name| {
            let name = std::ffi::CString::new(*name).expect("library name");
            let handle = unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_LAZY) };
            if !handle.is_null() {
                unsafe { libc::dlclose(handle) };
            }
            !handle.is_null()
        })
}

#[cfg(not(target_os = "linux"))]
fn appindicator_installed() -> bool {
    true
}

pub fn install(app: &AppHandle) {
    if !appindicator_installed() {
        eprintln!("AliasMode could not create the tray icon: no appindicator library is installed");
        return;
    }
    match build(app) {
        Ok(()) => app
            .state::<TrayState>()
            .created
            .store(true, Ordering::Release),
        Err(error) => eprintln!("AliasMode could not create the tray icon: {error}"),
    }
}

fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "tray-open", "Open AliasMode", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(include_bytes!("../icons/icon.png"))?)
        .tooltip("AliasMode")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => show_main(app),
            "tray-quit" => {
                if let (Some(window), Some(sidecar)) = (
                    app.get_webview_window("main"),
                    app.try_state::<SidecarSupervisor>(),
                ) {
                    shutdown::quit_after_cleanup(app.clone(), window, sidecar.inner().clone());
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[tauri::command]
pub fn get_close_to_tray(
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    state: tauri::State<'_, TrayState>,
) -> Result<Option<bool>, String> {
    crate::credentials::authorize(&window, &origin)?;
    Ok(state.preference())
}

#[tauri::command]
pub fn set_close_to_tray(
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    state: tauri::State<'_, TrayState>,
    value: Option<bool>,
) -> Result<(), String> {
    crate::credentials::authorize(&window, &origin)?;
    state.save_preference(value)
}

#[cfg(test)]
mod tests {
    use super::parse_preference;

    #[test]
    fn reads_only_a_versioned_boolean() {
        assert_eq!(
            parse_preference(br#"{"version":1,"closeToTray":true}"#),
            Some(true)
        );
        assert_eq!(
            parse_preference(br#"{"version":1,"closeToTray":false}"#),
            Some(false)
        );
        assert_eq!(
            parse_preference(br#"{"version":1,"closeToTray":null}"#),
            None
        );
        assert_eq!(
            parse_preference(br#"{"version":2,"closeToTray":true}"#),
            None
        );
        assert_eq!(parse_preference(br#"{"closeToTray":true}"#), None);
        assert_eq!(parse_preference(b"not json"), None);
    }
}

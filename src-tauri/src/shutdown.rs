use crate::sidecar::SidecarSupervisor;
use reqwest::{redirect::Policy, Client};
use serde::Deserialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{AppHandle, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Default)]
struct CloseState {
    in_progress: AtomicBool,
}

#[derive(Debug, Deserialize)]
struct Roster {
    profiles: Vec<RosterProfile>,
}

#[derive(Debug, Deserialize)]
struct RosterProfile {
    running: bool,
}

async fn active_browser_count(origin: &str) -> Result<usize, String> {
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(format!("{origin}/ui/api/profiles"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() || response.content_length().unwrap_or(0) > 2 * 1024 * 1024 {
        return Err("profile activity is unavailable".to_owned());
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("profile activity is unavailable".to_owned());
    }
    let roster: Roster =
        serde_json::from_slice(&bytes).map_err(|_| "profile activity is unavailable".to_owned())?;
    Ok(roster
        .profiles
        .iter()
        .filter(|profile| profile.running)
        .count())
}

#[derive(Clone, Copy)]
enum CleanupAction {
    Exit,
    Restart,
}

fn finish_after_cleanup(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: SidecarSupervisor,
    action: CleanupAction,
) {
    let _ = window.hide();
    tauri::async_runtime::spawn(async move {
        let result = match sidecar.request_shutdown() {
            Ok(()) => sidecar.wait_for_shutdown().await,
            Err(error) => Err(error),
        };
        match result {
            Ok(()) => match action {
                CleanupAction::Exit => app.exit(0),
                CleanupAction::Restart => app.request_restart(),
            },
            Err(error) => {
                let _ = sidecar.kill_owned();
                app.dialog()
                    .message(format!(
                        "AliasMode could not confirm safe browser cleanup. {error}"
                    ))
                    .title("AliasMode shutdown failed")
                    .kind(MessageDialogKind::Error)
                    .buttons(MessageDialogButtons::Ok)
                    .show(move |_| app.exit(1));
            }
        }
    });
}

#[tauri::command]
pub fn restart_after_mode_change(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: tauri::State<'_, SidecarSupervisor>,
) {
    finish_after_cleanup(app, window, sidecar.inner().clone(), CleanupAction::Restart);
}

fn ask_to_close(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: SidecarSupervisor,
    state: Arc<CloseState>,
    active: Result<usize, String>,
) {
    let message = match active {
        Ok(count) => format!(
            "{count} browser session{} active. AliasMode will save session state and close the browser{} before exiting.",
            if count == 1 { " is" } else { "s are" },
            if count == 1 { "" } else { "s" },
        ),
        Err(_) => "Browser activity could not be confirmed. AliasMode will save session state and close any active browsers before exiting.".to_owned(),
    };
    app.dialog()
        .message(message)
        .title("Close AliasMode?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNo)
        .show(move |confirmed| {
            if confirmed {
                finish_after_cleanup(app, window, sidecar, CleanupAction::Exit);
            } else {
                state.in_progress.store(false, Ordering::Release);
            }
        });
}

pub fn install_close_handler(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: SidecarSupervisor,
    origin: String,
) {
    let state = Arc::new(CloseState::default());
    window.clone().on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if state.in_progress.swap(true, Ordering::AcqRel) {
                return;
            }
            let app = app.clone();
            let window = window.clone();
            let sidecar = sidecar.clone();
            let state = state.clone();
            let origin = origin.clone();
            tauri::async_runtime::spawn(async move {
                let active = active_browser_count(&origin).await;
                if matches!(active, Ok(0)) {
                    finish_after_cleanup(app, window, sidecar, CleanupAction::Exit);
                } else {
                    ask_to_close(app, window, sidecar, state, active);
                }
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{Roster, RosterProfile};

    #[test]
    fn counts_only_active_roster_entries() {
        let roster = Roster {
            profiles: vec![
                RosterProfile { running: true },
                RosterProfile { running: false },
                RosterProfile { running: true },
            ],
        };
        assert_eq!(
            roster
                .profiles
                .iter()
                .filter(|profile| profile.running)
                .count(),
            2
        );
    }
}

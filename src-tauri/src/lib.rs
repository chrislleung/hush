use tauri::{AppHandle, Manager, Emitter};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[tauri::command]
fn update_shortcut(app: AppHandle, old_shortcut: String, new_shortcut: String) -> Result<(), String> {
    let manager = app.global_shortcut();
    if let Ok(old) = old_shortcut.parse::<Shortcut>() {
        let _ = manager.unregister(old);
    }
    match new_shortcut.parse::<Shortcut>() {
        Ok(new) => {
            manager.register(new).map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => Err(format!("Invalid shortcut format: {}", e)),
    }
}

#[tauri::command]
async fn start_audio_capture(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn(async move {
        let sidecar_command = app.shell().sidecar("whisper")
            .expect("Failed to create sidecar")
            .args(["-m", "models/ggml-base.en.bin", "-f", "temp_audio.wav", "--nt"]);

        let output = sidecar_command.output().await.expect("Failed to run whisper");
        let text = String::from_utf8_lossy(&output.stdout);
        if !text.trim().is_empty() {
            let _ = app.emit("transcription", text.trim());
        }
    });
    Ok(())
}

#[tauri::command]
fn stop_audio_capture() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        // RESTORED: This block handles the actual Show/Hide toggle
        .plugin(tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    if let Some(window) = app.get_webview_window("main") {
                        let is_visible = window.is_visible().unwrap_or(false);
                        let is_minimized = window.is_minimized().unwrap_or(false);
                        if is_visible && !is_minimized {
                            let _ = window.hide();
                        } else {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                }
            })
            .build()
        )
        .invoke_handler(tauri::generate_handler![update_shortcut, start_audio_capture, stop_audio_capture])
        .setup(|app| {
            let _ = app.global_shortcut().register("Ctrl+Shift+Space".parse::<Shortcut>().unwrap());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
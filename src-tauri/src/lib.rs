use tauri::{AppHandle, Manager, Emitter, Window};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};

// --- UPDATED: Cloak command with Error Reporting ---
#[tauri::command]
fn cloak_window(window: Window) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                let parsed_hwnd: HWND = std::mem::transmute_copy(&hwnd);
                match SetWindowDisplayAffinity(parsed_hwnd, WDA_EXCLUDEFROMCAPTURE) {
                    Ok(_) => return Ok("Ghost mode activated successfully!".to_string()),
                    Err(e) => return Err(format!("Windows OS rejected the cloak: {}", e)),
                }
            }
        }
        Err("Failed to get Window Handle (HWND)".to_string())
    }
    
    #[cfg(not(target_os = "windows"))]
    Ok("Not on Windows, skipping cloak.".to_string())
}

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
        // Add cloak_window back to the handler!
        .invoke_handler(tauri::generate_handler![update_shortcut, start_audio_capture, stop_audio_capture, cloak_window])
        .setup(|app| {
            let _ = app.global_shortcut().register("Ctrl+Shift+Space".parse::<Shortcut>().unwrap());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
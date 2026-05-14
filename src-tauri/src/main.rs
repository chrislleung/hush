#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{AppHandle, Manager, Emitter, State, WebviewUrl, WebviewWindowBuilder, Window};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use std::sync::{Arc, Mutex};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};

// --- STATE MANAGEMENT ---
struct Shortcuts {
    window: String,
    mic: String,
    desktop: String,
    notes: String,
}
struct AppShortcuts(Arc<Mutex<Shortcuts>>);

struct AudioState {
    // Exact schema: Stream, AudioData, SampleRate (u32), Channels (u16)
    recording: Arc<Mutex<Option<(cpal::Stream, Arc<Mutex<Vec<f32>>>, u32, u16)>>>,
}

// --- CLOAKING ---
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
fn open_notes_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("notes") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }

    let notes_window = WebviewWindowBuilder::new(&app, "notes", WebviewUrl::App("index.html".into()))
        .title("Hush Notes")
        .inner_size(480.0, 440.0)
        .min_inner_size(360.0, 300.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(true)
        .skip_taskbar(true)
        .center()
        .build()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    {
        if let Ok(hwnd) = notes_window.hwnd() {
            unsafe {
                let parsed_hwnd: HWND = std::mem::transmute_copy(&hwnd);
                let _ = SetWindowDisplayAffinity(parsed_hwnd, WDA_EXCLUDEFROMCAPTURE);
            }
        }
    }

    Ok(())
}

// --- HOTKEYS ---
#[tauri::command]
fn update_shortcuts(app: AppHandle, window: String, mic: String, desktop: String, notes: String, state: State<'_, AppShortcuts>) -> Result<(), String> {
    let manager = app.global_shortcut();
    let _ = manager.unregister_all(); 
    {
        let mut s = state.0.lock().unwrap();
        s.window = window.clone();
        s.mic = mic.clone();
        s.desktop = desktop.clone();
        s.notes = notes.clone();
    }
    if let Ok(w) = window.parse::<Shortcut>() { let _ = manager.register(w); }
    if let Ok(m) = mic.parse::<Shortcut>() { let _ = manager.register(m); }
    if let Ok(d) = desktop.parse::<Shortcut>() { let _ = manager.register(d); }
    if let Ok(n) = notes.parse::<Shortcut>() { let _ = manager.register(n); }
    Ok(())
}

// --- NATIVE RECORDING COMMANDS ---
#[tauri::command]
fn start_native_recording(state: State<'_, AudioState>) -> Result<String, String> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or("No output device found")?;
    let supported_config = device.default_output_config().map_err(|e| e.to_string())?;

    // FIX: SampleRate is a direct u32 in your current version of CPAL! No .0 needed.
    let stream_config: cpal::StreamConfig = supported_config.clone().into();
    let sample_rate_val = stream_config.sample_rate; 
    let channels_val = stream_config.channels;

    let samples = Arc::new(Mutex::new(Vec::new()));
    let samples_clone = samples.clone();
    
    let stream = match supported_config.sample_format() {
        cpal::SampleFormat::F32 => {
            device.build_input_stream(
                &stream_config,
                move |data: &[f32], _: &_| {
                    if let Ok(mut lock) = samples_clone.lock() {
                        lock.extend(data.iter().copied());
                    }
                },
                |err| eprintln!("Audio stream error: {}", err),
                None,
            ).map_err(|e| e.to_string())?
        },
        cpal::SampleFormat::I16 => {
            device.build_input_stream(
                &stream_config,
                move |data: &[i16], _: &_| {
                    if let Ok(mut lock) = samples_clone.lock() {
                        lock.extend(data.iter().map(|&x| x as f32 / i16::MAX as f32));
                    }
                },
                |err| eprintln!("Audio stream error: {}", err),
                None,
            ).map_err(|e| e.to_string())?
        },
        cpal::SampleFormat::U16 => {
            device.build_input_stream(
                &stream_config,
                move |data: &[u16], _: &_| {
                    if let Ok(mut lock) = samples_clone.lock() {
                        lock.extend(data.iter().map(|&x| (x as f32 - 32768.0) / 32768.0));
                    }
                },
                |err| eprintln!("Audio stream error: {}", err),
                None,
            ).map_err(|e| e.to_string())?
        },
        _ => return Err("Unsupported audio format".to_string()),
    };

    stream.play().map_err(|e| e.to_string())?;
    
    *state.recording.lock().unwrap() = Some((stream, samples, sample_rate_val, channels_val));

    Ok("Recording system audio stealthily...".to_string())
}

#[tauri::command]
fn stop_native_recording(state: State<'_, AudioState>) -> Result<Vec<u8>, String> {
    let mut recording_lock = state.recording.lock().unwrap();
    if let Some((stream, samples, sample_rate, channels)) = recording_lock.take() {
        drop(stream); 

        let data = samples.lock().unwrap();
        let spec = hound::WavSpec {
            channels,
            sample_rate, 
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };

        let mut cursor = std::io::Cursor::new(Vec::new());
        let mut writer = hound::WavWriter::new(&mut cursor, spec).map_err(|e| e.to_string())?;
        
        for &sample in data.iter() {
            writer.write_sample(sample).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;

        Ok(cursor.into_inner())
    } else {
        Err("No active recording found".to_string())
    }
}

// --- INIT ---
fn main() {
    let initial_shortcuts = Shortcuts {
        window: "Ctrl+Shift+Space".to_string(),
        mic: "Ctrl+Shift+M".to_string(),
        desktop: "Ctrl+Shift+D".to_string(),
        notes: "Ctrl+Shift+N".to_string(),
    };
    
    let app_shortcuts = AppShortcuts(Arc::new(Mutex::new(initial_shortcuts)));
    let audio_state = AudioState { recording: Arc::new(Mutex::new(None)) };

    tauri::Builder::default()
        .manage(app_shortcuts)
        .manage(audio_state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let state = app.state::<AppShortcuts>();
                    let (window_sc, mic_sc, desktop_sc, notes_sc) = {
                        let s = state.0.lock().unwrap();
                        (s.window.clone(), s.mic.clone(), s.desktop.clone(), s.notes.clone())
                    };

                    let is_window = window_sc.parse::<Shortcut>().map(|s| s.id() == shortcut.id()).unwrap_or(false);
                    let is_mic = mic_sc.parse::<Shortcut>().map(|s| s.id() == shortcut.id()).unwrap_or(false);
                    let is_desktop = desktop_sc.parse::<Shortcut>().map(|s| s.id() == shortcut.id()).unwrap_or(false);
                    let is_notes = notes_sc.parse::<Shortcut>().map(|s| s.id() == shortcut.id()).unwrap_or(false);

                    if is_window {
                        if let Some(window) = app.get_webview_window("main") {
                            let is_visible = window.is_visible().unwrap_or(false);
                            let is_minimized = window.is_minimized().unwrap_or(false);
                            if is_visible && !is_minimized { let _ = window.hide(); } 
                            else { let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus(); }
                        }
                    }
                    if is_mic {
                        let _ = app.emit("toggle_mic", ());
                    }
                    if is_desktop {
                        let _ = app.emit("toggle_desktop", ());
                    }
                    if is_notes {
                        let _ = app.emit("toggle_notes", ());
                    }
                }
            })
            .build()
        )
        .invoke_handler(tauri::generate_handler![
            update_shortcuts, 
            open_notes_window,
            cloak_window, 
            start_native_recording, 
            stop_native_recording
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

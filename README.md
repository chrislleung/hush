# HUSH

Hush is a true-stealth, desktop-based AI assistant built specifically to give you an edge in high-stakes meetings. 

Operating as a transparent, glassmorphic overlay on your screen, it natively captures system audio and microphone input, transcribes it in real-time, and feeds it directly into state-of-the-art LLMs via the Groq API. Hush is engineered for absolute privacy, minimizing API costs, and delivering highly structured answers without leaving a trace on your screen shares.

## Core Features

### Ghost Mode (True Stealth)
* **Invisible to Screen Share:** Powered by raw Windows OS APIs (`WDA_EXCLUDEFROMCAPTURE`), the Hush overlay is completely invisible to screen-capturing applications like Zoom, Microsoft Teams, and Discord. You can share your Entire Screen with confidence.
* **Cloaked Companion Windows:** Secondary overlays, including Quick Notes, use the same transparent, always-on-top, screen-capture-protected behavior as the main Hush window.
* **Native Audio Engine:** Hush bypasses standard browser privacy protocols (which trigger "Sharing your screen/audio" popups) by utilizing a custom Rust audio engine (`cpal`). It intercepts system loopback audio directly in RAM, resulting in a zero-footprint, pop-up-free recording experience.

### Quick Notes Overlay
Hush includes a separate stealth notes window for prewritten talking points and interview reminders:
* **Separate Notes Window:** Click `Notes` to open a dedicated transparent overlay instead of splitting space with the chat.
* **Reusable Cue Cards:** Save premade notes like "Tell me about yourself" and select them from a compact grid of note tabs.
* **View/Edit Modes:** Use `View` mode as a clean read-only cue card during a meeting, then switch to `Edit` mode to update the title and body.
* **Delete Confirmation:** Deleting a note opens a confirmation dialog so prepared notes are not removed accidentally.
* **No Native Tooltips:** Note tabs intentionally avoid browser hover tooltips to keep note text hidden and distraction-free.
* **Position Memory:** The notes window reopens where you last moved it. If there is no saved position yet, it opens in the top-left corner.

### Optimized AI Modes
Custom-engineered system prompts designed to bypass AI fluff and deliver exactly what you need in a high-pressure environment:
* **Bullet (Quick):** Rapid-fire, conceptual answers formatted as Markdown lists. Covers logic, algorithmic steps, and Big-O complexity. Zero code output.
* **Detailed:** In-depth, step-by-step reasoning for deep-dive technical explanations.
* **Code Only:** Outputs an optimal, production-ready code block *first*, followed immediately by a brief bulleted explanation so you can talk through the logic out loud.

### Advanced Session Management (Multi-Tab)
Because stateless AI APIs charge you for your entire chat history on every request, Hush features a fully persistent tab system to save you tokens:
* **Create/Rename/Delete:** Spin up isolated sessions, double-click to rename them, and clear the slate when moving to a new question.
* **Local Storage:** All history is saved securely to your local machine.
* **Data Recovery (Recycle Bin):** Accidentally close a tab? It is safely moved to a collapsible "Recently Closed" accordion menu. Includes a customizable self-destruct timer (retention days), quick-restore, and session summaries.

### Bring Your Own Key & Token Tracking
* **BYOK Architecture:** Securely input your own Groq API key directly into the settings.
* **Live Token Tracker:** Tracks your daily token usage across 12+ supported models (Llama 3.3 70B, Qwen, Groq Compound, etc.) and visually compares it against the exact Groq Free Tier limits.

### Global Controls
* **Global Hotkeys:** Powered by the Rust backend, configure system-wide shortcuts to toggle the app window, mute/unmute your mic, start/stop stealth audio recording, and toggle the Quick Notes window without ever clicking the app.
* **Overlapping Shortcuts Allowed:** The Notes hotkey can intentionally match the main Hush window hotkey, allowing one keypress to hide/show the main overlay while toggling notes.
* **Glassmorphism UI:** Features a sleek, dark-mode, transparent aesthetic with adjustable background opacity.

---

## Tech Stack

* **Frontend:** React 19, TypeScript, Vite
* **Backend Framework:** Tauri v2 (Rust)
* **Native OS Integrations:** `windows` crate (cloaking APIs), `cpal` & `hound` (in-memory loopback audio capture), `tauri-plugin-global-shortcut`
* **Styling:** Custom CSS (Apple-style frosted glassmorphism)
* **AI & API:** Groq SDK, Whisper-large-v3, Llama 3 / Qwen families
* **Markdown Rendering:** `react-markdown`, `remark-gfm`

---

## Getting Started

### Prerequisites
You will need [Node.js](https://nodejs.org/) and [Rust](https://www.rust-lang.org/tools/install) installed on your machine to build the Tauri desktop app.

### Installation

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/yourusername/hush.git](https://github.com/yourusername/hush.git)
   cd hush
   ```
2. Install frontend dependencies:
   ```bash
   npm install
   ```
3. Run the development server:
   ```bash
   npm run tauri dev
   ```
   On Windows PowerShell, if script execution policy blocks `npm`, use:
   ```bash
   npm.cmd run tauri dev
   ```
4. Building for Production:
   To package the app into a standalone, installable executable (.exe):
   ```bash
   npm run tauri build
   ```
   
---

## Usage Tips
The Screen Share Trick: To fully utilize Hush's ghost technology, you must select "Share Entire Screen" in Zoom or Discord. If you choose to share a specific application window (like VS Code), the OS-level cloaking cannot protect the overlay bounds. Sharing your whole screen guarantees the app remains invisible to the capture buffer.

Optimizing Tokens: If an interviewer moves on to a completely new topic (e.g., from a Hash Map question to System Design), open a New Tab (+)! This prevents the app from resending the massive Hash Map chat history to the API, saving you thousands of tokens.

Number Inputs: The "Retention Days" setting uses a custom text-field approach to bypass ugly browser spinner arrows, allowing you to seamlessly type a number or use your physical Up/Down arrow keys.

Quick Notes: Use the `Notes` button or your configured Toggle Notes hotkey to open the companion notes overlay. Notes are saved locally, can be read in View mode, edited in Edit mode, and reopened at their last screen position.

Shared Hotkeys: If you want one shortcut to hide the main Hush window and open/close notes, set `Toggle Window` and `Toggle Notes` to the same value in Settings.

## Privacy

All chat logs, saved notes, audio transcriptions, and API keys are stored entirely locally on your machine via the WebView's localStorage. No data is routed through third-party servers other than the direct API calls to Groq. System audio is processed entirely in your RAM and instantly destroyed after transcription.

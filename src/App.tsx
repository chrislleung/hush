import { useState, useEffect, KeyboardEvent, useRef } from "react";
import Groq from "groq-sdk";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event"; // NEW: Needed to listen to Rust
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

const groq = new Groq({
  apiKey: import.meta.env.VITE_GROQ_API_KEY,
  dangerouslyAllowBrowser: true,
});

interface Message { role: "user" | "assistant" | "system"; content: string; }

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isListeningMic, setIsListeningMic] = useState(false);
  const [isDesktopConnected, setIsDesktopConnected] = useState(false);
  const [isRecordingDesktop, setIsRecordingDesktop] = useState(false);
  
  // Persistent Settings
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem("selectedModel") || "llama-3.3-70b-versatile");
  const [bgOpacity, setBgOpacity] = useState(() => parseFloat(localStorage.getItem("bgOpacity") || "0.85"));
  const [answerStyle, setAnswerStyle] = useState(() => localStorage.getItem("answerStyle") || "default");

  // Daily Token Tracker
  const [dailyTokens, setDailyTokens] = useState<Record<string, number>>(() => {
    const saved = localStorage.getItem("dailyTokensObj");
    return saved ? JSON.parse(saved) : {};
  });
  const [lastTokenDate, setLastTokenDate] = useState(() => localStorage.getItem("lastTokenDate") || new Date().toDateString());

  //Auto-Send State
  const [autoSend, setAutoSend] = useState(() => localStorage.getItem("autoSend") === "true");
  
  // HOTKEY STATES
  const [windowShortcut, setWindowShortcut] = useState(() => localStorage.getItem("windowShortcut") || "Ctrl+Shift+Space");
  const [micShortcut, setMicShortcut] = useState(() => localStorage.getItem("micShortcut") || "Ctrl+Shift+M");
  const [desktopShortcut, setDesktopShortcut] = useState(() => localStorage.getItem("desktopShortcut") || "Ctrl+Shift+D");

  const [showSettings, setShowSettings] = useState(false);
  
  // Track which hotkey input is actively being recorded
  const [drafts, setDrafts] = useState({ window: windowShortcut, mic: micShortcut, desktop: desktopShortcut });
  const [recordingTarget, setRecordingTarget] = useState<"window" | "mic" | "desktop" | null>(null);

  const recognitionRef = useRef<any>(null);
  const desktopStreamRef = useRef<MediaStream | null>(null);
  const desktopRecorderRef = useRef<MediaRecorder | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  //Memory Banks for background functions to access live data
  const autoSendRef = useRef(autoSend);
  const inputRef = useRef(input);
  const messagesRef = useRef(messages);
  const selectedModelRef = useRef(selectedModel);
  const answerStyleRef = useRef(answerStyle);

  useEffect(() => { 
    localStorage.setItem("autoSend", autoSend.toString());
    autoSendRef.current = autoSend; 
  }, [autoSend]);
  useEffect(() => { inputRef.current = input; }, [input]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { selectedModelRef.current = selectedModel; }, [selectedModel]);
  useEffect(() => { answerStyleRef.current = answerStyle; }, [answerStyle]);
  
  // --- INITIALIZATION & SYNC ---
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, isLoading]);

  useEffect(() => {
    localStorage.setItem("bgOpacity", bgOpacity.toString());
    localStorage.setItem("selectedModel", selectedModel);
    localStorage.setItem("answerStyle", answerStyle);
  }, [bgOpacity, selectedModel, answerStyle]);

  // Sync Hotkeys to Rust on Startup
  useEffect(() => {
    invoke("update_shortcuts", { window: windowShortcut, mic: micShortcut, desktop: desktopShortcut })
      .catch(e => console.error("Initial hotkey sync failed:", e));
  }, []);

  // Reset tokens if it's a new day, and sync to localStorage
  useEffect(() => {
    const today = new Date().toDateString();
    if (lastTokenDate !== today) {
      setDailyTokens({}); // Wipe the slate clean for all models
      setLastTokenDate(today);
      localStorage.setItem("dailyTokensObj", "{}");
      localStorage.setItem("lastTokenDate", today);
    } else {
      localStorage.setItem("dailyTokensObj", JSON.stringify(dailyTokens));
      localStorage.setItem("lastTokenDate", lastTokenDate);
    }
  }, [dailyTokens, lastTokenDate]);

  // --- NATIVE ACTIONS ---
  const toggleMic = () => {
    if (isListeningMic) {
      recognitionRef.current?.stop();
      setIsListeningMic(false);
      return;
    }
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return alert("Browser does not support Web Speech API.");

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event: any) => {
      let finalTranscript = "";
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript;
      }
      if (finalTranscript) {
        const newText = (inputRef.current + " " + finalTranscript).trim();
        setInput(newText);
        inputRef.current = newText; // Update memory bank instantly
      }
    };
    recognition.onerror = (e: any) => console.error(e);
    recognition.onend = () => {
      setIsListeningMic(false);
      // NEW: Auto-send the exact moment the mic finishes shutting down
      if (autoSendRef.current && inputRef.current.trim()) {
        handleSend(inputRef.current);
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListeningMic(true);
  };

  const toggleDesktopConnection = async () => {
    if (isDesktopConnected) {
      desktopStreamRef.current?.getTracks().forEach(t => t.stop());
      desktopStreamRef.current = null;
      setIsDesktopConnected(false);
      if (isRecordingDesktop) {
        desktopRecorderRef.current?.stop();
        setIsRecordingDesktop(false);
      }
    } else {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const audioTrack = stream.getAudioTracks()[0];
        if (!audioTrack) throw new Error("No audio track found.");
        
        desktopStreamRef.current = new MediaStream([audioTrack]);
        setIsDesktopConnected(true);
        stream.getVideoTracks()[0].onended = () => {
          setIsDesktopConnected(false);
          desktopStreamRef.current = null;
          setIsRecordingDesktop(false);
        };
      } catch (err: any) {
        if (err.name === "NotAllowedError") return; 
        alert("Failed to connect. Ensure you check 'Share system audio'.");
      }
    }
  };

  const toggleDesktopRecording = () => {
    if (!isDesktopConnected || !desktopStreamRef.current) {
      alert("Please click the 🖥️/🔌 button to connect your screen first before using the hotkey!");
      return;
    }

    if (isRecordingDesktop && desktopRecorderRef.current) {
      desktopRecorderRef.current.stop();
      setIsRecordingDesktop(false);
    } else {
      const recorder = new MediaRecorder(desktopStreamRef.current);
      const audioChunks: Blob[] = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
      recorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        const file = new File([audioBlob], "question.webm", { type: 'audio/webm' });
        
        if (!autoSendRef.current) setInput("Transcribing question...");
        
        try {
          const transcription = await groq.audio.transcriptions.create({ file: file, model: "whisper-large-v3" });
          
          if (autoSendRef.current) {
            setInput(""); // Clear text
            handleSend(transcription.text); // Fire away instantly
          } else {
            setInput((prev) => prev.replace("Transcribing question...", transcription.text));
          }
        } catch (error) { 
          if (!autoSendRef.current) setInput((prev) => prev.replace("Transcribing question...", "Error transcribing.")); 
        }
      };

      desktopRecorderRef.current = recorder;
      recorder.start();
      setIsRecordingDesktop(true);
    }
  };

  // --- RUST EVENT LISTENERS ---
  // We use a ref to ensure the event listeners always trigger the most recent versions of the functions
  const actionsRef = useRef({ toggleMic, toggleDesktopRecording });
  useEffect(() => { actionsRef.current = { toggleMic, toggleDesktopRecording }; }, [toggleMic, toggleDesktopRecording]);

  useEffect(() => {
    const unlistenMic = listen("toggle_mic", () => actionsRef.current.toggleMic());
    const unlistenDesk = listen("toggle_desktop", () => actionsRef.current.toggleDesktopRecording());
    return () => {
      unlistenMic.then(f => f());
      unlistenDesk.then(f => f());
    };
  }, []);

  // --- CHAT LOGIC ---
  const handleSend = async (textToSend: string) => {
    if (!textToSend.trim() || isLoading) return;
    const userMessage: Message = { role: "user", content: textToSend };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    // Pull from refs to ensure background tasks always have the latest settings
    let systemPrompt = "You are a concise, helpful assistant.";
    const style = answerStyleRef.current;
    
    if (style === "quick") systemPrompt = "You are an expert. Give extremely brief, direct, and rapid-fire answers. You MUST output your response as a standard Markdown list, placing EVERY bullet point on a NEW LINE using the '-' character. No fluff, no introductory filler, and no concluding paragraphs. Just the raw facts.";
    else if (style === "detailed") systemPrompt = "You are an expert tutor. Provide comprehensive, highly detailed explanations with step-by-step reasoning and examples.";
    else if (style === "code") systemPrompt = "You are a senior developer. Provide ONLY functional code in markdown blocks. Do NOT output any conversational text, pleasantries, or explanations outside the code blocks.";

    try {
      const response = await groq.chat.completions.create({ 
        model: selectedModelRef.current, 
        messages: [{ role: "system", content: systemPrompt }, ...messagesRef.current, userMessage] 
      });
      
      setMessages((prev) => [...prev, { role: "assistant", content: response.choices[0].message.content || "" }]);
      
      // Add the tokens used in this request to your daily total for that model
      if (response.usage && response.usage.total_tokens) {
        const usedTokens = response.usage.total_tokens;
        const modelUsed = selectedModelRef.current;
        
        setDailyTokens(prev => ({
          ...prev,
          [modelUsed]: (prev[modelUsed] || 0) + usedTokens
        }));
      }
      
    } catch (error) { console.error(error); } 
    finally { setIsLoading(false); }
  };
  // --- HOTKEY CAPTURE LOGIC ---
  const handleHotkeyCapture = (e: KeyboardEvent<HTMLInputElement>, target: "window" | "mic" | "desktop") => {
    e.preventDefault();
    let keys = [];
    if (e.metaKey) keys.push("Super"); 
    if (e.ctrlKey) keys.push("Ctrl");
    if (e.altKey) keys.push("Alt");
    if (e.shiftKey) keys.push("Shift");

    const key = e.key;
    if (!["Control", "Shift", "Alt", "Meta"].includes(key)) {
      let finalKey = key;
      if (finalKey === " ") finalKey = "Space";
      else if (finalKey === "Escape") finalKey = "Esc";
      else if (finalKey.startsWith("Arrow")) finalKey = finalKey.replace("Arrow", "");
      else if (finalKey.length === 1) finalKey = finalKey.toUpperCase(); 
      else finalKey = finalKey.charAt(0).toUpperCase() + finalKey.slice(1); 
      
      keys.push(finalKey);
      setDrafts(prev => ({ ...prev, [target]: keys.join("+") }));
      setRecordingTarget(null);
    } else {
      setDrafts(prev => ({ ...prev, [target]: keys.join("+") + "+..." }));
    }
  };

  const handleSaveShortcuts = async () => {
    if (drafts.window.includes("...") || drafts.mic.includes("...") || drafts.desktop.includes("...")) return alert("Please finish recording your shortcuts.");
    try {
      await invoke("update_shortcuts", { window: drafts.window, mic: drafts.mic, desktop: drafts.desktop });
      setWindowShortcut(drafts.window); setMicShortcut(drafts.mic); setDesktopShortcut(drafts.desktop);
      localStorage.setItem("windowShortcut", drafts.window);
      localStorage.setItem("micShortcut", drafts.mic);
      localStorage.setItem("desktopShortcut", drafts.desktop);
      setShowSettings(false);
    } catch (e) { alert("Error saving hotkeys: " + e); }
  };

  return (
    <div className="overlay-container" style={{ backgroundColor: `rgba(12, 12, 16, ${bgOpacity})` }}>
      <div className="drag-handle" data-tauri-drag-region>
        <div className="header-title" data-tauri-drag-region>Meeting Copilot</div>
        <div className="header-controls">
          <button className="control-btn" onClick={() => setShowSettings(!showSettings)}>⚙️</button>
          <button className="control-btn" onClick={() => getCurrentWindow().hide()}>_</button>
        </div>
      </div>

      {showSettings && (
        <div className="settings-panel">
          <div className="setting-row"><label>Opacity</label><input type="range" className="modern-slider" min="0.1" max="1" step="0.1" value={bgOpacity} onChange={e => setBgOpacity(parseFloat(e.target.value))} /></div>
          {/* Token Display */}
          <div className="setting-row">
            <label>Today's Tokens Used For This Model</label>
            <span style={{ color: '#4CAF50', fontWeight: 'bold', fontSize: '0.9em' }}>
              {/* Fallback to 0 if the currently selected model hasn't been used yet today */}
              {(dailyTokens[selectedModel] || 0).toLocaleString()}
            </span>
          </div>
          
          <div className="setting-row">
            <label>AI Model</label>
            <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} className="model-selector-settings">
              {/* Your existing models */}
              <option value="llama-3.3-70b-versatile">Llama 3.3 (70B)</option>
              <option value="llama-3.1-8b-instant">Llama 3.1 (8B)</option>
              
              {/* NEW: Add any model from your Groq limits page here! */}
              <option value="gemma2-9b-it">Gemma 2 (9B)</option>
              <option value="mixtral-8x7b-32768">Mixtral (8x7B)</option>
              <option value="qwen-2.5-32b">Qwen 2.5 (32B)</option>
              <option value="deepseek-r1-distill-llama-70b">DeepSeek R1 (70B)</option>
            </select>
          </div>
          
          <hr style={{ borderColor: 'rgba(255,255,255,0.1)', margin: '10px 0' }}/>
          <label style={{ fontSize: '0.85em', color: '#aaa', marginBottom: '8px', display: 'block' }}>Global Hotkeys</label>
          
          <div className="hotkey-grid">
            <div className="hotkey-col">
              <label>Toggle Window</label>
              <input type="text" className={`hotkey-input ${recordingTarget === 'window' ? 'recording' : ''}`} value={drafts.window} readOnly onFocus={() => setRecordingTarget('window')} onBlur={() => setRecordingTarget(null)} onKeyDown={e => handleHotkeyCapture(e, 'window')} />
            </div>
            
            <div className="hotkey-col">
              <label>Toggle Mic</label>
              <input type="text" className={`hotkey-input ${recordingTarget === 'mic' ? 'recording' : ''}`} value={drafts.mic} readOnly onFocus={() => setRecordingTarget('mic')} onBlur={() => setRecordingTarget(null)} onKeyDown={e => handleHotkeyCapture(e, 'mic')} />
            </div>
            
            <div className="hotkey-col">
              <label>Record Desktop</label>
              <input type="text" className={`hotkey-input ${recordingTarget === 'desktop' ? 'recording' : ''}`} value={drafts.desktop} readOnly onFocus={() => setRecordingTarget('desktop')} onBlur={() => setRecordingTarget(null)} onKeyDown={e => handleHotkeyCapture(e, 'desktop')} />
            </div>
          </div>

          <div className="setting-row">
            <label>Auto-Send Audio</label>
            <label className="toggle-switch">
              <input type="checkbox" checked={autoSend} onChange={e => setAutoSend(e.target.checked)} />
              <span className="slider"></span>
            </label>
          </div>

          <div className="setting-row" style={{ justifyContent: 'flex-end', marginTop: '10px' }}>
            <button className="save-btn" onClick={handleSaveShortcuts}>Save Settings</button>
          </div>
        </div>
      )}

      <div className="content">
        {messages.map((m, i) => (
          <div key={i} className={m.role === "assistant" ? "ai-suggestion markdown-body" : "user-message"}>
            {m.role === "assistant" ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown> : m.content}
          </div>
        ))}
        {isLoading && <div className="ai-suggestion">Thinking...</div>}
        <div ref={messagesEndRef} />
      </div>

      <div className="input-area">
        <select className="style-selector" value={answerStyle} onChange={(e) => setAnswerStyle(e.target.value)}>
          <option value="default">Default</option><option value="quick">Bullet</option><option value="detailed">Detailed</option><option value="code">Code Only</option>
        </select>
        <button className={`mic-btn ${isDesktopConnected ? 'listening' : ''}`} onClick={toggleDesktopConnection}>{isDesktopConnected ? '🔌' : '🖥️'}</button>
        {isDesktopConnected && ( <button className={`mic-btn ${isRecordingDesktop ? 'listening recording-pulse' : ''}`} onClick={toggleDesktopRecording} style={{ backgroundColor: isRecordingDesktop ? '#ff4444' : '#444' }}>{isRecordingDesktop ? '⏹️' : '⏺️'}</button> )}
        <button className={`mic-btn ${isListeningMic ? 'listening' : ''}`} onClick={toggleMic}>{isListeningMic ? '🎙️' : '🎤'}</button>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && handleSend(input)} placeholder="Ask Copilot..." />
      </div>
    </div>
  );
}
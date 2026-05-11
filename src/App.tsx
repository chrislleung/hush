import { useState, useEffect, KeyboardEvent, useRef } from "react";
import Groq from "groq-sdk";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event"; // NEW: Needed to listen to Rust
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

//from hardcoded API key 
// const groq = new Groq({
//   apiKey: import.meta.env.VITE_GROQ_API_KEY,
//   dangerouslyAllowBrowser: true,
// });

interface Message { role: "user" | "assistant" | "system"; content: string; }
interface ChatTab { id: string; title: string; messages: Message[]; }
interface DeletedTab extends ChatTab { deletedAt: number; }

export default function App() {
  // --- CHAT & TAB STATE ---
  const [tabs, setTabs] = useState<ChatTab[]>(() => {
    const saved = localStorage.getItem("chatTabs");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.length > 0) return parsed;
    }
    return [{ id: "tab-1", title: "Session 1", messages: [] }];
  });
  
  const [activeTabId, setActiveTabId] = useState<string>(() => {
    const savedId = localStorage.getItem("activeTabId");
    const savedTabs = localStorage.getItem("chatTabs");
    const parsedTabs = savedTabs ? JSON.parse(savedTabs) : [];
    return savedId && parsedTabs.some((t: ChatTab) => t.id === savedId) ? savedId : "tab-1";
  });

  const activeMessages = tabs.find(t => t.id === activeTabId)?.messages || [];

  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isListeningMic, setIsListeningMic] = useState(false);
  const [isDesktopConnected, setIsDesktopConnected] = useState(false);
  const [isRecordingDesktop, setIsRecordingDesktop] = useState(false);
  
  // Persistent Settings
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem("selectedModel") || "llama-3.3-70b-versatile");
  const [bgOpacity, setBgOpacity] = useState(() => parseFloat(localStorage.getItem("bgOpacity") || "0.85"));
  const [answerStyle, setAnswerStyle] = useState(() => localStorage.getItem("answerStyle") || "default");

  const [apiKey, setApiKey] = useState(() => localStorage.getItem("apiKey") || "");
  const apiKeyRef = useRef(apiKey);

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
  const messagesRef = useRef(activeMessages);
  const selectedModelRef = useRef(selectedModel);
  const answerStyleRef = useRef(answerStyle);

  //Collapsible state for Recycle Bin
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false);

  const MODEL_LIMITS: Record<string, string> = {
    "allam-2-7b": "500K",
    "groq/compound": "No limit",
    "groq/compound-mini": "No limit",
    "llama-3.1-8b-instant": "500K",
    "llama-3.3-70b-versatile": "100K",
    "meta-llama/llama-4-scout-17b-16e-instruct": "500K",
    "meta-llama/llama-prompt-guard-2-22m": "500K",
    "meta-llama/llama-prompt-guard-2-86m": "500K",
    "openai/gpt-oss-120b": "200K",
    "openai/gpt-oss-20b": "200K",
    "openai/gpt-oss-safeguard-20b": "200K",
    "qwen/qwen3-32b": "500K",
  };

  

  // Sync API Key to localStorage and update the ref
  useEffect(() => { 
    localStorage.setItem("apiKey", apiKey);
    apiKeyRef.current = apiKey;
  }, [apiKey]);

  useEffect(() => { 
    localStorage.setItem("autoSend", autoSend.toString());
    autoSendRef.current = autoSend; 
  }, [autoSend]);
  useEffect(() => { inputRef.current = input; }, [input]);
  const activeTabIdRef = useRef(activeTabId);

  useEffect(() => { 
    localStorage.setItem("chatTabs", JSON.stringify(tabs));
  }, [tabs]);
  
  useEffect(() => { 
    localStorage.setItem("activeTabId", activeTabId);
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  // Point the background memory bank to whatever tab is currently open
  useEffect(() => { messagesRef.current = activeMessages; }, [activeMessages]);

  useEffect(() => { selectedModelRef.current = selectedModel; }, [selectedModel]);
  useEffect(() => { answerStyleRef.current = answerStyle; }, [answerStyle]);
  
  // --- INITIALIZATION & SYNC ---
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [activeMessages, isLoading]);
  useEffect(() => {
    localStorage.setItem("bgOpacity", bgOpacity.toString());
    localStorage.setItem("selectedModel", selectedModel);
    localStorage.setItem("answerStyle", answerStyle);
  }, [bgOpacity, selectedModel, answerStyle]);
  
  //Data Recovery State
  const [retentionDays, setRetentionDays] = useState(() => parseInt(localStorage.getItem("retentionDays") || "2"));
  const [deletedTabs, setDeletedTabs] = useState<DeletedTab[]>(() => {
    const saved = localStorage.getItem("deletedTabs");
    return saved ? JSON.parse(saved) : [];
  });

  // Sync Hotkeys to Rust on Startup
  useEffect(() => {
    setTimeout(() => {
      invoke<string>("cloak_window")
        .then(msg => console.log(msg))
        .catch(e => console.error("CRITICAL CLOAK ERROR:", e));
    }, 500);
    
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


  // Sync Data Recovery settings to local storage
  useEffect(() => { 
    localStorage.setItem("retentionDays", retentionDays.toString()); 
  }, [retentionDays]);
  
  useEffect(() => { 
    localStorage.setItem("deletedTabs", JSON.stringify(deletedTabs)); 
  }, [deletedTabs]);

  // Auto-Purge Expired Tabs
  // This runs on app startup and whenever they change the slider
  useEffect(() => {
    const now = Date.now();
    const msInDay = 24 * 60 * 60 * 1000;
    setDeletedTabs(prev => prev.filter(t => now - t.deletedAt < retentionDays * msInDay));
  }, [retentionDays]);

  // --- TAB CONTROLS ---
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const createNewTab = () => {
    const newTab: ChatTab = { id: Date.now().toString(), title: `Session ${tabs.length + 1}`, messages: [] };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const deleteTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tabs.length === 1) return; 
    
    // NEW: Save to Recycle Bin before deleting
    const tabToDelete = tabs.find(t => t.id === id);
    if (tabToDelete) {
      setDeletedTabs(prev => [{ ...tabToDelete, deletedAt: Date.now() }, ...prev]);
    }

    setTabs(prev => {
      const newTabs = prev.filter(t => t.id !== id);
      if (activeTabId === id) setActiveTabId(newTabs[newTabs.length - 1].id);
      return newTabs;
    });
  };

  // NEW: Restore a tab from the Recycle Bin
  const restoreTab = (id: string) => {
    const tabToRestore = deletedTabs.find(t => t.id === id);
    if (tabToRestore) {
      setDeletedTabs(prev => prev.filter(t => t.id !== id)); // Remove from trash
      const { deletedAt, ...restoredTab } = tabToRestore; // Strip the timestamp
      setTabs(prev => [...prev, restoredTab]); // Add back to active tabs
      setActiveTabId(restoredTab.id); // Instantly jump to it
    }
  };
  // Renaming Functions
  const startRenaming = (tab: ChatTab, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingTabId(tab.id);
    setEditingTitle(tab.title);
  };

  // Permanently delete a tab from memory
  const permanentlyDeleteTab = (id: string) => {
    setDeletedTabs(prev => prev.filter(t => t.id !== id));
  };

  // Generate a quick summary from the first user message
  const getTabSummary = (tab: DeletedTab) => {
    const firstUserMsg = tab.messages.find(m => m.role === "user");
    if (!firstUserMsg) return "Empty session...";
    const text = firstUserMsg.content;
    return text.length > 45 ? text.substring(0, 45) + "..." : text;
  };

  const saveTabName = (id: string) => {
    if (editingTitle.trim()) {
      setTabs(prev => prev.map(t => t.id === id ? { ...t, title: editingTitle.trim() } : t));
    }
    setEditingTabId(null);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent, id: string) => {
    if (e.key === 'Enter') saveTabName(id);
    if (e.key === 'Escape') setEditingTabId(null);
  };

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
        
        if (!apiKeyRef.current) {
          setInput("Error: Please add your Groq API key in Settings.");
          setShowSettings(true);
          return;
        }

        if (!autoSendRef.current) setInput("Transcribing question...");
        
        try {
          // NEW: Initialize Groq dynamically here too
          const userGroq = new Groq({ apiKey: apiKeyRef.current, dangerouslyAllowBrowser: true });
          const transcription = await userGroq.audio.transcriptions.create({ file: file, model: "whisper-large-v3" });
          
          if (autoSendRef.current) {
            setInput(""); 
            handleSend(transcription.text); 
          } else {
            setInput((prev) => prev.replace("Transcribing question...", transcription.text));
          }
        } catch (error) { 
          if (!autoSendRef.current) setInput((prev) => prev.replace("Transcribing question...", "Error transcribing audio. Check your API key.")); 
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
    
    // Check if they provided a key first!
    if (!apiKeyRef.current) {
      alert("Please enter your Groq API Key in the settings (⚙️) first!");
      setShowSettings(true);
      return;
    }

    const userMessage: Message = { role: "user", content: textToSend };
    setTabs(prev => prev.map(tab => 
      tab.id === activeTabIdRef.current ? { ...tab, messages: [...tab.messages, userMessage] } : tab
    ));
    setInput("");
    setIsLoading(true);

    let systemPrompt = "You are a concise, helpful assistant.";
    const style = answerStyleRef.current;

    if (style === "quick") {
      systemPrompt = "You are an expert software engineer in a technical interview. Give brief, direct answers formatted as a Markdown list — every bullet on its own line using '-'. No filler, no conclusions. For every question, you MUST cover: the approach/strategy, the step-by-step logic, Big-O time and space complexity, and any key trade-offs. Never give a one-line answer — always break down the full reasoning. Never output raw code or code blocks under any circumstances.";    } 
    else if (style === "detailed") {
      systemPrompt = "You are an expert senior developer and technical tutor. Give comprehensive, in-depth explanations. Break down complex concepts with step-by-step reasoning, real-world examples, and established best practices. Emphasize the 'why' and 'how' throughout. Code snippets are allowed only when they meaningfully clarify the explanation — keep them minimal.";
    } 
    else if (style === "code") {
      systemPrompt = "You are a senior software engineer in a technical interview. Output the optimal, production-ready solution in a single Markdown code block. Follow it immediately with a rapid-fire Markdown list — every bullet on its own line using '-' — covering the core logic, key implementation decisions, and exact Big-O time and space complexity. No conversational text, pleasantries, or filler of any kind.";
    }

    try {
      // NEW: Initialize Groq dynamically using their saved key
      const userGroq = new Groq({ apiKey: apiKeyRef.current, dangerouslyAllowBrowser: true });
      
      const response = await userGroq.chat.completions.create({ 
        model: selectedModelRef.current, 
        messages: [{ role: "system", content: systemPrompt }, ...messagesRef.current, userMessage] 
      });
      
      setTabs(prev => prev.map(tab => 
        tab.id === activeTabIdRef.current ? { ...tab, messages: [...tab.messages, { role: "assistant", content: response.choices[0].message.content || "" }] } : tab
      ));      
      if (response.usage && response.usage.total_tokens) {
        const usedTokens = response.usage.total_tokens;
        const modelUsed = selectedModelRef.current;
        setDailyTokens(prev => ({ ...prev, [modelUsed]: (prev[modelUsed] || 0) + usedTokens }));
      }
      
    } catch (error: any) { 
      console.error(error); 
      setTabs(prev => prev.map(tab => 
        tab.id === activeTabIdRef.current ? { ...tab, messages: [...tab.messages, { role: "assistant", content: `**Error:** ${error.message || "Failed to fetch response."}` }] } : tab
      ));
    } 
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
        <div className="header-title" data-tauri-drag-region>Hush</div>
        <div className="header-controls">
          <button className="control-btn" onClick={() => setShowSettings(!showSettings)}>⚙️</button>
          <button className="control-btn" onClick={() => getCurrentWindow().hide()}>_</button>
        </div>
      </div>

      {showSettings && (
        <div className="settings-panel">

          {/* BYOK Input Field */}
          <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '6px' }}>
            <label>Groq API Key <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" style={{color: '#4CAF50', fontSize: '0.8em', textDecoration: 'none'}}>(Get yours here)</a></label>
            <input 
              type="password" 
              value={apiKey} 
              onChange={e => setApiKey(e.target.value)} 
              placeholder="gsk_..." 
              className="hotkey-input"
              style={{ width: '100%' }}
            />
          </div>

          <div className="setting-row"><label>Opacity</label><input type="range" className="modern-slider" min="0.1" max="1" step="0.1" value={bgOpacity} onChange={e => setBgOpacity(parseFloat(e.target.value))} /></div>
          
          {/* Data Recovery Section */}
          <div className="setting-row" style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <label>Keep closed tabs for (days):</label>
            <input 
              type="text" 
              className="hotkey-input" 
              style={{ width: '45px', padding: '6px', flexGrow: 0, textAlign: 'center' }} 
              value={retentionDays} 
              onChange={e => {
                // 1. Strip letters, but allow the box to be temporarily empty so you can backspace!
                const val = e.target.value.replace(/[^0-9]/g, '');
                setRetentionDays(val === '' ? ('' as any) : parseInt(val, 10));
              }}
              onKeyDown={e => {
                // 2. Allow your physical keyboard's Up/Down arrows to control the number
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setRetentionDays(prev => (parseInt(prev as any) || 0) + 1);
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setRetentionDays(prev => Math.max(1, (parseInt(prev as any) || 0) - 1));
                }
              }}
              onBlur={() => {
                // 3. Safety net: If you delete everything and click away, it defaults to 1
                if (!retentionDays || (retentionDays as any) === '') {
                  setRetentionDays(1);
                }
              }}
            />
          </div>

          {/* Collapsible Recycle Bin with Summaries & Permanent Delete */}
          {deletedTabs.length > 0 && (
            <div className="setting-row" style={{ alignItems: 'stretch', marginTop: '10px' }}>
              
              {/* Clickable Header */}
              <div 
                onClick={() => setIsHistoryExpanded(!isHistoryExpanded)}
                style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '8px', 
                  cursor: 'pointer', 
                  padding: '8px 4px', 
                  borderBottom: isHistoryExpanded ? 'none' : '1px solid rgba(255,255,255,0.05)',
                  opacity: 0.8,
                  transition: 'opacity 0.2s'
                }}
                onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                onMouseLeave={e => e.currentTarget.style.opacity = '0.8'}
              >
                <span style={{ 
                  fontSize: '0.75em', 
                  color: '#aaa', 
                  transform: isHistoryExpanded ? 'rotate(90deg)' : 'none', 
                  transition: 'transform 0.2s', 
                  display: 'inline-block' 
                }}>▶</span>
                <label style={{ cursor: 'pointer', margin: 0, fontWeight: 600, color: '#ddd' }}>
                  Recently Closed ({deletedTabs.length})
                </label>
              </div>
              
              {/* Collapsible Content Area */}
              {isHistoryExpanded && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '180px', overflowY: 'auto', paddingRight: '4px', marginTop: '8px' }}>
                  {deletedTabs.map(t => (
                    <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)', gap: '12px' }}>
                      
                      {/* Left Side: Stacked Title & Summary */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', overflow: 'hidden' }}>
                        <span style={{ color: '#fff', fontWeight: '600', fontSize: '0.95em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {t.title}
                        </span>
                        <span style={{ color: '#888', fontSize: '0.85em', fontStyle: 'italic', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          "{getTabSummary(t)}"
                        </span>
                      </div>
                      
                      {/* Right Side: Centered Action Buttons */}
                      <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                        <button onClick={() => restoreTab(t.id)} className="text-action-btn restore">
                          Restore
                        </button>
                        <button onClick={() => permanentlyDeleteTab(t.id)} className="text-action-btn delete">
                          Delete
                        </button>
                      </div>
                      
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* Token Display */}
          <div className="setting-row">
            <label>Today's Tokens Used For This Model</label>
            <span style={{ color: '#4CAF50', fontWeight: 'bold', fontSize: '0.9em' }}>
              {(dailyTokens[selectedModel] || 0).toLocaleString()} / {MODEL_LIMITS[selectedModel] || "Unknown"}
            </span>
          </div>
          
          <div className="setting-row">
            <label>AI Model</label>
            <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} className="model-selector-settings">
              <option value="llama-3.3-70b-versatile">Llama 3.3 (70B)</option>
              <option value="llama-3.1-8b-instant">Llama 3.1 (8B)</option>
              <option value="allam-2-7b">Allam 2 (7B)</option>
              <option value="groq/compound">Groq Compound (Slower Unlimited)</option>
              <option value="groq/compound-mini">Groq Compound Mini (Faster Unlimited)</option>
              <option value="meta-llama/llama-4-scout-17b-16e-instruct">Llama 4 Scout (17B)</option>
              <option value="meta-llama/llama-prompt-guard-2-22m">Prompt Guard (22M)</option>
              <option value="meta-llama/llama-prompt-guard-2-86m">Prompt Guard (86M)</option>
              <option value="openai/gpt-oss-120b">GPT OSS (120B)</option>
              <option value="openai/gpt-oss-20b">GPT OSS (20B)</option>
              <option value="openai/gpt-oss-safeguard-20b">GPT OSS Safeguard (20B)</option>
              <option value="qwen/qwen3-32b">Qwen 3 (32B)</option>
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

      {/* Tab Navigation Bar */}
      <div className="tabs-container">
        {tabs.map(tab => (
          <div 
            key={tab.id} 
            className={`tab ${activeTabId === tab.id ? "active" : ""}`} 
            onClick={() => setActiveTabId(tab.id)}
            onDoubleClick={(e) => startRenaming(tab, e)}
            title="Double-click to rename"
          >
            {editingTabId === tab.id ? (
              <input
                autoFocus
                value={editingTitle}
                onChange={e => setEditingTitle(e.target.value)}
                onBlur={() => saveTabName(tab.id)}
                onKeyDown={e => handleRenameKeyDown(e, tab.id)}
                className="tab-rename-input"
                onClick={e => e.stopPropagation()} 
              />
            ) : (
              <>
                {tab.title}
                {tabs.length > 1 && <span className="close-tab" onClick={(e) => deleteTab(tab.id, e)}>×</span>}
              </>
            )}
          </div>
        ))}
        <button className="new-tab-btn" onClick={createNewTab}>+</button>
      </div>

      <div className="content">
        {/* Changed messages.map to activeMessages.map */}
        {activeMessages.map((m, i) => (
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
import { useCallback, useEffect, useMemo, useState } from "react";

const PURPOSES = [
  { id: "explain_code", label: "Explain Code", template: "explain_code" },
  { id: "translate", label: "Translate Text", template: "translate" },
  { id: "debug_error", label: "Debug Error", template: "debug_error" },
  { id: "custom", label: "Custom Task", template: "explain_code" },
];

const REQUIREMENT_DEFAULTS = {
  explain_code: "Explain what this screenshot is.",
  translate: "Translate the text in this screenshot to [target language].",
  debug_error: "Explain the likely cause of the error and suggest first troubleshooting steps.",
  custom: "Explain what this screenshot is.",
};

function extractShortcutKey(accelerator) {
  const raw = String(accelerator || "").trim();
  const parts = raw.split("+").map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1].toUpperCase() : "A";
}

function App() {
  const [engineStatus, setEngineStatus] = useState("offline");
  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState("explain_code");
  const [records, setRecords] = useState([]);
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [analysisMode, setAnalysisMode] = useState("mock");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [renamingMessageId, setRenamingMessageId] = useState("");
  const [renameInput, setRenameInput] = useState("");
  const [compactMode, setCompactMode] = useState(false);
  const [purposeText, setPurposeText] = useState(REQUIREMENT_DEFAULTS.explain_code);
  const [activeMessageId, setActiveMessageId] = useState(`msg-${Date.now()}`);
  const [chatInput, setChatInput] = useState("");
  const [chatTurns, setChatTurns] = useState([]);
  const [chatMemoryByMessage, setChatMemoryByMessage] = useState({});
  const [pendingCaptures, setPendingCaptures] = useState([]);
  const [previewImageBase64, setPreviewImageBase64] = useState("");
  const [settings, setSettings] = useState({
    cloudOptIn: false,
    defaultPromptTemplate: "explain_code",
    geminiApiKeySet: false,
    chatgptApiKeySet: false,
    claudeApiKeySet: false,
    models: {
      gemini: "gemini-1.5-flash",
      chatgpt: "gpt-4.1-mini",
      claude: "claude-3-5-sonnet-20241022",
    },
    savedApiKeys: {
      gemini: [],
      chatgpt: [],
      claude: [],
    },
    chatTitles: {},
    captureShortcut: "CommandOrControl+Shift+A",
  });
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyProvider, setApiKeyProvider] = useState("gemini");
  const [providerModels, setProviderModels] = useState({
    gemini: [],
    chatgpt: [],
    claude: [],
  });
  const [selectedSavedKeyId, setSelectedSavedKeyId] = useState("");
  const [captureShortcutInput, setCaptureShortcutInput] = useState("A");

  const api = useMemo(() => window.screenAnalysis, []);
  const historyGroups = useMemo(() => {
    const byMessage = new Map();
    for (const record of records) {
      const messageId = record?.metadata?.message_id || `single-${record.id}`;
      if (!byMessage.has(messageId)) {
        byMessage.set(messageId, { messageId, records: [] });
      }
      byMessage.get(messageId).records.push(record);
    }
    const groups = Array.from(byMessage.values()).map((group) => {
      group.records.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      return {
        messageId: group.messageId,
        records: group.records,
        latest: group.records[0],
        count: group.records.length,
        title: settings?.chatTitles?.[group.messageId] || "",
      };
    });
    groups.sort((a, b) => new Date(b.latest.created_at).getTime() - new Date(a.latest.created_at).getTime());
    return groups;
  }, [records, settings?.chatTitles]);

  async function refreshRecords() {
    const list = await api.listRecords({ limit: 100, offset: 0 });
    setRecords(list);
  }

  async function refreshTemplates(defaultTemplate = null) {
    const list = await api.listTemplates();
    setTemplates(list);
    if (list.length > 0) {
      const next = defaultTemplate && list.some((t) => t.name === defaultTemplate) ? defaultTemplate : list[0].name;
      setSelectedTemplate(next);
    }
  }

  useEffect(() => {
    let offStatus = null;
    let offSnip = null;
    let timer = null;
    (async () => {
      offStatus = api.onEngineStatus(({ status: next }) => setEngineStatus(next));
      offSnip = api.onSnipCaptured(async (capture) => {
        if (!capture?.image_base64) return;
        const item = {
          id: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          image_base64: capture.image_base64,
          note: "",
          options: capture.options || {},
          bounds: capture.bounds || null,
        };
        setPendingCaptures((prev) => [...prev, item]);
      });

      timer = setInterval(async () => {
        try {
          const next = await api.getEngineStatus();
          setEngineStatus(next.status);
        } catch {
          // no-op
        }
      }, 2000);

      const status = await api.getEngineStatus();
      setEngineStatus(status.status);
      const compact = await api.getCompactMode();
      setCompactMode(Boolean(compact?.active));
      let loaded = await api.getSettings();
      if (!loaded.cloudOptIn) {
        loaded = await api.setSettings({ cloudOptIn: true });
      }
      setSettings(loaded);
      setCaptureShortcutInput(extractShortcutKey(loaded.captureShortcut || "CommandOrControl+Shift+A"));
      const defaults = (loaded?.savedApiKeys?.[apiKeyProvider] || []).find((item) => item.isCurrent);
      setSelectedSavedKeyId(defaults?.id || "");
      if (loaded.models) {
        setProviderModels((prev) => ({
          ...prev,
          gemini: prev.gemini.length ? prev.gemini : [loaded.models.gemini].filter(Boolean),
          chatgpt: prev.chatgpt.length ? prev.chatgpt : [loaded.models.chatgpt].filter(Boolean),
          claude: prev.claude.length ? prev.claude : [loaded.models.claude].filter(Boolean),
        }));
      }
      await refreshTemplates(loaded.defaultPromptTemplate);
      await refreshRecords();
    })().catch((err) => setError(err.message));

    return () => {
      if (offStatus) offStatus();
      if (offSnip) offSnip();
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const defaults = (settings?.savedApiKeys?.[apiKeyProvider] || []).find((item) => item.isCurrent);
    setSelectedSavedKeyId(defaults?.id || "");
  }, [apiKeyProvider, settings?.savedApiKeys]);

  const resolveTemplateFromPurpose = useCallback(() => selectedTemplate || "explain_code", [selectedTemplate]);

  function buildTaskInstruction(templateName, requirement, imageIndex = null) {
    const req = (requirement || "").trim();
    if (templateName === "translate") {
      return [
        "Focus: translation.",
        "First read/identify visible text in the screenshot, then translate it.",
        req || REQUIREMENT_DEFAULTS.translate,
      ].join("\n");
    }
    if (templateName === "debug_error") {
      return [
        "Focus: debugging.",
        "Identify the error/problem shown, likely causes, and first troubleshooting steps.",
        req || REQUIREMENT_DEFAULTS.debug_error,
      ].join("\n");
    }
    if (templateName === "explain_code") {
      return [
        "Focus: code explanation.",
        "Explain what the code does, key issues, and suggested improvements.",
        req || REQUIREMENT_DEFAULTS.explain_code,
      ].join("\n");
    }
    return req || `Analyze this screenshot${imageIndex ? ` #${imageIndex}` : ""} and explain key details.`;
  }

  function saveCurrentMessageGroup() {
    setChatMemoryByMessage((prev) => ({ ...prev, [activeMessageId]: chatTurns }));
    setActiveMessageId(`msg-${Date.now()}`);
    setChatTurns([]);
    setPendingCaptures([]);
    setError("Current screenshot message saved. Next captures will start a new message.");
  }

  const handleStartSnip = useCallback(async () => {
    setError("");
    await api.enterCompactMode();
    setCompactMode(true);

    const templateForTask = resolveTemplateFromPurpose();
    const selectedModel = settings?.models?.[analysisMode] || null;
    const taskInstruction = buildTaskInstruction(templateForTask, purposeText);
    const result = await api.startSnip({
      prompt_template_id: templateForTask,
      analysis_mode: analysisMode,
      model_override: selectedModel,
      prompt_overrides: { content: taskInstruction, task: taskInstruction },
      metadata: {
        source: "snip-overlay",
        screen: 0,
        purpose: templateForTask,
        purpose_text: taskInstruction,
        message_id: activeMessageId,
      },
    });
    if (result?.status === "ready") {
      setError("Snip mode active: drag on screen to select region. Captures will be queued for batch analysis.");
    } else if (result?.status === "error") {
      setError(result.message || "Failed to start snip overlay.");
    }
  }, [activeMessageId, analysisMode, api, purposeText, resolveTemplateFromPurpose, settings?.models]);

  useEffect(() => {
    const offCaptureShortcut = api.onCaptureShortcutRequested(() => {
      handleStartSnip().catch((err) => setError(err.message));
    });
    return () => {
      if (offCaptureShortcut) offCaptureShortcut();
    };
  }, [api, handleStartSnip]);

  async function handleSearch() {
    if (!searchQuery.trim()) return;
    setBusy(true);
    try {
      const results = await api.search({ query: searchQuery, top_k: 10 });
      setSearchResults(results);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function openRecord(recordId) {
    setBusy(true);
    try {
      const detail = await api.getRecord(recordId);
      setSelectedRecord(detail);
      const mid = detail?.metadata?.message_id;
      if (mid) {
        setActiveMessageId(mid);
        await loadMessageThread(mid);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadMessageThread(messageId) {
    const cached = chatMemoryByMessage[messageId];
    if (cached) {
      setChatTurns(cached);
      return;
    }
    const groupRecords = records
      .filter((record) => (record?.metadata?.message_id || `single-${record.id}`) === messageId)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    if (groupRecords.length === 0) {
      setChatTurns([]);
      return;
    }
    const details = await Promise.all(groupRecords.map((record) => api.getRecord(record.id)));
    const nextTurns = [];
    for (const detail of details) {
      const userText = detail?.metadata?.purpose_text || "Analyze this screenshot.";
      if (detail?.image_base64) {
        nextTurns.push({
          role: "user",
          kind: "batch_request",
          text: userText,
          images: [detail.image_base64],
        });
      } else {
        nextTurns.push({
          role: "user",
          kind: "batch_request",
          text: userText,
        });
      }
      nextTurns.push({
        role: "assistant",
        kind: "batch_response",
        text: detail?.model_text || "No response.",
        provider: detail?.metadata?.provider || "unknown",
        model: detail?.metadata?.model_name || "unknown",
      });
    }
    setChatTurns(nextTurns);
    setChatMemoryByMessage((prev) => ({ ...prev, [messageId]: nextTurns }));
  }

  async function sendFollowupQuestion() {
    const question = chatInput.trim();
    if (!question) return;
    setBusy(true);
    setError("");
    try {
      const data = await api.chat({
        message_id: activeMessageId,
        question,
        analysis_mode: analysisMode,
        model_override: settings?.models?.[analysisMode] || null,
        extra_context: purposeText,
      });
      const nextTurns = [...chatTurns, { role: "user", text: question }, { role: "assistant", text: data.reply_text }];
      setChatTurns(nextTurns);
      setChatMemoryByMessage((prev) => ({ ...prev, [activeMessageId]: nextTurns }));
      setChatInput("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function updateCaptureNote(captureId, note) {
    setPendingCaptures((prev) => prev.map((item) => (item.id === captureId ? { ...item, note } : item)));
  }

  function removePendingCapture(captureId) {
    setPendingCaptures((prev) => prev.filter((item) => item.id !== captureId));
  }

  async function analyzePendingCaptures() {
    if (pendingCaptures.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const capturesForBatch = [...pendingCaptures];
      const templateForTask = resolveTemplateFromPurpose();
      const currentTaskRequirement = buildTaskInstruction(templateForTask, purposeText);
      const userRequestText = capturesForBatch
        .map((capture, index) => {
          const note = capture.note?.trim();
          if (!note) return `Image ${index + 1}: ${currentTaskRequirement}`;
          return `Image ${index + 1}: ${currentTaskRequirement}\nFocus: ${note}`;
        })
        .filter(Boolean)
        .join("\n");

      const userTurn = {
        role: "user",
        kind: "batch_request",
        text: userRequestText || currentTaskRequirement,
        images: capturesForBatch.map((capture) => capture.image_base64),
      };

      let lastRecordId = null;
      const summaries = [];
      for (let index = 0; index < capturesForBatch.length; index += 1) {
        const capture = capturesForBatch[index];
        const note = capture.note?.trim();
        const captureRequirement = note
          ? `${currentTaskRequirement}\nFocus for image ${index + 1}: ${note}`
          : currentTaskRequirement;
        const payload = {
          image_base64: capture.image_base64,
          prompt_template_id: templateForTask,
          model_override: settings?.models?.[analysisMode] || null,
          prompt_overrides: { content: captureRequirement, task: captureRequirement },
          metadata: {
            source: "snip-overlay",
            screen: 0,
            purpose: templateForTask,
            purpose_text: currentTaskRequirement,
            focus_note: note || "",
            message_id: activeMessageId,
          },
          analysis_mode: analysisMode,
        };
        const result = await api.analyze(payload);
        lastRecordId = result.record_id;
        const detail = await api.getRecord(result.record_id);
        summaries.push({
          requirement: captureRequirement,
          response: detail?.model_text || "No model response.",
          provider: detail?.metadata?.provider || analysisMode,
          model: detail?.metadata?.model_name || settings?.models?.[analysisMode] || "unknown",
        });
      }
      const combinedText = summaries
        .map((item, index) => `Image ${index + 1} (${item.requirement})\n${item.response}`)
        .join("\n\n");
      const finalMeta = summaries.at(-1) || {};
      const assistantTurn = {
        role: "assistant",
        kind: "batch_response",
        text: combinedText || "Analysis complete.",
        provider: finalMeta.provider || analysisMode,
        model: finalMeta.model || settings?.models?.[analysisMode] || "unknown",
      };
      const nextTurns = [...chatTurns, userTurn, assistantTurn];
      setChatTurns(nextTurns);
      setChatMemoryByMessage((prev) => ({ ...prev, [activeMessageId]: nextTurns }));
      setPendingCaptures([]);
      await refreshRecords();
      if (lastRecordId) {
        const detail = await api.getRecord(lastRecordId);
        setSelectedRecord(detail);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(partial) {
    const next = await api.setSettings(partial);
    setSettings((prev) => ({ ...prev, ...next }));
  }

  async function refreshModels(provider) {
    try {
      const result = await api.listModels(provider);
      const models = result?.models || [];
      setProviderModels((prev) => ({ ...prev, [provider]: models }));
      if (models.length > 0) {
        const current = settings?.models?.[provider];
        if (!current || !models.includes(current)) {
          await saveSettings({ models: { ...(settings.models || {}), [provider]: models[0] } });
        }
      }
    } catch (err) {
      setError(err.message || `Failed to list ${provider} models`);
    }
  }

  async function saveApiKey() {
    const result = await api.setApiKey(apiKeyProvider, apiKeyInput);
    if (!result.ok) {
      setError(result.message || "Failed to set API key");
      return;
    }
    setApiKeyInput("");
    const loaded = await api.getSettings();
    setSettings(loaded);
    const defaults = (loaded?.savedApiKeys?.[apiKeyProvider] || []).find((item) => item.isCurrent);
    setSelectedSavedKeyId(defaults?.id || "");
  }

  async function saveCaptureShortcut() {
    const keyOnly = captureShortcutInput.trim().toUpperCase().replace(/\s+/g, "");
    if (!keyOnly) {
      setError("Enter a key for Ctrl + Shift + [key].");
      return;
    }
    const shortcut = `CommandOrControl+Shift+${keyOnly}`;
    const next = await api.setSettings({ captureShortcut: shortcut });
    setSettings((prev) => ({ ...prev, ...next }));
    setCaptureShortcutInput(extractShortcutKey(next.captureShortcut || shortcut));
    setError(`Capture shortcut set to: Ctrl + Shift + ${extractShortcutKey(next.captureShortcut || shortcut)}`);
  }

  async function useSavedApiKey() {
    if (!selectedSavedKeyId) return;
    const result = await api.selectApiKey(apiKeyProvider, selectedSavedKeyId);
    if (!result.ok) {
      setError(result.message || "Failed to select saved API key");
      return;
    }
    const loaded = await api.getSettings();
    setSettings(loaded);
  }

  async function removeSelectedRecord() {
    if (!selectedRecord) return;
    await api.deleteRecord(selectedRecord.id);
    setSelectedRecord(null);
    await refreshRecords();
  }

  async function continueSelectedChat() {
    const messageId = selectedRecord?.metadata?.message_id || activeMessageId;
    if (!messageId) {
      setError("Pick a chat in History first.");
      return;
    }
    setActiveMessageId(messageId);
    setPendingCaptures([]);
    await loadMessageThread(messageId);
    setError("Continuing selected chat. New screenshots and messages will be added to this thread.");
  }

  function beginRename(group) {
    setRenamingMessageId(group.messageId);
    setRenameInput(group.title || "");
  }

  async function saveChatTitle(messageId) {
    const trimmed = renameInput.trim();
    const current = { ...(settings.chatTitles || {}) };
    if (trimmed) {
      current[messageId] = trimmed;
    } else {
      delete current[messageId];
    }
    await saveSettings({ chatTitles: current });
    setRenamingMessageId("");
    setRenameInput("");
  }

  if (compactMode) {
    return (
      <div className="min-h-screen bg-slate-950 p-3 text-slate-100">
        <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/90 p-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Screen Assistant</h2>
            <span className="text-xs text-slate-400">{engineStatus}</span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs text-slate-400">AI Provider</label>
              <select
                value={analysisMode}
                onChange={(e) => setAnalysisMode(e.target.value)}
                className="w-full rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-sm"
              >
                <option value="mock">mock</option>
                <option value="gemini">gemini</option>
                <option value="chatgpt">chatgpt</option>
                <option value="claude">claude</option>
              </select>
              <div className="mt-2 flex gap-2">
                <select
                  value={settings?.models?.[analysisMode] || ""}
                  onChange={(e) => saveSettings({ models: { ...(settings.models || {}), [analysisMode]: e.target.value } })}
                  className="w-full rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-xs"
                >
                  {(providerModels[analysisMode] || []).map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
                <button onClick={() => refreshModels(analysisMode)} className="rounded-md bg-slate-700 px-2 py-1 text-xs">
                  List
                </button>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">Task Requirement (editable)</label>
              <textarea
                value={purposeText}
                onChange={(e) => setPurposeText(e.target.value)}
                className="h-20 w-full rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-xs"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleStartSnip}
              disabled={busy}
              className="flex-1 rounded-md bg-emerald-400 px-3 py-2 text-sm font-semibold text-slate-900 disabled:opacity-50"
            >
              Capture
            </button>
            <button
              onClick={analyzePendingCaptures}
              disabled={busy || pendingCaptures.length === 0}
              className="rounded-md bg-violet-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Analyze All ({pendingCaptures.length})
            </button>
            <button
              onClick={saveCurrentMessageGroup}
              className="rounded-md bg-indigo-500 px-3 py-2 text-sm font-semibold text-white"
            >
              Save Message
            </button>
          </div>

          <div className="rounded-md border border-slate-700 bg-slate-950 p-2">
            <div className="mb-2 text-xs text-slate-400">Queued Screenshots (click thumbnail to expand)</div>
            <div className="max-h-48 space-y-2 overflow-auto">
              {pendingCaptures.length === 0 && <div className="text-xs text-slate-500">No queued screenshots yet.</div>}
              {pendingCaptures.map((capture) => (
                <div key={capture.id} className="rounded border border-slate-700 p-2">
                  <div className="mb-2 flex items-start gap-2">
                    <button onClick={() => setPreviewImageBase64(capture.image_base64)} className="shrink-0">
                      <img
                        src={`data:image/png;base64,${capture.image_base64}`}
                        alt="Screenshot thumbnail"
                        className="h-16 w-24 rounded border border-slate-700 object-cover"
                      />
                    </button>
                    <div className="w-full">
                      <div className="mb-1 text-[11px] text-slate-400">What specific part should be analyzed?</div>
                      <textarea
                        value={capture.note}
                        onChange={(e) => updateCaptureNote(capture.id, e.target.value)}
                        className="h-16 w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-xs"
                        placeholder="e.g. Translate only the red text area at the top-right..."
                      />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button
                      onClick={() => removePendingCapture(capture.id)}
                      className="rounded bg-rose-600 px-2 py-1 text-[11px] text-white"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-md border border-slate-700 bg-slate-950 p-2">
            <div className="mb-2 text-xs text-slate-400">Conversation</div>
            <div className="max-h-72 space-y-2 overflow-auto text-xs">
              {chatTurns.length === 0 && <div className="text-slate-500">Capture screenshots, then analyze all in one request.</div>}
              {chatTurns.map((turn, index) => (
                <div key={`turn-${index}`} className={`flex ${turn.role === "assistant" ? "justify-start" : "justify-end"}`}>
                  <div
                    className={`max-w-[88%] rounded-lg px-3 py-2 ${
                      turn.role === "assistant" ? "bg-emerald-900/30 text-emerald-100" : "bg-cyan-900/40 text-cyan-100"
                    }`}
                  >
                    <div className="mb-1 text-[11px] font-semibold">{turn.role === "assistant" ? "AI" : "You"}</div>
                    <div className="whitespace-pre-wrap">{turn.text}</div>
                    {Array.isArray(turn.images) && turn.images.length > 0 && (
                      <div className="mt-2 grid grid-cols-3 gap-2">
                        {turn.images.map((img, idx) => (
                          <button key={`${index}-${idx}`} onClick={() => setPreviewImageBase64(img)} className="text-left">
                            <img
                              src={`data:image/png;base64,${img}`}
                              alt={`Batch screenshot ${idx + 1}`}
                              className="h-14 w-full rounded border border-slate-700 object-cover"
                            />
                          </button>
                        ))}
                      </div>
                    )}
                    {turn.role === "assistant" && (
                      <div className="mt-1 text-[11px] text-slate-400">
                        Provider: {turn.provider || selectedRecord?.metadata?.provider || "unknown"} | Model:{" "}
                        {turn.model || selectedRecord?.metadata?.model_name || "unknown"}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Ask follow-up..."
                className="w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-xs"
              />
              <button
                onClick={sendFollowupQuestion}
                disabled={busy || !chatInput.trim()}
                className="rounded-md bg-cyan-400 px-3 py-1 text-xs font-semibold text-slate-900 disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </div>

          {error && <div className="rounded bg-red-500/20 p-2 text-xs text-red-200">{error}</div>}
        </div>
        {previewImageBase64 && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <div className="max-h-[92vh] w-full max-w-4xl rounded-lg border border-slate-600 bg-slate-950 p-3">
              <div className="mb-2 flex justify-end">
                <button onClick={() => setPreviewImageBase64("")} className="rounded bg-slate-700 px-2 py-1 text-xs">
                  Close
                </button>
              </div>
              <img
                src={`data:image/png;base64,${previewImageBase64}`}
                alt="Expanded screenshot"
                className="max-h-[82vh] w-full rounded object-contain"
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 text-slate-100">
      <div className="mx-auto grid max-w-5xl grid-cols-12 gap-3">
        <aside className="col-span-3 rounded-xl border border-slate-700 bg-slate-900/70 p-4">
          <h2 className="text-lg font-semibold">History</h2>
          <p className="text-xs text-slate-400">Engine: {engineStatus}</p>
          <div className="mt-3 flex gap-2">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Semantic search..."
              className="w-full rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-sm"
            />
            <button className="rounded-md bg-emerald-500 px-3 py-1 text-sm text-slate-900" onClick={handleSearch}>
              Go
            </button>
          </div>
          {searchResults.length > 0 && (
            <div className="mt-2 rounded-md bg-slate-950 p-2 text-xs">
              {searchResults.map((item) => (
                <button
                  key={`search-${item.record_id}`}
                  className="mb-1 block w-full rounded bg-slate-800 px-2 py-1 text-left"
                  onClick={() => openRecord(item.record_id)}
                >
                  #{item.record_id} ({item.score}) {item.snippet}
                </button>
              ))}
            </div>
          )}
          <div className="mt-4 max-h-[70vh] overflow-auto">
            {historyGroups.map((group) => (
              <div key={group.messageId} className="mb-2 rounded-lg border border-slate-700 bg-slate-800/60 p-2 text-xs">
                <button className="block w-full text-left" onClick={() => openRecord(group.latest.id)}>
                  <div className="font-medium">
                    {group.title || (group.count > 1 ? `Message (${group.count} screenshots)` : `Record #${group.latest.id}`)}
                  </div>
                  <div className="text-slate-400">{new Date(group.latest.created_at).toLocaleString()}</div>
                </button>
                {renamingMessageId === group.messageId ? (
                  <div className="mt-2 flex gap-2">
                    <input
                      value={renameInput}
                      onChange={(e) => setRenameInput(e.target.value)}
                      placeholder="Chat name..."
                      className="w-full rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-xs"
                    />
                    <button
                      onClick={() => saveChatTitle(group.messageId)}
                      className="rounded-md bg-emerald-500 px-2 py-1 text-xs text-slate-900"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setRenamingMessageId("");
                        setRenameInput("");
                      }}
                      className="rounded-md bg-slate-700 px-2 py-1 text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="mt-2 flex justify-end">
                    <button onClick={() => beginRename(group)} className="rounded-md bg-slate-700 px-2 py-1 text-xs">
                      Rename
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </aside>

        <main className="col-span-9 rounded-xl border border-slate-700 bg-slate-900/70 p-5">
          <div className="mb-4 grid grid-cols-2 gap-3 rounded-xl border border-slate-700 bg-slate-950/70 p-3">
            <div>
              <label className="mb-1 block text-xs text-slate-400">Provider API Key</label>
              <div className="flex gap-2">
                <select
                  value={apiKeyProvider}
                  onChange={(e) => setApiKeyProvider(e.target.value)}
                  className="rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-sm"
                >
                  <option value="gemini">Gemini</option>
                  <option value="chatgpt">ChatGPT</option>
                  <option value="claude">Claude</option>
                </select>
                <input
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="Paste API key"
                  className="w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-sm"
                />
                <button className="w-24 rounded-md bg-cyan-400 px-3 py-1 text-sm text-slate-900" onClick={saveApiKey}>
                  Save
                </button>
              </div>
              <div className="mt-2 flex gap-2">
                <select
                  value={selectedSavedKeyId}
                  onChange={(e) => setSelectedSavedKeyId(e.target.value)}
                  className="w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-xs"
                >
                  <option value="">Saved keys for {apiKeyProvider}</option>
                  {(settings?.savedApiKeys?.[apiKeyProvider] || []).map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label} {entry.isCurrent ? "(current)" : ""}
                    </option>
                  ))}
                </select>
                <button
                  onClick={useSavedApiKey}
                  disabled={!selectedSavedKeyId}
                  className="rounded-md bg-emerald-500 px-2 py-1 text-xs text-slate-900 disabled:opacity-50"
                >
                  Use Saved
                </button>
              </div>
              <div className="mt-1 text-[11px] text-slate-400">
                Gemini: {settings.geminiApiKeySet ? "set" : "not set"} | ChatGPT: {settings.chatgptApiKeySet ? "set" : "not set"} | Claude: {settings.claudeApiKeySet ? "set" : "not set"}
              </div>
              <div className="mt-2 flex gap-2">
                <select
                  value={settings?.models?.[apiKeyProvider] || ""}
                  onChange={(e) =>
                    saveSettings({
                      models: {
                        ...(settings.models || {}),
                        [apiKeyProvider]: e.target.value,
                      },
                    })
                  }
                  className="w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-xs"
                >
                  {(providerModels[apiKeyProvider] || []).map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
                <button onClick={() => refreshModels(apiKeyProvider)} className="rounded-md bg-slate-700 px-2 py-1 text-xs">
                  List Models
                </button>
              </div>
              <div className="mt-1 text-[11px] text-slate-400">
                Active model for {analysisMode}: {settings?.models?.[analysisMode] || "not set"}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">Requirement for this screenshot task (editable)</label>
              <textarea
                value={purposeText}
                onChange={(e) => setPurposeText(e.target.value)}
                className="h-28 w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-sm"
              />
              <div className="mt-2">
                <label className="mb-1 block text-[11px] text-slate-400">Capture Shortcut</label>
                <div className="flex items-center gap-2">
                  <div className="shrink-0 rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-xs text-slate-300">
                    Ctrl
                  </div>
                  <div className="text-xs text-slate-400">+</div>
                  <div className="shrink-0 rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-xs text-slate-300">
                    Shift
                  </div>
                  <div className="text-xs text-slate-400">+</div>
                  <input
                    value={captureShortcutInput}
                    onChange={(e) => {
                      const raw = e.target.value.toUpperCase().replace(/\s+/g, "");
                      setCaptureShortcutInput(raw.slice(-1));
                    }}
                    placeholder="A"
                    maxLength={1}
                    className="w-16 rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-center text-xs"
                  />
                  <button onClick={saveCaptureShortcut} className="rounded-md bg-slate-700 px-2 py-1 text-xs">
                    Save
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-3">
            <button
              onClick={handleStartSnip}
              disabled={busy}
              className="rounded-lg bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-50"
            >
              Capture Region
            </button>
            <select
              value={selectedTemplate}
              onChange={(e) => {
                const next = e.target.value;
                setSelectedTemplate(next);
                const nextDefault = REQUIREMENT_DEFAULTS[next] || REQUIREMENT_DEFAULTS.custom;
                if (!purposeText.trim() || Object.values(REQUIREMENT_DEFAULTS).includes(purposeText.trim())) {
                  setPurposeText(nextDefault);
                }
              }}
              className="rounded-md border border-slate-600 bg-slate-950 px-3 py-2 text-sm"
            >
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.name}>
                  {tpl.name}
                </option>
              ))}
              {!templates.some((tpl) => tpl.name === "custom") && <option value="custom">custom</option>}
            </select>
            <select
              value={analysisMode}
              onChange={(e) => setAnalysisMode(e.target.value)}
              className="rounded-md border border-slate-600 bg-slate-950 px-3 py-2 text-sm"
            >
              <option value="mock">mock</option>
              <option value="gemini">gemini</option>
              <option value="chatgpt">chatgpt</option>
              <option value="claude">claude</option>
            </select>
            <select
              value={settings?.models?.[analysisMode] || ""}
              onChange={(e) =>
                saveSettings({
                  models: {
                    ...(settings.models || {}),
                    [analysisMode]: e.target.value,
                  },
                })
              }
              className="rounded-md border border-slate-600 bg-slate-950 px-3 py-2 text-sm"
            >
              {(providerModels[analysisMode] || []).map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
            <button onClick={() => refreshModels(analysisMode)} className="rounded-lg bg-slate-700 px-3 py-2 text-sm">
              List Models
            </button>
            <button
              onClick={saveCurrentMessageGroup}
              className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white"
            >
              Save Message
            </button>
            <button
              onClick={continueSelectedChat}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white"
            >
              Continue This Chat
            </button>
            <button
              onClick={removeSelectedRecord}
              disabled={busy || !selectedRecord}
              className="rounded-lg bg-rose-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Delete Selected
            </button>
          </div>

          {error && <div className="mb-4 rounded bg-red-500/20 p-2 text-sm text-red-200">{error}</div>}

          {!selectedRecord && <p className="text-slate-300">Capture a region or pick a record from history.</p>}
          {selectedRecord && (
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg border border-slate-700 bg-slate-950 p-3">
                <h3 className="mb-2 text-sm font-semibold">Screenshot</h3>
                {selectedRecord.image_base64 ? (
                  <img
                    src={`data:image/png;base64,${selectedRecord.image_base64}`}
                    alt="Captured region"
                    className="max-h-[520px] w-full rounded object-contain"
                  />
                ) : (
                  <p className="text-xs text-slate-400">Image unavailable.</p>
                )}
              </div>
              <div className="rounded-lg border border-slate-700 bg-slate-950 p-3">
                <h3 className="mb-2 text-sm font-semibold">Model Response</h3>
                <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap text-xs text-slate-200">
                  {selectedRecord.model_text || "No response."}
                </pre>
                <div className="mt-4 text-xs text-slate-400">
                  <div>Record: #{selectedRecord.id}</div>
                  <div>Prompt: {selectedRecord.prompt_template_name || "default"}</div>
                  <div>Embedding: {selectedRecord.embedding_id || "pending"}</div>
                  <div>Provider: {selectedRecord?.metadata?.provider || "unknown"}</div>
                  <div>Model: {selectedRecord?.metadata?.model_name || "unknown"}</div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;

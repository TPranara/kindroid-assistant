import {
  App,
  ItemView,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

const VIEW_TYPE_KINDROID = "kindroid-assistant-view";

// ---------------------------------------------------------
// Settings
// ---------------------------------------------------------

interface KindroidSettings {
  apiKey: string;
  aiId: string;
  greeting: string;
  selectedVoice: string;
  ttsAutoPlay: boolean;
  micMode: "native" | "tooltip";
  fontSize: number;
  fontFamily: string;
  assistantName: string;
  userName: string;
}

const DEFAULT_SETTINGS: KindroidSettings = {
  apiKey: "",
  aiId: "",
  greeting: "Hello! I'm ready to help you with Obsidian and your writing today.",
  selectedVoice: "",
  ttsAutoPlay: false,
  micMode: "tooltip",
  fontSize: 16,
  fontFamily: "Poppins",
  assistantName: "Assistant",
  userName: "You",
};

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------

// Parse *action text* and render as styled spans (no italics)
function parseActions(text: string, container: HTMLElement) {
  const parts = text.split(/(\*[^*]+\*)/g);
  for (const part of parts) {
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      const span = container.createSpan("ka-action-text");
      span.setText(part.slice(1, -1));
    } else {
      container.appendText(part);
    }
  }
}

// Load Poppins from Google Fonts once
function ensurePoppinsLoaded() {
  const id = "ka-poppins-font";
  if (!document.getElementById(id)) {
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&family=Lora:wght@400;600&family=JetBrains+Mono:wght@400;500&family=Nunito:wght@400;600&display=swap";
    document.head.appendChild(link);
  }
}

// Get all available TTS voices
function getVoices(): SpeechSynthesisVoice[] {
  return window.speechSynthesis?.getVoices() ?? [];
}

// Speak a string using the saved voice preference
function speakText(text: string, voiceName: string) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  const voices = getVoices();
  const match = voices.find((v) => v.name === voiceName);
  if (match) utt.voice = match;
  window.speechSynthesis.speak(utt);
}

// ---------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------

export default class KindroidPlugin extends Plugin {
  settings: KindroidSettings;

  async onload() {
    await this.loadSettings();
    ensurePoppinsLoaded();

    this.registerView(
      VIEW_TYPE_KINDROID,
      (leaf) => new KindroidView(leaf, this)
    );

    this.addRibbonIcon("message-circle", "Open Kindroid Assistant", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-kindroid-assistant",
      name: "Open Kindroid Assistant",
      callback: () => this.activateView(),
    });

    this.addSettingTab(new KindroidSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.activateView();
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_KINDROID);
  }

  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_KINDROID);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_KINDROID, active: true });
      workspace.revealLeaf(leaf);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ---------------------------------------------------------
// The chat view
// ---------------------------------------------------------

class KindroidView extends ItemView {
  plugin: KindroidPlugin;
  messagesEl: HTMLElement;
  copyAllBtn: HTMLButtonElement;
  inputEl: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  newChatBtn: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
  micBtn: HTMLButtonElement;
  contextMenu: HTMLElement | null = null;
  recognition: any = null;

  constructor(leaf: WorkspaceLeaf, plugin: KindroidPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_KINDROID; }
  getDisplayText(): string { return "Kindroid Assistant"; }
  getIcon(): string { return "message-circle"; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("ka-root");
    this.applyStyles();

    // ── Header ───────────────────────────────────────────
    const header = root.createDiv("ka-header");
    const titleEl = header.createDiv("ka-header-title");
    titleEl.setText("Kindroid Assistant");

    const headerRight = header.createDiv("ka-header-right");
    headerRight.createDiv("ka-header-hint").setText("Ctrl+Enter to send");
    headerRight.createDiv("ka-header-pipe").setText("|");

    this.copyAllBtn = headerRight.createEl("button", {
      cls: "ka-copy-btn",
      attr: { title: "Copy All" },
    });
    this.copyAllBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4C2.9 1 2 1.9 2 3v14h2V3h12V1zm3 4H8C6.9 5 6 5.9 6 7v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
    this.copyAllBtn.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation();
      this.showCopyAllMenu(e);
    });

    // ── Message list ─────────────────────────────────────
    this.messagesEl = root.createDiv("ka-messages");

    // Custom context menu on right-click
    this.messagesEl.addEventListener("contextmenu", (e: MouseEvent) => {
      this.handleContextMenu(e);
    });

    // Dismiss context menu on click elsewhere
    document.addEventListener("click", () => this.dismissContextMenu(), true);

    this.renderBubble(
      "assistant",
      "Hello! I'm here to help. You can ask me anything, or paste a paragraph of text and I'll assist with it."
    );

    // ── Input area ───────────────────────────────────────
    const inputWrap = root.createDiv("ka-input-wrap");

    this.inputEl = inputWrap.createEl("textarea", {
      cls: "ka-input",
      attr: { placeholder: "Ask something, or paste text here…" },
    });

    this.inputEl.addEventListener("input", () => {
      this.inputEl.style.height = "auto";
      this.inputEl.style.height =
        Math.min(this.inputEl.scrollHeight, 160) + "px";
    });

    this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    // ── Button row ───────────────────────────────────────
    const btnRow = inputWrap.createDiv("ka-btn-row");

    this.newChatBtn = btnRow.createEl("button", {
      text: "Chat Break",
      cls: "ka-btn ka-btn-ghost",
      attr: { title: "Resets Kindroid memory" },
    });
    this.newChatBtn.addEventListener("click", () => this.chatBreak());

    this.clearBtn = btnRow.createEl("button", {
      text: "Clear Screen",
      cls: "ka-btn ka-btn-clear",
      attr: { title: "Clears the display only — memory unchanged" },
    });
    this.clearBtn.addEventListener("click", () => this.clearView());

    // Microphone button
    this.micBtn = btnRow.createEl("button", {
      cls: "ka-btn ka-btn-mic",
      attr: { title: "Click to dictate" },
    });
    this.micBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>`;
    this.micBtn.addEventListener("click", () => this.toggleDictation());

    this.sendBtn = btnRow.createEl("button", {
      text: "Send",
      cls: "ka-btn ka-btn-primary",
    });
    this.sendBtn.addEventListener("click", () => this.sendMessage());
  }

  async onClose() {
    document.removeEventListener("click", () => this.dismissContextMenu(), true);
    if (this.recognition) {
      this.recognition.stop();
    }
  }

  // ── Render a message bubble ────────────────────────────
  private renderBubble(role: "user" | "assistant", content: string): HTMLElement {
    const row = this.messagesEl.createDiv(`ka-msg ka-msg-${role}`);
    const labelRow = row.createDiv("ka-msg-label-row");
    labelRow.createDiv("ka-msg-label").setText(role === "user" ? this.plugin.settings.userName : this.plugin.settings.assistantName);
    const copyBtn = labelRow.createEl("button", {
      cls: "ka-copy-btn ka-copy-btn-inline",
      attr: { title: "Copy Response" },
    });
    copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4C2.9 1 2 1.9 2 3v14h2V3h12V1zm3 4H8C6.9 5 6 5.9 6 7v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
    const bubble = row.createDiv("ka-msg-bubble");
    parseActions(content, bubble);
    copyBtn.addEventListener("click", () => {
      const labelText = role === "user" ? this.plugin.settings.userName : this.plugin.settings.assistantName;
      const bubbleText = bubble.innerText ?? "";
      navigator.clipboard.writeText(labelText + ":\n" + bubbleText);
      copyBtn.classList.add("ka-copy-btn-flash");
      setTimeout(() => copyBtn.classList.remove("ka-copy-btn-flash"), 600);
    });
    this.scrollToBottom();

    // Auto-speak assistant responses if enabled
    if (role === "assistant" && this.plugin.settings.ttsAutoPlay) {
      speakText(content, this.plugin.settings.selectedVoice);
    }

    return bubble;
  }

  private scrollToBottom() {
    this.messagesEl.scrollTo({
      top: this.messagesEl.scrollHeight,
      behavior: "smooth",
    });
  }

  private setLoading(on: boolean) {
    this.sendBtn.disabled = on;
    this.newChatBtn.disabled = on;
    this.clearBtn.disabled = on;
    this.micBtn.disabled = on;
    this.inputEl.disabled = on;
    this.sendBtn.setText(on ? "…" : "Send");
  }

  // ── Custom context menu ────────────────────────────────
  private handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    this.dismissContextMenu();

    const selected = window.getSelection()?.toString().trim();

    const menu = document.createElement("div");
    menu.className = "ka-context-menu";
    menu.style.left = e.pageX + "px";
    menu.style.top = e.pageY + "px";

    // Copy option
    const copyItem = menu.createDiv("ka-context-item");
    copyItem.setText("Copy");
    copyItem.addEventListener("click", () => {
      if (selected) navigator.clipboard.writeText(selected);
      this.dismissContextMenu();
    });

    // Speak option (only if there's selected text)
    if (selected) {
      const speakItem = menu.createDiv("ka-context-item");
      speakItem.setText("Speak");
      speakItem.addEventListener("click", () => {
        speakText(selected, this.plugin.settings.selectedVoice);
        this.dismissContextMenu();
      });
    }

    // Stop speaking option
    if (window.speechSynthesis?.speaking) {
      const stopItem = menu.createDiv("ka-context-item ka-context-item-stop");
      stopItem.setText("Stop Speaking");
      stopItem.addEventListener("click", () => {
        window.speechSynthesis.cancel();
        this.dismissContextMenu();
      });
    }

    document.body.appendChild(menu);
    this.contextMenu = menu;
  }

  private dismissContextMenu() {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
  }

  // ── Dictation ─────────────────────────────────────────
  private micTooltip: HTMLElement | null = null;

  private showMicTooltip() {
    if (this.micTooltip) {
      this.micTooltip.remove();
      this.micTooltip = null;
      return;
    }
    const tip = document.createElement("div");
    tip.className = "ka-mic-tooltip";
    tip.setText("Press Win+H to dictate (Windows 10+)");
    const rect = this.micBtn.getBoundingClientRect();
    tip.style.position = "fixed";
    tip.style.left = rect.left + "px";
    tip.style.top = (rect.top - 44) + "px";
    document.body.appendChild(tip);
    this.micTooltip = tip;
    setTimeout(() => {
      tip.remove();
      if (this.micTooltip === tip) this.micTooltip = null;
    }, 3000);
  }

  private toggleDictation() {
    if (this.plugin.settings.micMode === "tooltip") {
      this.showMicTooltip();
      return;
    }

    // Native mode — attempt Web Speech API
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SR) {
      this.showMicTooltip();
      return;
    }

    if (this.recognition) {
      this.recognition.stop();
      this.recognition = null;
      this.micBtn.removeClass("ka-btn-mic-active");
      return;
    }

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-AU";

    let finalTranscript = "";

    rec.onresult = (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += t + " ";
        } else {
          interim = t;
        }
      }
      this.inputEl.value = finalTranscript + interim;
      this.inputEl.style.height = "auto";
      this.inputEl.style.height =
        Math.min(this.inputEl.scrollHeight, 160) + "px";
    };

    rec.onerror = () => {
      this.micBtn.removeClass("ka-btn-mic-active");
      this.recognition = null;
      this.showMicTooltip();
    };

    rec.onend = () => {
      this.micBtn.removeClass("ka-btn-mic-active");
      this.recognition = null;
    };

    rec.start();
    this.recognition = rec;
    this.micBtn.addClass("ka-btn-mic-active");
  }

  // ── Clear view only (no chat break) ───────────────────
  private clearView() {
    this.messagesEl.empty();
    this.renderBubble(
      "assistant",
      "Panel cleared. Kindroid's memory is unchanged — your conversation context continues."
    );
  }

  // ── Apply font styles via CSS custom properties ──────
  applyStyles() {
    const fontMap: Record<string, string> = {
      "Poppins": "'Poppins', sans-serif",
      "Lora": "'Lora', serif",
      "JetBrains Mono": "'JetBrains Mono', monospace",
      "Nunito": "'Nunito', sans-serif",
    };
    const family = fontMap[this.plugin.settings.fontFamily] ?? "'Poppins', sans-serif";
    this.contentEl.style.setProperty("--ka-font-size", this.plugin.settings.fontSize + "px");
    this.contentEl.style.setProperty("--ka-font-family", family);
    this.refreshLabels();
  }

  // ── Refresh all message labels with current name settings ──
  refreshLabels() {
    if (!this.messagesEl) return;
    const msgs = this.messagesEl.querySelectorAll(".ka-msg");
    msgs.forEach((row) => {
      const label = row.querySelector(".ka-msg-label") as HTMLElement;
      if (!label) return;
      if (row.classList.contains("ka-msg-user")) {
        label.textContent = this.plugin.settings.userName;
      } else {
        label.textContent = this.plugin.settings.assistantName;
      }
    });
  }

  // ── Copy All dropdown menu ────────────────────────────
  private copyAllMenu: HTMLElement | null = null;

  private getAllText(): string {
    const rows = Array.from(this.messagesEl.children);
    return rows
      .filter(row => row.classList.contains("ka-msg"))
      .map((row) => {
        const rawLabel = (row.querySelector(".ka-msg-label") as HTMLElement)?.innerText ?? "";
        const label = rawLabel;
        const bubble = (row.querySelector(".ka-msg-bubble") as HTMLElement)?.innerText ?? "";
        return label + ":\n" + bubble;
      })
      .join("\n\n---\n\n");
  }

  private showCopyAllMenu(e: MouseEvent) {
    if (this.copyAllMenu) {
      this.copyAllMenu.remove();
      this.copyAllMenu = null;
      return;
    }

    const menu = document.createElement("div");
    menu.className = "ka-context-menu";
    const rect = this.copyAllBtn.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.right = (window.innerWidth - rect.right) + "px";
    menu.style.top = (rect.bottom + 4) + "px";
    menu.style.left = "auto";

    const copyItem = menu.createDiv("ka-context-item");
    copyItem.setText("Copy All");
    copyItem.addEventListener("click", () => {
      navigator.clipboard.writeText(this.getAllText());
      this.copyAllBtn.classList.add("ka-copy-btn-flash");
      setTimeout(() => this.copyAllBtn.classList.remove("ka-copy-btn-flash"), 600);
      menu.remove();
      this.copyAllMenu = null;
    });

    const exportItem = menu.createDiv("ka-context-item");
    exportItem.setText("Export to Note");
    exportItem.addEventListener("click", async () => {
      await this.exportToNote();
      menu.remove();
      this.copyAllMenu = null;
    });

    document.body.appendChild(menu);
    this.copyAllMenu = menu;

    setTimeout(() => {
      const dismiss = () => {
        menu.remove();
        this.copyAllMenu = null;
        document.removeEventListener("click", dismiss, true);
      };
      document.addEventListener("click", dismiss, true);
    }, 50);
  }

  // ── Export chat to Obsidian note ───────────────────────
  private async exportToNote() {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 5).replace(":", "-");
    const fileName = `Kindroid Chat ${dateStr} ${timeStr}.md`;

    const lines: string[] = ["# Kindroid Chat\n", `*Exported: ${now.toLocaleString()}*\n`, "---\n"];

    Array.from(this.messagesEl.querySelectorAll(".ka-msg")).forEach((row) => {
      const label = row.querySelector(".ka-msg-label")?.textContent ?? "";
      const bubble = row.querySelector(".ka-msg-bubble")?.textContent ?? "";
      const heading = "**" + label + "**";
      lines.push(heading + "\n" + bubble + "\n");
    });

    const content = lines.join("\n");

    try {
      const file = await this.app.vault.create(fileName, content);
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.openFile(file as TFile);
    } catch (err: any) {
      this.renderBubble("assistant", "⚠️ Could not create note: " + err.message);
    }
  }

  // ── Send a message ─────────────────────────────────────
  async sendMessage() {
    const { apiKey, aiId } = this.plugin.settings;

    if (!apiKey || !aiId) {
      this.renderBubble(
        "assistant",
        "⚠️ Please enter your API key and AI ID in Settings → Kindroid Assistant."
      );
      return;
    }

    const text = this.inputEl.value.trim();
    if (!text) return;

    // Stop dictation if running
    if (this.recognition) {
      this.recognition.stop();
      this.recognition = null;
      this.micBtn.removeClass("ka-btn-mic-active");
    }

    this.renderBubble("user", text);
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";
    this.setLoading(true);

    const thinkingRow = this.messagesEl.createDiv("ka-msg ka-msg-assistant");
    thinkingRow.createDiv("ka-msg-label").setText(this.plugin.settings.assistantName);
    thinkingRow.createDiv("ka-msg-bubble ka-thinking").setText("Thinking…");
    this.scrollToBottom();

    try {
      const res = await fetch("https://api.kindroid.ai/v1/send-message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ ai_id: aiId, message: text }),
      });

      thinkingRow.remove();

      if (!res.ok) throw new Error(`Server returned ${res.status}`);

      const reply = await res.text();
      this.renderBubble("assistant", reply);
    } catch (err: any) {
      thinkingRow.remove();
      this.renderBubble("assistant", `⚠️ Error: ${err.message}`);
    } finally {
      this.setLoading(false);
      this.inputEl.focus();
    }
  }

  // ── Reset conversation ─────────────────────────────────
  async chatBreak() {
    const { apiKey, aiId, greeting } = this.plugin.settings;

    if (!apiKey || !aiId) {
      this.renderBubble(
        "assistant",
        "⚠️ Please enter your API key and AI ID in settings first."
      );
      return;
    }

    this.setLoading(true);

    try {
      const res = await fetch("https://api.kindroid.ai/v1/chat-break", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ ai_id: aiId, greeting }),
      });

      if (!res.ok) throw new Error(`Server returned ${res.status}`);

      this.messagesEl.empty();
      this.renderBubble(
        "assistant",
        "Chat cleared! Fresh start — what can I help you with?"
      );
    } catch (err: any) {
      this.renderBubble("assistant", `⚠️ Could not reset chat: ${err.message}`);
    } finally {
      this.setLoading(false);
    }
  }
}

// ---------------------------------------------------------
// Settings tab
// ---------------------------------------------------------

class KindroidSettingTab extends PluginSettingTab {
  plugin: KindroidPlugin;

  constructor(app: App, plugin: KindroidPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Kindroid Assistant" });

    // API Key
    new Setting(containerEl)
      .setName("API Key")
      .setDesc("Your Kindroid API key — starts with kn_... (Kindroid → General Settings)")
      .addText((t) =>
        t
          .setPlaceholder("kn_...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => {
            this.plugin.settings.apiKey = v.trim();
            await this.plugin.saveSettings();
          })
      );

    // AI ID
    new Setting(containerEl)
      .setName("AI ID")
      .setDesc("Your Kindroid AI ID (also in General Settings)")
      .addText((t) =>
        t
          .setPlaceholder("Enter your AI ID")
          .setValue(this.plugin.settings.aiId)
          .onChange(async (v) => {
            this.plugin.settings.aiId = v.trim();
            await this.plugin.saveSettings();
          })
      );

    // New Chat greeting
    new Setting(containerEl)
      .setName("New Chat greeting")
      .setDesc("Opening message sent to your AI when you click 'New Chat'")
      .addTextArea((t) =>
        t
          .setPlaceholder("Hello! I'm ready to help…")
          .setValue(this.plugin.settings.greeting)
          .onChange(async (v) => {
            this.plugin.settings.greeting = v;
            await this.plugin.saveSettings();
          })
      );

    // Display names
    containerEl.createEl("h3", { text: "Display Names" });

    new Setting(containerEl)
      .setName("Assistant name")
      .setDesc("How the assistant's messages are labelled in the chat (default: Assistant)")
      .addText((t) =>
        t
          .setPlaceholder("Assistant")
          .setValue(this.plugin.settings.assistantName)
          .onChange(async (v) => {
            this.plugin.settings.assistantName = v.trim() || "Assistant";
            await this.plugin.saveSettings();
            refreshView();
          })
      );

    new Setting(containerEl)
      .setName("Your name")
      .setDesc("How your messages are labelled in the chat (default: You)")
      .addText((t) =>
        t
          .setPlaceholder("You")
          .setValue(this.plugin.settings.userName)
          .onChange(async (v) => {
            this.plugin.settings.userName = v.trim() || "You";
            await this.plugin.saveSettings();
            refreshView();
          })
      );

    // TTS Auto-play toggle
    new Setting(containerEl)
      .setName("Auto-speak responses")
      .setDesc("Automatically read assistant responses aloud using TTS")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.ttsAutoPlay)
          .onChange(async (v) => {
            this.plugin.settings.ttsAutoPlay = v;
            await this.plugin.saveSettings();
          })
      );

    // Voice selector
    const voiceSetting = new Setting(containerEl)
      .setName("TTS Voice")
      .setDesc("Select the voice for text-to-speech (right-click Speak or auto-play)");

    const select = voiceSetting.controlEl.createEl("select", {
      cls: "ka-voice-select",
    });

    const populateVoices = () => {
      select.empty();
      const voices = window.speechSynthesis?.getVoices() ?? [];
      if (voices.length === 0) {
        const opt = select.createEl("option");
        opt.value = "";
        opt.setText("No voices found — try reopening settings");
        return;
      }
      for (const v of voices) {
        const opt = select.createEl("option");
        opt.value = v.name;
        opt.setText(`${v.name} (${v.lang})`);
        if (v.name === this.plugin.settings.selectedVoice) {
          opt.selected = true;
        }
      }
    };

    // Voices may not be ready immediately
    populateVoices();
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = populateVoices;
    }

    select.addEventListener("change", async () => {
      this.plugin.settings.selectedVoice = select.value;
      await this.plugin.saveSettings();
    });

    // Test voice button
    voiceSetting.addButton((b) =>
      b.setButtonText("Test Voice").onClick(() => {
        speakText("Hello, I am your Kindroid assistant.", this.plugin.settings.selectedVoice);
      })
    );

    // Appearance
    containerEl.createEl("h3", { text: "Appearance" });

    const refreshView = () => {
      const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_KINDROID);
      if (leaves.length > 0) {
        const view = leaves[0].view as KindroidView;
        view.applyStyles();
      }
    };

    new Setting(containerEl)
      .setName("Font size")
      .setDesc("Chat panel font size in pixels (default: 16)")
      .addSlider((s) =>
        s
          .setLimits(12, 24, 1)
          .setValue(this.plugin.settings.fontSize)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.fontSize = v;
            await this.plugin.saveSettings();
            refreshView();
          })
      );

    new Setting(containerEl)
      .setName("Font")
      .setDesc("Chat panel font family")
      .addDropdown((d) =>
        d
          .addOption("Poppins", "Poppins (Kindroid native)")
          .addOption("Lora", "Lora (elegant serif)")
          .addOption("JetBrains Mono", "JetBrains Mono (monospace)")
          .addOption("Nunito", "Nunito (rounded sans)")
          .setValue(this.plugin.settings.fontFamily)
          .onChange(async (v) => {
            this.plugin.settings.fontFamily = v;
            await this.plugin.saveSettings();
            refreshView();
          })
      );

    // Microphone mode
    containerEl.createEl("h3", { text: "Microphone / Dictation" });

    new Setting(containerEl)
      .setName("Microphone button mode")
      .setDesc(
        "Native: attempts to use the browser built-in speech recognition. " +
        "This works on some systems (Linux, Mac) but is blocked by Obsidian on Windows. " +
        "If it fails, the button falls back to the tooltip automatically. " +
        "Tooltip: the mic button shows a reminder to use Win+H (Windows 10+). " +
        "Win+H will not work on older Windows, Linux, or Mac. " +
        "Those on other systems are welcome to fork this plugin and implement a working alternative."
      )
      .addDropdown((d) =>
        d
          .addOption("tooltip", "Tooltip — Win+H reminder (recommended for Windows)")
          .addOption("native", "Native — may work on Linux / Mac (untested)")
          .setValue(this.plugin.settings.micMode)
          .onChange(async (v: string) => {
            this.plugin.settings.micMode = v as "native" | "tooltip";
            await this.plugin.saveSettings();
          })
      );
  }
}

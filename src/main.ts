import {
  App,
  ItemView,
  Modal,
  normalizePath,
  Plugin,
  PluginSettingTab,
  SecretComponent,
  Setting,
  setIcon,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

const VIEW_TYPE_KINDROID = "kindroid-assistant-view";

// Fixed id under which the Kindroid API key lives in Obsidian's own
// SecretStorage (device-local, outside the vault — see getApiKey()).
const API_KEY_SECRET_ID = "kindroid-assistant-api-key";

// ---------------------------------------------------------
// Settings
// ---------------------------------------------------------

interface IdSlot {
  name: string;
  id: string;
}

// A Group Chat slot, plus how Poke should talk to it. See pokeGroup()
// for the full reasoning — short version: groupchats-get-turn 400s on
// a group with only one companion ("No valid participants available
// for group turn selection"), so a single-companion group needs Poke
// to skip get-turn and call groupchats-ai-response directly instead,
// which needs that one companion's id up front since there's no
// documented way to read a group's roster.
interface GroupSlot extends IdSlot {
  // undefined = not yet chosen. Poke refuses to guess at this and
  // tells the person to pick one in Settings first, rather than
  // silently defaulting to whichever path and risking the wrong one.
  companionMode?: "single" | "multi";
  // Only read when companionMode is "single".
  singleCompanionId?: string;
}

interface KindroidSettings {
  // Legacy plain-text key, kept only as a migration source (copied into
  // SecretStorage on first load, then cleared) and as a fallback for an
  // Obsidian version too old to have secretStorage (pre-1.11.4) — see
  // getApiKey(). Once apiKeySecretId is set, this should be empty.
  apiKey: string;
  // The id of the actual key in Obsidian's SecretStorage — not the key
  // itself. Normally API_KEY_SECRET_ID, but SecretComponent lets the
  // person point at any secret they'd already created some other way.
  apiKeySecretId: string;
  aiId: string;
  chatMode: "single" | "group";
  groupId: string;
  greeting: string;
  selectedVoice: string;
  ttsAutoPlay: boolean;
  micMode: "native" | "tooltip";
  fontSize: number;
  fontFamily: string;
  assistantName: string;
  userName: string;
  // Poke button — single-AI mode has no silent "continue" call, so we
  // send one of these short lines instead. Group mode ignores these
  // entirely (it uses groupchats-get-turn with no message).
  pokeLines: [string, string, string];
  // The chat panel's one-time welcome message, shown when it first
  // opens with no messages yet.
  startupGreeting: string;
  // Hot-swap picker — up to 10 saved AIs and 10 saved groups. aiId /
  // chatMode / groupId above are kept as the "currently resolved"
  // values everything else in the plugin reads; switching the picker
  // just rewrites those three from whichever slot was chosen, so none
  // of the existing send/poke/chat-break code needed to change.
  aiSlots: IdSlot[];
  groupSlots: GroupSlot[];
  activeKind: "ai" | "group";
  activeIndex: number;
  // Group-companion phone book — ai_id -> name, global (not per-group,
  // not capped). get-chat-messages has no field that identifies who
  // sent a message beyond display_name, and that's a per-message
  // snapshot, not a stable id — confirmed against a real multi-
  // companion group's raw response. So there's no reliable way to
  // resolve a group speaker's name from the server at all; this is
  // filled in once, by hand, per companion, and then just works
  // forever. An empty string means "seen speaking, not named yet".
  phoneBook: Record<string, string>;
  // Set Scene — ai_id/group_id -> the last current_scene sent for that
  // chat. Kindroid's API has no "get info" endpoint to read a chat's
  // current scene back, so the only way to show what's already set
  // (and let the dialogue reopen pre-filled instead of blank every
  // time) is for the plugin to remember what it last sent. One entry
  // per saved slot — up to 10 AI + 10 group, same id space as phoneBook
  // uses for ai_id, but keyed by whichever id (ai or group) was active
  // when Set Scene was used.
  sceneBook: Record<string, string>;
  // Set Scene Presets — one quick-fill phrase per decorative icon in
  // the Set Scene popup (see SCENE_PRESET_ICONS for the five keys).
  // Global, not per-chat, same as the Chat Break default greeting
  // below — defined once here in Settings, then pressing the matching
  // icon in the popup copies it into the scene textarea.
  scenePresets: Record<string, string>;
  // Max AI-to-AI turns per user message in Group Chat, before the
  // cursor is handed back to the user. User-adjustable (1-5) — tested
  // against the official Kindroid web app's own typical range (mostly
  // 1-3, occasionally up to 5-6) so this stays within what's normal
  // there rather than the old fixed 20, which was only ever a safety
  // ceiling, not a deliberate pacing choice.
  maxGroupTurns: number;
}

const DEFAULT_SETTINGS: KindroidSettings = {
  apiKey: "",
  apiKeySecretId: "",
  aiId: "",
  chatMode: "single",
  groupId: "",
  greeting: "Hello! I'm ready to help you with Obsidian and your writing today.",
  selectedVoice: "",
  ttsAutoPlay: false,
  micMode: "tooltip",
  fontSize: 16,
  fontFamily: "Poppins",
  assistantName: "Assistant",
  userName: "You",
  pokeLines: [
    '*knocks on the door* "Hello?"',
    '*screams into the void* "Are you there?"',
    "I'm back.",
  ],
  startupGreeting: "Hello! I'm here to help. You can ask me anything, or paste a paragraph of text and I'll assist with it.",
  aiSlots: [
    { name: "", id: "" },
    { name: "", id: "" },
    { name: "", id: "" },
    { name: "", id: "" },
    { name: "", id: "" },
    { name: "", id: "" },
    { name: "", id: "" },
    { name: "", id: "" },
    { name: "", id: "" },
    { name: "", id: "" },
  ],
  groupSlots: [
    { name: "", id: "" },
    { name: "", id: "" },
    { name: "", id: "" },
    { name: "", id: "" },
    { name: "", id: "" },
    { name: "", id: "" },
    { name: "", id: "" },
    { name: "", id: "" },
    { name: "", id: "" },
    { name: "", id: "" },
  ],
  activeKind: "ai",
  activeIndex: 0,
  phoneBook: {},
  sceneBook: {},
  scenePresets: {
    sofa: "",
    microwave: "",
    armchair: "",
    lampFloor: "",
    shelvingUnit: "",
  },
  maxGroupTurns: 5,
};

// Hard floor/ceiling for the Settings slider — kept in code so the
// slider and any migration default stay in sync.
const MIN_GROUP_TURNS = 1;
const MAX_GROUP_TURNS_LIMIT = 5;

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------

// Kindroid's current_scene cap — shared by the Set Scene popup's
// textarea/countdown and the Settings preset fields that feed it, so
// a preset can never be longer than what the popup will actually send.
const SET_SCENE_MAX_LENGTH = 160;

// Set Scene's five decorative/quick-fill icons — one definitive list,
// shared by the Set Scene popup (SetSceneModal) and the Set Scene
// Presets section in Settings, so the icons, their order, and the
// settings key each one reads from can't drift apart between the two.
const SCENE_PRESET_ICONS: {
  key: string;
  label: string;
  primary: string;
  fallback?: string;
}[] = [
  { key: "sofa", label: "Sofa", primary: "sofa" },
  // Label only — reads as "Television" everywhere shown (the icon it
  // renders, Lucide's "microwave", looks like a CRT/TV set and was
  // picked for that). The key and icon name stay "microwave" so this
  // doesn't orphan anything already saved under that key in data.json.
  { key: "microwave", label: "Television", primary: "microwave" },
  { key: "armchair", label: "Armchair", primary: "armchair" },
  { key: "lampFloor", label: "Floor Lamp", primary: "lamp-floor", fallback: "lamp" },
  // "shelving-unit" is a newer Lucide addition that may not exist in
  // whichever Lucide version this Obsidian install bundles —
  // setIconOrFallback below checks whether it actually rendered and
  // tries "shelves", then a safe generic icon, if not.
  { key: "shelvingUnit", label: "Shelving Unit", primary: "shelving-unit", fallback: "shelves" },
];

// Tries each Lucide icon name in order and keeps the first one that
// actually renders an <svg> — Obsidian's setIcon silently leaves an
// element empty on an unknown name rather than throwing, so this is
// the only way to tell it failed. Last candidate should always be a
// safe, long-standing icon name so nothing is ever left blank.
function setIconOrFallback(el: HTMLElement, candidates: (string | undefined)[]) {
  for (const name of candidates) {
    if (!name) continue;
    el.empty();
    setIcon(el, name);
    if (el.querySelector("svg")) return;
  }
}

// Parse *action text* and render as styled spans (no italics)
// Group replies can carry an embedded, invisible-to-humans marker when a
// companion attaches something — e.g. `<kr_action>{"type":"selfie",...}</kr_action>`.
// This only ever showed up once we started reading ai-response as plain
// text (streaming); we never confirmed whether the old get-chat-messages
// path also carried it, so this runs unconditionally and is a harmless
// no-op on text that doesn't have one. We don't have a way to fetch the
// actual image (Kindroid delivers it to the web app over a private
// Firestore realtime channel, not any documented REST call), so this is
// a readable stand-in, not a placeholder for something we'll fill in later.
const KR_ACTION_RE = /<kr_action>([\s\S]*?)<\/kr_action>/g;
// The two markers stripKrActions can insert in place of a <kr_action>
// tag — kept as a list so the flush-against-text fix below can guard
// both the same way, rather than just the selfie case that was seen.
const KR_ACTION_MARKERS = [
  "📷 sent a selfie",
  "📎 (sent something the panel can't display yet)",
];
function stripKrActions(text: string): { text: string; sawSelfie: boolean } {
  let sawSelfie = false;
  let cleaned = text.replace(KR_ACTION_RE, (_match, json) => {
    try {
      const parsed = JSON.parse(json);
      if (parsed?.type === "selfie") {
        sawSelfie = true;
        return "📷 sent a selfie";
      }
      console.log("[Kindroid] unrecognized kr_action type:", parsed?.type, "raw:", json);
      return "📎 (sent something the panel can't display yet)";
    } catch {
      console.log("[Kindroid] kr_action tag didn't parse as JSON:", json);
      return "📎 (sent something the panel can't display yet)";
    }
  });

  // The replace above drops straight into wherever the <kr_action> tag
  // sat in the raw reply. Usually that's already separated from the
  // surrounding message by whitespace, but when the tag lands flush
  // against the first or last word — seen once, at the very start of
  // a reply — the marker ran straight into that word with no gap at
  // all ("📷 sent a selfieHello…"). Force a single space on whichever
  // side is actually missing one.
  for (const marker of KR_ACTION_MARKERS) {
    const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned
      .replace(new RegExp(`(\\S)${esc}`, "g"), `$1 ${marker}`)
      .replace(new RegExp(`${esc}(\\S)`, "g"), `${marker} $1`);
  }

  cleaned = cleaned.trim();
  return { text: cleaned, sawSelfie };
}

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
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    // On a brand-new install (no data.json yet), Object.assign would
    // otherwise leave this.settings.phoneBook pointing at the exact
    // same object as DEFAULT_SETTINGS.phoneBook — meaning every future
    // mutation (every companion this session learns) would leak into
    // the shared default rather than this user's own data. Always
    // start from a fresh copy, whether it came from disk or the default.
    this.settings.phoneBook = { ...(data?.phoneBook ?? {}) };
    this.settings.sceneBook = { ...(data?.sceneBook ?? {}) };
    // Same fresh-copy fix as sceneBook/phoneBook above, plus merged
    // over the defaults (not replaced by them) so a saved file from
    // before a given preset existed still gets that key as "" rather
    // than undefined.
    this.settings.scenePresets = {
      ...DEFAULT_SETTINGS.scenePresets,
      ...(data?.scenePresets ?? {}),
    };

    let migrated = false;

    // aiSlots grew from 5 to 10 — a saved array from before that change
    // would otherwise stay stuck at 5 forever, since Object.assign above
    // replaces the whole array rather than padding it out.
    while (this.settings.aiSlots.length < 10) {
      this.settings.aiSlots.push({ name: "", id: "" });
      migrated = true;
    }

    // groupSlots grew from 5 to 10 the same way — same padding needed.
    while (this.settings.groupSlots.length < 10) {
      this.settings.groupSlots.push({ name: "", id: "" });
      migrated = true;
    }

    // One-time migration: carry a pre-existing single AI ID / Group ID
    // into slot 1 of the new picker, rather than starting it empty.
    if (!this.settings.aiSlots[0].id && this.settings.aiId) {
      this.settings.aiSlots[0] = { name: "AI 1", id: this.settings.aiId };
      migrated = true;
    }
    if (!this.settings.groupSlots[0].id && this.settings.groupId) {
      this.settings.groupSlots[0] = { name: "Group 1", id: this.settings.groupId };
      migrated = true;
    }
    if (data?.activeKind === undefined && data?.activeIndex === undefined) {
      // First run with the picker fields — default to whichever mode
      // was already in use, not always slot 1 of "AI".
      this.settings.activeKind = this.settings.chatMode === "group" ? "group" : "ai";
      this.settings.activeIndex = 0;
      migrated = true;
    }

    // One-time migration: move a pre-existing plain-text API key into
    // Obsidian's own secret storage, then clear the plain-text copy —
    // the person doesn't need to retype their key for this to become
    // secure. Only runs once; if it fails for any reason (an old
    // Obsidian without secretStorage, say), the plain-text key is left
    // exactly as it was, so nothing is lost either way.
    const app = this.app as any;
    if (!this.settings.apiKeySecretId && this.settings.apiKey && app.secretStorage) {
      try {
        app.secretStorage.setSecret(API_KEY_SECRET_ID, this.settings.apiKey);
        this.settings.apiKeySecretId = API_KEY_SECRET_ID;
        this.settings.apiKey = "";
        migrated = true;
        console.log("[Kindroid] migrated API key into Obsidian's secret storage.");
      } catch (e) {
        console.log("[Kindroid] could not migrate API key into secret storage — leaving it as plain text for now:", e);
      }
    }

    // Clamp in case of a hand-edited or otherwise out-of-range value —
    // keeps the slider itself simple (it can just trust this is sane).
    if (
      typeof this.settings.maxGroupTurns !== "number" ||
      this.settings.maxGroupTurns < MIN_GROUP_TURNS ||
      this.settings.maxGroupTurns > MAX_GROUP_TURNS_LIMIT
    ) {
      this.settings.maxGroupTurns = DEFAULT_SETTINGS.maxGroupTurns;
      migrated = true;
    }

    // Backfill Contacts with anyone already saved as a Main Chat slot
    // (see seedPhoneBookFromAiSlots' own comment for why).
    if (this.seedPhoneBookFromAiSlots()) migrated = true;

    // One-time repair for a bug where seeding ran on every keystroke in
    // the Main Chat Name field — the first character typed created a
    // non-empty Contacts entry, and seedPhoneBookFromAiSlots' "never
    // overwrite a non-empty entry" rule (there to protect a Contacts
    // name someone deliberately set differently) then refused to ever
    // update it again, leaving Contacts, Group Chat display names, and
    // Export to Note titles stuck on just that one letter. Settings
    // onChange no longer re-seeds on every keystroke (see the Main
    // Chat slot fields below), so this won't recur — this just fixes
    // names already stuck that way. Only touches a Contacts entry that
    // is a strict, shorter prefix of its slot's current name — a
    // strong signal of exactly this bug, not a short name chosen
    // on purpose.
    if (this.repairTruncatedPhoneBookEntries()) migrated = true;

    this.applyActiveSlot();
    if (migrated) await this.saveSettings();
  }

  // The actual API key, resolved at the moment it's needed rather than
  // stored anywhere as a flat string. Prefers Obsidian's SecretStorage
  // (device-local, outside the vault, never synced or written to this
  // plugin's data.json); falls back to the legacy plain-text field only
  // if secret storage isn't available or nothing's been set there yet.
  getApiKey(): string {
    const app = this.app as any;
    if (app.secretStorage && this.settings.apiKeySecretId) {
      try {
        const val = app.secretStorage.getSecret(this.settings.apiKeySecretId);
        if (val) return val;
      } catch (e) {
        console.log("[Kindroid] secret lookup failed:", e);
      }
    }
    return this.settings.apiKey;
  }

  // Copies the currently-selected slot's id into the plain
  // chatMode/aiId/groupId fields that the rest of the plugin already
  // reads — so switching the picker is the only thing that needs to
  // know slots exist at all.
  // "Why isn't such-and-such in Contacts?" — a companion saved as a
  // Main Chat (1:1) slot has a known name + id, so there's no reason
  // to wait for them to speak in a Group Chat before they show up in
  // the Contacts popup. Additive only: never overwrites a name already
  // sitting in the phone book (someone may have deliberately given a
  // companion a different name there than in Main Chat), and never
  // touches a slot's own name/id — it only ever adds a missing entry.
  // Runs once on load (to backfill existing installs) and again every
  // time a Main Chat slot's name or id is edited in Settings.
  seedPhoneBookFromAiSlots(): boolean {
    let added = false;
    for (const slot of this.settings.aiSlots) {
      const id = slot.id.trim();
      const name = slot.name.trim();
      if (!id || !name) continue;
      if (!(id in this.settings.phoneBook) || !this.settings.phoneBook[id]?.trim()) {
        this.settings.phoneBook[id] = name;
        added = true;
      }
    }
    return added;
  }

  // See the call site in loadSettings() for what this repairs and why.
  repairTruncatedPhoneBookEntries(): boolean {
    let repaired = false;
    for (const slot of this.settings.aiSlots) {
      const id = slot.id.trim();
      const name = slot.name.trim();
      if (!id || !name) continue;
      const existing = this.settings.phoneBook[id];
      if (existing && existing.length < name.length && name.startsWith(existing)) {
        this.settings.phoneBook[id] = name;
        repaired = true;
      }
    }
    return repaired;
  }

  applyActiveSlot() {
    const slot =
      this.settings.activeKind === "group"
        ? this.settings.groupSlots[this.settings.activeIndex]
        : this.settings.aiSlots[this.settings.activeIndex];
    if (!slot) return;
    this.settings.chatMode = this.settings.activeKind === "group" ? "group" : "single";
    if (this.settings.activeKind === "group") {
      this.settings.groupId = slot.id;
    } else {
      this.settings.aiId = slot.id;
    }
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
  slotPicker: HTMLSelectElement;
  statusEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  newChatBtn: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
  pokeBtn: HTMLButtonElement;
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
    titleEl.addClass("ka-header-title-link");
    titleEl.setAttribute("title", "Open this chat in the Kindroid web client");
    titleEl.addEventListener("click", () => {
      const url = this.getCurrentWebChatUrl();
      if (url) window.open(url, "_blank");
    });

    const headerRight = header.createDiv("ka-header-right");

    // Hot-swap picker — switch which saved AI or group this panel talks
    // to without going into Settings. Selecting an option here is the
    // only thing that decides single vs group mode now; there's no
    // separate mode toggle to keep in sync with it.
    this.slotPicker = headerRight.createEl("select", { cls: "ka-slot-picker" });
    this.renderSlotPicker();
    this.slotPicker.addEventListener("change", async () => {
      const [kind, idxStr] = this.slotPicker.value.split(":");
      this.plugin.settings.activeKind = kind as "ai" | "group";
      this.plugin.settings.activeIndex = parseInt(idxStr, 10);
      this.plugin.applyActiveSlot();
      await this.plugin.saveSettings();
      // Switching identity mid-panel is intentional (that's the point
      // of hot-swapping) — we don't clear the visible transcript.
      // Group companion names come from the phone book (📞 button,
      // just below) — nothing to fetch or trigger on switch.
    });

    // Phone book — one click from here to name whoever just showed up
    // as "Unknown", rather than a trip to Obsidian's Settings window.
    // An SVG icon rather than the 📞 emoji — emoji glyph colour is fixed
    // by the system font, not CSS, so it couldn't match Vanilla Light
    // vs Vanilla Dark (or any theme); setIcon()'s Lucide icon takes
    // currentColor like every other Obsidian icon button.
    const phoneBookBtn = headerRight.createEl("button", {
      cls: "ka-phonebook-btn",
      attr: { title: "Group Contacts — name a companion" },
    });
    setIcon(phoneBookBtn, "phone");
    phoneBookBtn.addEventListener("click", () => {
      new PhoneBookModal(this.app, this.plugin).open();
    });

    this.copyAllBtn = headerRight.createEl("button", {
      cls: "ka-copy-btn",
      attr: { title: "Tools" },
    });
    // Lucide's built-in "wrench" icon — setIcon renders it with
    // stroke="currentColor", so it picks up the same light grey as the
    // rest of the toolbar (.ka-copy-btn's `color: #CBCBCB`) with no
    // extra color rule needed.
    setIcon(this.copyAllBtn, "wrench");
    this.copyAllBtn.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation();
      this.showCopyAllMenu(e);
    });

    // ── Message list ─────────────────────────────────────
    this.messagesEl = root.createDiv("ka-messages");

    // Small transient status line for background work that isn't a chat
    // message — currently just the group name walk. Hidden by default.
    this.statusEl = root.createDiv("ka-status-row");
    this.statusEl.style.display = "none";

    // Custom context menu on right-click
    this.messagesEl.addEventListener("contextmenu", (e: MouseEvent) => {
      this.handleContextMenu(e);
    });

    // Dismiss context menu on click elsewhere
    document.addEventListener("click", () => this.dismissContextMenu(), true);

    this.renderBubble("assistant", this.plugin.settings.startupGreeting);

    // ── Input area ───────────────────────────────────────
    const inputWrap = root.createDiv("ka-input-wrap");

    this.inputEl = inputWrap.createEl("textarea", {
      cls: "ka-input",
      attr: { placeholder: "Ask something, or paste text here… (Ctrl+Enter to send)" },
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
      attr: {
        title:
          "Resets memory and starts a fresh conversation. Sends whatever's in the message box as the greeting (or the default greeting from Settings if the box is empty).",
      },
    });
    this.newChatBtn.addEventListener("click", () => this.chatBreak());

    this.clearBtn = btnRow.createEl("button", {
      text: "Clear Screen",
      cls: "ka-btn ka-btn-clear",
      attr: { title: "Clears the display only — memory unchanged" },
    });
    this.clearBtn.addEventListener("click", () => this.clearView());

    // Poke button — nudges for a reply without a normal message.
    // Group mode: asks the API for the next turn with no new message,
    // letting companions continue among themselves. Single AI mode has
    // no equivalent "continue" call, so it sends a short random line
    // instead (configurable in Settings).
    this.pokeBtn = btnRow.createEl("button", {
      text: "👆",
      cls: "ka-btn ka-btn-poke",
      attr: {
        title:
          "Poke — nudge for a reply without sending a message. In Group Chat mode this lets companions continue talking among themselves.",
      },
    });
    this.pokeBtn.addEventListener("click", () => this.poke());

    // Microphone button — temporarily repurposed as a "?" help button.
    // Dictation is paused pending a reliable replacement (see
    // showDictationHelp() below); the button and its handler stay in
    // place, just pointed at the explanation instead of toggleDictation().
    this.micBtn = btnRow.createEl("button", {
      cls: "ka-btn ka-btn-mic",
      attr: { title: "About dictation" },
    });
    this.micBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 2.5-3 4.5"/><line x1="12" y1="18" x2="12" y2="18.01"/></svg>`;
    this.micBtn.addEventListener("click", () => this.showDictationHelp());

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

  // ── The web client URL for whichever chat is currently active ──
  // Pulled straight from URLs confirmed against the real Kindroid web
  // app (both 1:1 and group), not guessed: https://kindroid.ai/v2/chat/
  // /<ai_id>/ for 1:1, .../chat/group/<group_id>/ for group. Used by
  // the header title's click-to-open-in-browser behaviour.
  private getCurrentWebChatUrl(): string | null {
    const { chatMode, aiId, groupId } = this.plugin.settings;
    if (chatMode === "group") {
      return groupId ? `https://kindroid.ai/v2/chat/group/${groupId}/` : null;
    }
    return aiId ? `https://kindroid.ai/v2/chat/${aiId}/` : null;
  }

  // ── Render a message bubble ────────────────────────────
  // Single-AI mode has no per-message name info the way group mode does
  // (each group reply's label comes from resolveDisplayName), so when no
  // labelOverride is given, we fall back to whichever AI is currently
  // active in the picker — not a fixed setting — so the chat labels the
  // right companion even when you've switched slots mid-session.
  private getAssistantFallbackLabel(): string {
    if (this.plugin.settings.activeKind === "ai") {
      const slot = this.plugin.settings.aiSlots[this.plugin.settings.activeIndex];
      if (slot?.name?.trim()) return slot.name.trim();
    }
    return this.plugin.settings.assistantName;
  }

  // Resolves the name attached to whichever AI ID or Group Chat ID is
  // currently active — used for export filenames so a note is labelled
  // by the actual companion/group. Looks the id up by value (not just
  // the picker's current slot position) through the same Settings +
  // Contacts (phone book) chain resolveDisplayName/getKnownAiName use
  // elsewhere, so it resolves the same way a group companion's name
  // does: Settings slot name first, then phone book. A saved slot or
  // phone book entry always has a name in normal use, so this should
  // never actually fall through to the id itself.
  private getActiveChatName(): string {
    const { activeKind, aiId, groupId, groupSlots, phoneBook } = this.plugin.settings;

    if (activeKind === "group") {
      const slot = groupSlots.find((s) => s.id.trim() === groupId.trim());
      if (slot?.name?.trim()) return slot.name.trim();
      const booked = phoneBook[groupId]?.trim();
      if (booked) return booked;
      return groupId || "Group";
    }

    const known = this.getKnownAiName(aiId);
    if (known) return known;
    return aiId || "Companion";
  }

  // Strips characters that aren't safe in a filename on Windows/macOS/Linux.
  private sanitizeForFilename(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, "").trim() || "Chat";
  }

  private renderBubble(
    role: "user" | "assistant",
    content: string,
    labelOverride?: string,
    linkUrl?: string,
    linkLabel?: string
  ): HTMLElement {
    const row = this.messagesEl.createDiv(`ka-msg ka-msg-${role}`);
    const labelRow = row.createDiv("ka-msg-label-row");
    const labelEl = labelRow.createDiv("ka-msg-label");
    labelEl.setText(
      labelOverride ?? (role === "user" ? this.plugin.settings.userName : this.getAssistantFallbackLabel())
    );
    const copyBtn = labelRow.createEl("button", {
      cls: "ka-copy-btn ka-copy-btn-inline",
      attr: { title: "Copy Response" },
    });
    copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4C2.9 1 2 1.9 2 3v14h2V3h12V1zm3 4H8C6.9 5 6 5.9 6 7v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
    const bubble = row.createDiv("ka-msg-bubble");
    parseActions(content, bubble);
    // Catches something the panel can't actually render (e.g. a selfie —
    // Kindroid delivers the image to the web app over a private realtime
    // channel we have no REST access to, see stripKrActions above) and
    // offers the one thing we CAN do: a real, clickable link straight to
    // this exact chat, where the image already is.
    if (linkUrl) {
      const linkRow = bubble.createDiv("ka-msg-link-row");
      const link = linkRow.createEl("a", {
        text: linkLabel ?? "Open in Kindroid to view →",
        attr: { href: linkUrl, target: "_blank", rel: "noopener" },
      });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        window.open(linkUrl, "_blank");
      });
    }
    copyBtn.addEventListener("click", () => {
      // Read the name straight off this message's own label (same
      // source Copy All/Export to Note use via formatTranscript),
      // rather than recomputing it from current settings — a group
      // chat message's labelOverride names that specific companion,
      // and recomputing instead picked up whichever AI/chat happens
      // to be active right now, even after switching chats.
      const labelText = labelEl.innerText ?? "";
      const bubbleText = bubble.innerText ?? "";
      navigator.clipboard.writeText("**" + this.titleCase(labelText) + "**" + ":\n" + bubbleText);
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

  // Rebuilds the hot-swap dropdown's options from current settings and
  // selects whichever slot is active. Called on open, and worth calling
  // again if Settings were edited while this panel was already open
  // (names/ids can change there) — not wired to auto-refresh yet, so a
  // rename in Settings shows up next time the panel opens.
  private renderSlotPicker() {
    this.slotPicker.empty();
    const { aiSlots, groupSlots, activeKind, activeIndex } = this.plugin.settings;

    // All 1:1 companions first (alphabetical), then all groups
    // (alphabetical) — two clean alphabetised blocks rather than one
    // list with both kinds interleaved, which read as cluttered once
    // there were more than a couple of each. 1:1 entries show just the
    // name; group entries get a "GP:" prefix so the two blocks stay
    // distinguishable without needing the old numeric index.
    type Entry = { kind: "ai" | "group"; index: number; label: string; sortKey: string };
    const entries: Entry[] = [];

    aiSlots.forEach((slot, i) => {
      if (!slot.id.trim()) return;
      const name = slot.name.trim() || `AI ${i + 1}`;
      entries.push({ kind: "ai", index: i, label: name, sortKey: name.toLowerCase() });
    });
    groupSlots.forEach((slot, i) => {
      if (!slot.id.trim()) return;
      const name = slot.name.trim() || `Group ${i + 1}`;
      entries.push({ kind: "group", index: i, label: `GP: ${name}`, sortKey: name.toLowerCase() });
    });

    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "ai" ? -1 : 1;
      return a.sortKey.localeCompare(b.sortKey);
    });

    entries.forEach((e) => {
      const opt = this.slotPicker.createEl("option", {
        value: `${e.kind}:${e.index}`,
        text: e.label,
      });
      if (activeKind === e.kind && activeIndex === e.index) opt.selected = true;
    });

    if (this.slotPicker.options.length === 0) {
      this.slotPicker.createEl("option", { value: "", text: "No AI/Group saved yet" });
    }
  }

  private setLoading(on: boolean) {
    this.sendBtn.disabled = on;
    this.newChatBtn.disabled = on;
    this.clearBtn.disabled = on;
    this.pokeBtn.disabled = on;
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
  // Dictation is paused for build 17 while a reliable local replacement
  // is researched (Win+H's Windows-10 support depends on an online
  // Microsoft speech service that's since broken; see showDictationHelp()
  // below for the exact wording shown to users). The mic button now
  // opens that explanation instead. Nothing below is deleted — just
  // commented out — so it can be reconnected once a replacement lands.
  private micTooltip: HTMLElement | null = null;

  // private showMicTooltip() {
  //   if (this.micTooltip) {
  //     this.micTooltip.remove();
  //     this.micTooltip = null;
  //     return;
  //   }
  //   const tip = document.createElement("div");
  //   tip.className = "ka-mic-tooltip";
  //   tip.setText("Press Win+H to dictate (Windows 10+)");
  //   const rect = this.micBtn.getBoundingClientRect();
  //   tip.style.position = "fixed";
  //   tip.style.left = rect.left + "px";
  //   tip.style.top = (rect.top - 44) + "px";
  //   document.body.appendChild(tip);
  //   this.micTooltip = tip;
  //   setTimeout(() => {
  //     tip.remove();
  //     if (this.micTooltip === tip) this.micTooltip = null;
  //   }, 3000);
  // }

  // private toggleDictation() {
  //   if (this.plugin.settings.micMode === "tooltip") {
  //     this.showMicTooltip();
  //     return;
  //   }
  //
  //   // Native mode — attempt Web Speech API
  //   const SR =
  //     (window as any).SpeechRecognition ||
  //     (window as any).webkitSpeechRecognition;
  //
  //   if (!SR) {
  //     this.showMicTooltip();
  //     return;
  //   }
  //
  //   if (this.recognition) {
  //     this.recognition.stop();
  //     this.recognition = null;
  //     this.micBtn.removeClass("ka-btn-mic-active");
  //     return;
  //   }
  //
  //   const rec = new SR();
  //   rec.continuous = true;
  //   rec.interimResults = true;
  //   rec.lang = "en-AU";
  //
  //   let finalTranscript = "";
  //
  //   rec.onresult = (event: any) => {
  //     let interim = "";
  //     for (let i = event.resultIndex; i < event.results.length; i++) {
  //       const t = event.results[i][0].transcript;
  //       if (event.results[i].isFinal) {
  //         finalTranscript += t + " ";
  //       } else {
  //         interim = t;
  //       }
  //     }
  //     this.inputEl.value = finalTranscript + interim;
  //     this.inputEl.style.height = "auto";
  //     this.inputEl.style.height =
  //       Math.min(this.inputEl.scrollHeight, 160) + "px";
  //   };
  //
  //   rec.onerror = () => {
  //     this.micBtn.removeClass("ka-btn-mic-active");
  //     this.recognition = null;
  //     this.showMicTooltip();
  //   };
  //
  //   rec.onend = () => {
  //     this.micBtn.removeClass("ka-btn-mic-active");
  //     this.recognition = null;
  //   };
  //
  //   rec.start();
  //   this.recognition = rec;
  //   this.micBtn.addClass("ka-btn-mic-active");
  // }

  // Replacement for the mic button while dictation is paused: a
  // dismiss-on-click-outside popup (the explanation is long enough that
  // the old 3-second auto-hide tooltip would cut it off).
  private showDictationHelp() {
    if (this.micTooltip) {
      this.micTooltip.remove();
      this.micTooltip = null;
      return;
    }
    const tip = document.createElement("div");
    tip.className = "ka-mic-tooltip ka-mic-help";
    const p1 = document.createElement("p");
    p1.className = "ka-mic-help-para";
    p1.textContent =
      "Within build 16, this was a dictation button. Win+H may still work within windows 11 or future versions of windows, and isn't reliant on third party compatibility.";
    const p2 = document.createElement("p");
    p2.className = "ka-mic-help-para";
    p2.textContent =
      "For the moment, a reliable replacement is being researched, and may be implemented in a future version to provide secure reliability for speech to text (dictation).";
    tip.appendChild(p1);
    tip.appendChild(p2);
    const rect = this.micBtn.getBoundingClientRect();
    tip.style.position = "fixed";
    tip.style.right = (window.innerWidth - rect.right) + "px";
    tip.style.top = (rect.top - 8) + "px";
    tip.style.transform = "translateY(-100%)";
    document.body.appendChild(tip);
    this.micTooltip = tip;

    setTimeout(() => {
      const dismiss = (ev: MouseEvent) => {
        if (tip.contains(ev.target as Node) || this.micBtn.contains(ev.target as Node)) return;
        tip.remove();
        if (this.micTooltip === tip) this.micTooltip = null;
        document.removeEventListener("click", dismiss, true);
      };
      document.addEventListener("click", dismiss, true);
    }, 50);
  }

  // ── Clear view only (no chat break) ───────────────────
  private clearView() {
    this.messagesEl.empty();
    const name = this.getActiveChatName();
    this.renderBubble(
      "assistant",
      `Conversation Panel cleared. You are talking to "${name}". This is not a Chat-Break, context remains unchanged.`
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

  // ── Refresh message labels with current name settings ──
  // Only "Your name" is a single global setting now — assistant labels
  // are resolved per message (per-companion in group mode, the active
  // AI's own name in single mode), so we leave those exactly as they
  // were rendered rather than overwriting them all with one string.
  refreshLabels() {
    if (!this.messagesEl) return;
    const msgs = this.messagesEl.querySelectorAll(".ka-msg-user .ka-msg-label");
    msgs.forEach((label) => {
      (label as HTMLElement).textContent = this.plugin.settings.userName;
    });
  }

  // ── Copy All dropdown menu ────────────────────────────
  private copyAllMenu: HTMLElement | null = null;

  // Normal English title-casing: first letter of each word capitalised,
  // the rest lower case — "crash test dummy" -> "Crash Test Dummy",
  // "MATTHEW green" -> "Matthew Green". Display names are free text
  // (API-supplied or typed into the phone book), so this is a plain
  // per-word capitalisation rather than a full proper-noun ruleset.
  private titleCase(s: string): string {
    return s
      .trim()
      .toLowerCase()
      .replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  }

  // Shared by Copy All and Export to Note so the two can't drift apart:
  // display names come out **Bolded Title Case**, with a horizontal
  // rule between each speaker's turn.
  private formatTranscript(rows: Element[]): string {
    return rows
      .filter((row) => row.classList.contains("ka-msg"))
      .map((row) => {
        const rawLabel = (row.querySelector(".ka-msg-label") as HTMLElement)?.innerText ?? "";
        const bubble = (row.querySelector(".ka-msg-bubble") as HTMLElement)?.innerText ?? "";
        const label = "**" + this.titleCase(rawLabel) + "**";
        return label + "\n" + bubble;
      })
      .join("\n\n---\n\n");
  }

  private getAllText(): string {
    return this.formatTranscript(Array.from(this.messagesEl.children));
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

    menu.createDiv("ka-context-divider");

    const sceneItem = menu.createDiv("ka-context-item");
    sceneItem.setText("Set Scene");
    sceneItem.addEventListener("click", () => {
      this.openSetSceneModal();
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
  private static readonly EXPORT_FOLDER = "Kindroid Exports";

  private async ensureExportFolder(): Promise<void> {
    const folderPath = normalizePath(KindroidView.EXPORT_FOLDER);
    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (!existing) {
      try {
        await this.app.vault.createFolder(folderPath);
      } catch (err: any) {
        // Ignore "already exists" races; anything else will surface when
        // we try to create the note itself.
      }
    }
  }

  private async exportToNote() {
    await this.ensureExportFolder();

    const isGroup = this.plugin.settings.activeKind === "group";
    const chatTypeLabel = isGroup ? "Kindroid Group Chat" : "Kindroid Chat";
    const chatName = this.sanitizeForFilename(this.getActiveChatName());

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 5).replace(":", "-");
    const fileName = `${chatTypeLabel} - ${chatName} - ${dateStr} ${timeStr}.md`;
    const filePath = normalizePath(`${KindroidView.EXPORT_FOLDER}/${fileName}`);

    const lines: string[] = [`# ${chatTypeLabel} — ${chatName}\n`, `*Exported: ${now.toLocaleString()}*\n`, "---\n"];
    lines.push(this.formatTranscript(Array.from(this.messagesEl.querySelectorAll(".ka-msg"))));

    const content = lines.join("\n");

    try {
      const file = await this.app.vault.create(filePath, content);
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.openFile(file as TFile);
    } catch (err: any) {
      this.renderBubble("assistant", "⚠️ Could not create note: " + err.message);
    }
  }

  // ── Set Scene ───────────────────────────────────────────
  // Same up-front guards as every other API action here (key, then the
  // active chat's id) before the modal even opens, so a missing key or
  // id doesn't show up as a failed Send after the person's already
  // typed something.
  private openSetSceneModal() {
    const apiKey = this.plugin.getApiKey();
    const { aiId, chatMode, groupId } = this.plugin.settings;
    const isGroup = chatMode === "group";

    if (!apiKey) {
      this.renderBubble(
        "assistant",
        "⚠️ Please enter your API key in Settings → Kindroid Assistant."
      );
      return;
    }
    const sceneKey = isGroup ? groupId : aiId;
    if (!sceneKey) {
      this.renderBubble(
        "assistant",
        isGroup
          ? "⚠️ Please enter your Group Chat ID in Settings → Kindroid Assistant."
          : "⚠️ Please enter your AI ID in Settings → Kindroid Assistant."
      );
      return;
    }

    new SetSceneModal(this.app, this.plugin, sceneKey, isGroup, async (scene) => {
      this.plugin.settings.sceneBook[sceneKey] = scene;
      await this.plugin.saveSettings();
      this.renderBubble(
        "assistant",
        scene ? "Scene Set\n\n" + scene : "Scene Cleared"
      );
    }).open();
  }

  // ── Send a message ─────────────────────────────────────
  async sendMessage() {
    const apiKey = this.plugin.getApiKey();
    const { aiId, chatMode, groupId } = this.plugin.settings;

    if (!apiKey) {
      this.renderBubble(
        "assistant",
        "⚠️ Please enter your API key in Settings → Kindroid Assistant."
      );
      return;
    }
    if (chatMode === "single" && !aiId) {
      this.renderBubble(
        "assistant",
        "⚠️ Please enter your AI ID in Settings → Kindroid Assistant."
      );
      return;
    }
    if (chatMode === "group" && !groupId) {
      this.renderBubble(
        "assistant",
        "⚠️ Please enter your Group Chat ID in Settings → Kindroid Assistant."
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

    try {
      if (chatMode === "group") {
        await this.runGroupExchange(text);
      } else {
        await this.runSingleExchange(text);
      }
    } finally {
      this.setLoading(false);
      this.inputEl.focus();
    }
  }

  // ── Poke: nudge for a reply without a normal message ──
  async poke() {
    const apiKey = this.plugin.getApiKey();
    const { aiId, chatMode, groupId } = this.plugin.settings;

    if (!apiKey) {
      this.renderBubble(
        "assistant",
        "⚠️ Please enter your API key in Settings → Kindroid Assistant."
      );
      return;
    }
    if (chatMode === "single" && !aiId) {
      this.renderBubble(
        "assistant",
        "⚠️ Please enter your AI ID in Settings → Kindroid Assistant."
      );
      return;
    }
    if (chatMode === "group" && !groupId) {
      this.renderBubble(
        "assistant",
        "⚠️ Please enter your Group Chat ID in Settings → Kindroid Assistant."
      );
      return;
    }

    // Stop dictation if running
    if (this.recognition) {
      this.recognition.stop();
      this.recognition = null;
      this.micBtn.removeClass("ka-btn-mic-active");
    }

    this.setLoading(true);

    try {
      if (chatMode === "group") {
        await this.pokeGroup();
      } else {
        await this.pokeSingle();
      }
    } finally {
      this.setLoading(false);
      this.inputEl.focus();
    }
  }

  // ── Poke, single AI mode ────────────────────────────────
  // No "continue without a message" call exists for single AI chat,
  // so we send one of the user's configured poke lines like a normal
  // message.
  private async pokeSingle() {
    const lines = this.plugin.settings.pokeLines.filter((l) => l.trim().length > 0);
    const text = lines.length > 0
      ? lines[Math.floor(Math.random() * lines.length)]
      : "👆";

    this.renderBubble("user", text);
    await this.runSingleExchange(text);
  }

  // ── Poke, group chat mode ───────────────────────────────
  // Asks the API whose turn it is with no new user message. This lets
  // companions continue talking among themselves. Same turn-loop as a
  // normal group exchange, just without the groupchats-user-message
  // step in front of it.
  // Matches the web app's own "Continue" behaviour, confirmed against
  // its network traffic: one get-turn, one ai-response, done. It does
  // NOT loop back to ask who's turn it is again afterwards — repeatedly
  // clicking Continue is what lets companions volley with each other in
  // the web app, not a single press triggering an internal loop. Our
  // earlier version looped like a normal send and could run for
  // several minutes with no way to interrupt it, since the whole
  // interface disables itself while a request is in flight.
  // groupchats-get-turn has nobody to pick between in a single-
  // companion group and 400s ("No valid participants available for
  // group turn selection"). The official client's Continue button
  // still works there — network capture confirms it calling
  // groupchats-ai-response directly with that one companion's ai_id,
  // skipping get-turn entirely — but there's no documented way to read
  // a group's roster, so which path to take has to be told to us: the
  // "Single" checkbox next to each Group Chat ID in Settings
  // (companionMode below), plus the companion's own id for the
  // single-companion path, since there's nowhere else to get it.
  // Unticked/unset defaults to multi-companion — a checkbox has no
  // third state to leave the choice unmade, so there's nothing to
  // guard against here beyond the known 400 case below.
  private async pokeGroup() {
    const apiKey = this.plugin.getApiKey();
    const { groupId, groupSlots } = this.plugin.settings;
    const slot = groupSlots.find((s) => s.id.trim() === groupId.trim());

    if (slot?.companionMode === "single") {
      const companionId = slot.singleCompanionId?.trim();
      if (!companionId) {
        this.renderBubble(
          "assistant",
          "⚠️ Please enter this group's companion AI ID in Settings → Kindroid Assistant (revealed once its Single checkbox is ticked) before using Poke."
        );
        return;
      }

      const thinkingRow = this.messagesEl.createDiv("ka-msg ka-msg-assistant");
      thinkingRow.createDiv("ka-msg-label").setText(this.plugin.settings.assistantName);
      const thinkingBubble = thinkingRow.createDiv("ka-msg-bubble ka-thinking");
      thinkingBubble.setText("Thinking…");
      this.scrollToBottom();

      try {
        // Deliberately no get-turn call and no specific-error catch
        // here beyond the generic one below — a group marked Single
        // that's actually grown a second companion (roster changed in
        // the official client, Settings not updated to match) would
        // fail this call in some way we haven't observed yet, so
        // there's nothing confirmed to special-case against. Whatever
        // comes back surfaces as-is until that's been seen and we know
        // what to catch.
        await this.handleGroupTurn(groupId, apiKey, companionId, thinkingRow, thinkingBubble);
      } catch (err: any) {
        thinkingRow.remove();
        this.renderBubble("assistant", `⚠️ Error: ${err.message}`);
      }
      return;
    }

    // Multi-companion (default, "Single" unticked) — unchanged from before.
    try {
      const turnRes = await this.fetchWithRetry("https://api.kindroid.ai/v1/groupchats-get-turn", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ group_id: groupId, allow_user: false }),
      });

      const turnRaw = (await turnRes.text()).trim();
      console.log("[Kindroid] poke get-turn status:", turnRes.status, "body:", JSON.stringify(turnRaw));

      if (!turnRes.ok) {
        // This group is marked Multi-companion but the API disagrees
        // (roster changed in the official client and Settings wasn't
        // updated to match) — the known symptom is this exact 400.
        if (
          turnRes.status === 400 &&
          /No valid participants available for group turn selection/i.test(turnRaw)
        ) {
          this.renderBubble(
            "assistant",
            "⚠️ Unable to continue conversation. Please check the Single checkbox beside this group chat's ID in plugin settings."
          );
          return;
        }
        throw new Error(`Server returned ${turnRes.status}`);
      }

      // Empty body = nobody has anything to add right now.
      if (!turnRaw) {
        this.renderBubble("assistant", "👆 (no one replied)");
        return;
      }

      const thinkingRow = this.messagesEl.createDiv("ka-msg ka-msg-assistant");
      thinkingRow.createDiv("ka-msg-label").setText(this.plugin.settings.assistantName);
      const thinkingBubble = thinkingRow.createDiv("ka-msg-bubble ka-thinking");
      thinkingBubble.setText("Thinking…");
      this.scrollToBottom();

      await this.handleGroupTurn(groupId, apiKey, turnRaw, thinkingRow, thinkingBubble);
    } catch (err: any) {
      this.renderBubble("assistant", `⚠️ Error: ${err.message}`);
    }
  }

  // ── Single-AI exchange (existing behaviour) ────────────
  private async runSingleExchange(text: string) {
    const apiKey = this.plugin.getApiKey();
    const { aiId } = this.plugin.settings;

    const thinkingRow = this.messagesEl.createDiv("ka-msg ka-msg-assistant");
    thinkingRow.createDiv("ka-msg-label").setText(this.getAssistantFallbackLabel());
    thinkingRow.createDiv("ka-msg-bubble ka-thinking").setText("Thinking…");
    this.scrollToBottom();

    try {
      const res = await this.fetchWithRetry("https://api.kindroid.ai/v1/send-message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        // stream: true confirmed (live network capture) to be what
        // reliably surfaces the <kr_action> selfie marker here — same
        // mechanism as group chat. Without it this endpoint's behaviour
        // around selfies has been inconsistent (sometimes an empty
        // reply instead of the marker).
        body: JSON.stringify({ ai_id: aiId, message: text, stream: true }),
      });

      thinkingRow.remove();

      if (!res.ok) throw new Error(`Server returned ${res.status}`);

      const rawReply = await res.text();
      console.log("[Kindroid] send-message status:", res.status, "reply length:", rawReply.length);
      // 1:1 never had this call before now — a selfie's <kr_action> tag
      // would have rendered as raw, ugly text in the chat. Same handling
      // as group: strip it, and if it was a selfie, offer a link to the
      // actual chat, since that's the only place the image itself lives.
      const { text: reply, sawSelfie } = stripKrActions(rawReply);
      const linkUrl = sawSelfie ? this.getCurrentWebChatUrl() ?? undefined : undefined;
      this.renderBubble("assistant", reply, undefined, linkUrl);
    } catch (err: any) {
      thinkingRow.remove();
      this.renderBubble("assistant", `⚠️ Error: ${err.message}`);
    }
  }

  // ── Generate a request_id for ai-response calls ────────
  // Matches the shape the official Kindroid web client sends
  // (e.g. "group-response-<uuid>"), for deduplication.
  private makeRequestId(): string {
    if (typeof crypto !== "undefined" && (crypto as any).randomUUID) {
      return `group-response-${(crypto as any).randomUUID()}`;
    }
    return `group-response-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  // ── Fetch with automatic backoff on 429 (rate limit) ───
  private async fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
    let attempt = 0;
    while (true) {
      const res = await fetch(url, options);
      if (res.status !== 429 || attempt >= maxRetries) return res;
      const wait = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
      console.log(`[Kindroid] 429 rate limited on ${url} — retrying in ${wait}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, wait));
      attempt++;
    }
  }

  // ── Fetch a page of group chat history ─────────────────
  // No longer used for name resolution (see resolveDisplayName above) —
  // kept for Build 19's export-history feature, which will genuinely
  // need to page through a group's full history.
  private async fetchGroupMessages(
    groupId: string,
    apiKey: string,
    startAfter?: number,
    limit = 10
  ): Promise<any> {
    let url = `https://api.kindroid.ai/v1/get-chat-messages?group_id=${encodeURIComponent(groupId)}&limit=${limit}`;
    if (startAfter !== undefined) url += `&start_after_timestamp=${startAfter}`;

    const res = await this.fetchWithRetry(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) throw new Error(`get-chat-messages returned ${res.status}`);
    return await res.json();
  }

  // ── Learn a companion's display name ────────────────────
  // Checked in order: (1) the phone book — a global, unbounded ai_id ->
  // name map in Settings, filled in by hand once per companion, and
  // (2) the ten saved Main Chat slots, since a group companion is
  // often also someone's saved 1:1 AI.
  //
  // There used to be a third step here — a server-side lookup via
  // get-chat-messages — but it's gone, for a hard reason, not a
  // convenience one: confirmed against a real multi-companion group's
  // raw response, every AI message's `sender` field is always the
  // literal string "ai", never a specific companion's id. display_name
  // is the only per-message identifier, and it can't be matched back
  // to an ai_id at all — not "hard to do reliably," genuinely
  // impossible from this endpoint. So there is no way to learn a
  // group companion's name from the server; the phone book is the
  // only mechanism that can work, not a first attempt at a nicer one.
  private getKnownAiName(aiId: string): string | undefined {
    const booked = this.plugin.settings.phoneBook[aiId]?.trim();
    if (booked) return booked;
    for (const slot of this.plugin.settings.aiSlots) {
      if (slot.id.trim() === aiId && slot.name.trim()) return slot.name.trim();
    }
    return undefined;
  }

  private resolveDisplayName(aiId: string): string {
    const known = this.getKnownAiName(aiId);
    if (known) return known;

    // First time this id's been seen — register it (as "seen, not
    // named yet") so it shows up in Settings ready to fill in, without
    // needing to repeat this every time they speak.
    if (!(aiId in this.plugin.settings.phoneBook)) {
      this.plugin.settings.phoneBook[aiId] = "";
      void this.plugin.saveSettings();
    }

    return `Unknown (${aiId.slice(0, 4)})`;
  }

  // ── Trigger one companion's turn and read their reply back ─
  // Reads the reply directly from ai-response's own body, streamed —
  // confirmed (three separate node tests, up to 1600+ characters) to
  // return the complete text via a plain .text() read once stream:true
  // is set, with exactly one leading space to trim. No history poll
  // needed for this any more; get-chat-messages is only still used here
  // for the one-time display-name lookup above.
  private async handleGroupTurn(
    groupId: string,
    apiKey: string,
    turnAiId: string,
    thinkingRow: HTMLElement,
    thinkingBubble: HTMLElement
  ): Promise<void> {
    const aiRes = await this.fetchWithRetry("https://api.kindroid.ai/v1/groupchats-ai-response", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        group_id: groupId,
        ai_id: turnAiId,
        request_id: this.makeRequestId(),
        stream: true,
      }),
    });

    if (!aiRes.ok) {
      thinkingRow.remove();
      throw new Error(`Server returned ${aiRes.status}`);
    }

    const rawText = (await aiRes.text()).trim();
    console.log("[Kindroid] ai-response status:", aiRes.status, "ai_id:", turnAiId, "length:", rawText.length);

    const { text: cleaned, sawSelfie } = stripKrActions(rawText);
    const displayName = this.resolveDisplayName(turnAiId);
    const linkUrl = sawSelfie ? this.getCurrentWebChatUrl() ?? undefined : undefined;

    thinkingRow.remove();

    if (cleaned) {
      this.renderBubble("assistant", cleaned, displayName, linkUrl);
    } else {
      console.log("[Kindroid] empty reply from", turnAiId, "after streaming and stripping.");
      this.renderBubble(
        "assistant",
        `⚠️ (${displayName} responded, but the reply came back empty — see console)`,
        undefined,
        linkUrl
      );
    }
  }

  // ── Group-chat exchange (auto-loop through turns) ──────
  // The ai-response endpoint's body has turned out to be unreliable
  // (it streams as text/event-stream with an empty body in testing,
  // even with stream:false requested — confirmed against both the old
  // and new Kindroid web UIs). So instead of trusting that response,
  // we treat it purely as the "go" signal, then read the actual reply
  // back from chat history via /get-chat-messages, which the docs
  // guarantee works with group_id and returns real message text.
  private async runGroupExchange(text: string) {
    const apiKey = this.plugin.getApiKey();
    const { groupId } = this.plugin.settings;

    try {
      // 1. Post the user's message to the group
      const postRes = await this.fetchWithRetry("https://api.kindroid.ai/v1/groupchats-user-message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ group_id: groupId, message: text }),
      });

      console.log("[Kindroid] user-message status:", postRes.status);

      if (!postRes.ok) throw new Error(`Server returned ${postRes.status}`);

      await new Promise((resolve) => setTimeout(resolve, 500));

      // 2. Loop: ask whose turn it is, trigger that AI, read its reply
      // back directly from ai-response's own (streamed) body, repeat.
      for (let i = 0; i < this.plugin.settings.maxGroupTurns; i++) {
        // Small courtesy pause between turns so we don't hammer the API
        // when several companions speak back-to-back.
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, 400));

        // allow_user tells the API whether it's acceptable for nobody to
        // be assigned (i.e. "AI generation may end"). On the very first
        // check right after posting, we don't want that — we want to
        // force an assignment, so we say false here specifically. Later
        // checks (i > 0) use true, letting the cycle end naturally once
        // whoever needed to speak already has.
        const turnRes = await this.fetchWithRetry("https://api.kindroid.ai/v1/groupchats-get-turn", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ group_id: groupId, allow_user: i > 0 }),
        });

        const turnRaw = await turnRes.text();
        console.log("[Kindroid] get-turn status:", turnRes.status, "body:", JSON.stringify(turnRaw));

        if (!turnRes.ok) throw new Error(`Server returned ${turnRes.status}`);

        const turnAiId = turnRaw.trim();

        // Empty body normally means "it's the user's turn" and we stop.
        // But on the very first check right after posting, Kindroid's own
        // turn-assignment can sometimes still be settling — give it a
        // couple more quick tries before accepting that as final.
        if (!turnAiId && i === 0) {
          let recovered = "";
          for (let retry = 0; retry < 3 && !recovered; retry++) {
            await new Promise((resolve) => setTimeout(resolve, 800));
            const retryRes = await this.fetchWithRetry("https://api.kindroid.ai/v1/groupchats-get-turn", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({ group_id: groupId, allow_user: false }),
            });
            const retryRaw = (await retryRes.text()).trim();
            console.log("[Kindroid] first-turn retry", retry, "body:", JSON.stringify(retryRaw));
            if (retryRaw) recovered = retryRaw;
          }
          if (recovered) {
            console.log("[Kindroid] recovered a turn after retrying:", recovered);
          } else {
            console.log("[Kindroid] get-turn stayed empty after retries — genuinely no one is replying to this message.");
            return;
          }
          // Fall through to the normal turn-handling below with the
          // recovered ai_id, as if get-turn had returned it the first time.
          const thinkingRow = this.messagesEl.createDiv("ka-msg ka-msg-assistant");
          thinkingRow.createDiv("ka-msg-label").setText(this.plugin.settings.assistantName);
          const thinkingBubble = thinkingRow.createDiv("ka-msg-bubble ka-thinking");
          thinkingBubble.setText("Thinking…");
          this.scrollToBottom();
          await this.handleGroupTurn(groupId, apiKey, recovered, thinkingRow, thinkingBubble);
          continue;
        }

        // Empty body = it's the user's turn again. Loop ends.
        if (!turnAiId) {
          return;
        }

        const thinkingRow = this.messagesEl.createDiv("ka-msg ka-msg-assistant");
        thinkingRow.createDiv("ka-msg-label").setText(this.plugin.settings.assistantName);
        const thinkingBubble = thinkingRow.createDiv("ka-msg-bubble ka-thinking");
        thinkingBubble.setText("Thinking…");
        this.scrollToBottom();

        await this.handleGroupTurn(groupId, apiKey, turnAiId, thinkingRow, thinkingBubble);
      }
    } catch (err: any) {
      this.renderBubble("assistant", `⚠️ Error: ${err.message}`);
    }
  }

  // ── Reset conversation ─────────────────────────────────
  // The message box doubles as the greeting field: whatever's typed
  // there is sent as the greeting when this button (not Send) is
  // pressed. If the box is empty, the default greeting from Settings
  // is used instead, since the API requires a non-empty greeting.
  //
  // Single AI mode: the greeting becomes the AI's opening line
  // (/chat-break, ai_id).
  // Group mode: the greeting posts as your own message to the group,
  // setting the new scene (/groupchats-chat-break, group_id) — the
  // API treats this differently from single mode, so the confirmation
  // below is labelled accordingly.
  async chatBreak() {
    const apiKey = this.plugin.getApiKey();
    const { aiId, chatMode, groupId, greeting: defaultGreeting } = this.plugin.settings;

    if (!apiKey) {
      this.renderBubble(
        "assistant",
        "⚠️ Please enter your API key in Settings → Kindroid Assistant."
      );
      return;
    }
    if (chatMode === "single" && !aiId) {
      this.renderBubble(
        "assistant",
        "⚠️ Please enter your AI ID in Settings → Kindroid Assistant."
      );
      return;
    }
    if (chatMode === "group" && !groupId) {
      this.renderBubble(
        "assistant",
        "⚠️ Please enter your Group Chat ID in Settings → Kindroid Assistant."
      );
      return;
    }

    const typed = this.inputEl.value.trim();
    const greeting = typed || defaultGreeting;

    this.setLoading(true);

    try {
      const url = chatMode === "group"
        ? "https://api.kindroid.ai/v1/groupchats-chat-break"
        : "https://api.kindroid.ai/v1/chat-break";
      const body = chatMode === "group"
        ? { group_id: groupId, greeting }
        : { ai_id: aiId, greeting };

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      console.log("[Kindroid] chat-break status:", res.status, "url:", url, "greeting:", JSON.stringify(greeting));

      if (!res.ok) throw new Error(`Server returned ${res.status}`);

      this.inputEl.value = "";
      this.inputEl.style.height = "auto";
      this.messagesEl.empty();

      const confirmation = "Chatbreak Performed\n\n" + greeting;
      if (chatMode === "group") {
        // Posted to the API as your own message, so it's shown as one.
        this.renderBubble("user", confirmation);
      } else {
        // Becomes the AI's opening line.
        this.renderBubble("assistant", confirmation);
      }
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

// ── Group Phone Book popup ──────────────────────────────
// Lives here instead of in main Settings, reachable from the 📞
// button next to the panel's picker — a group companion's name is
// usually discovered mid-conversation (they just spoke and showed up
// as "Unknown"), so naming them should take one click from the chat,
// not a trip to Obsidian's Settings window. It also keeps the main
// Settings page from growing without bound as more companions are
// learned over time.
class PhoneBookModal extends Modal {
  plugin: KindroidPlugin;

  constructor(app: App, plugin: KindroidPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    // Scoped to just this one modal via its own class — Obsidian's
    // base .modal has its own overflow/scroll built in, which would
    // otherwise stack a second scrollbar around our inner one. Only
    // touching overflow here, not the modal's own max-height, so it
    // still caps itself to the screen the same way every other modal
    // does — this just stops it from ALSO trying to scroll on top of
    // the list below already handling that.
    this.modalEl.addClass("ka-phonebook-modal");
    // ka-kindroid-modal carries the Kindroid-dark card itself (see
    // SetSceneModal below for the same thing) — without it this modal
    // is still Obsidian's own native (light-in-light-mode) modal
    // chrome around our dark inner widgets, same bug family as the
    // buttons, just never themed in the first place rather than
    // themed-but-unprotected.
    this.modalEl.addClass("ka-kindroid-modal");

    contentEl.empty();
    contentEl.createEl("h2", { text: "Group Contacts" });
    contentEl.createEl("p", {
      text:
        "Companions seen speaking in a group chat show up here. Name them once and it sticks — " +
        "unnamed ones are listed first. get-chat-messages has no field that identifies a speaker " +
        "beyond their name at the moment they sent it, so this is the reliable way to label them, " +
        "not a fallback for a nicer method.",
      cls: "setting-item-description",
    });

    const booked = Object.entries(this.plugin.settings.phoneBook);
    if (booked.length === 0) {
      contentEl.createEl("p", {
        text: "No companions seen yet — they'll appear here once they speak in a group chat.",
        cls: "setting-item-description",
      });
      return;
    }

    // Explicit scrollable container for the entries, rather than
    // relying on whatever the active theme does with a tall modal —
    // title and description above stay put; only this part scrolls.
    const listEl = contentEl.createDiv("ka-phonebook-list");

    booked
      // Unnamed entries still float to the top (so a newly-seen
      // companion is easy to spot and name), but named ones are now
      // alphabetised beneath them instead of sitting in whatever order
      // they happened to be learned in.
      .sort(([, a], [, b]) => {
        const namedA = !!a.trim();
        const namedB = !!b.trim();
        if (namedA !== namedB) return namedA ? 1 : -1;
        if (!namedA) return 0;
        return a.trim().toLowerCase().localeCompare(b.trim().toLowerCase());
      })
      .forEach(([id, name]) => {
        new Setting(listEl)
          .setName(id.slice(0, 6) + "…")
          .setDesc(id)
          .addExtraButton((b) =>
            // Lets someone grab an ID straight from the phone book and
            // paste it into Settings later, without having to dig it
            // back out of the client — the phone book may well know an
            // ID before the person has decided they want it saved there.
            b
              .setIcon("copy")
              .setTooltip("Copy ID")
              .onClick(async () => {
                await navigator.clipboard.writeText(id);
                b.setIcon("check");
                setTimeout(() => b.setIcon("copy"), 1000);
              })
          )
          .addText((t) =>
            t
              .setPlaceholder("Name")
              .setValue(name)
              .onChange(async (v) => {
                this.plugin.settings.phoneBook[id] = v.trim();
                await this.plugin.saveSettings();
              })
          );
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ── Set Scene popup ──────────────────────────────────────
// current_scene can only be written, never read back — Kindroid has no
// "get info" call for it — so whatever the plugin last sent (sceneBook,
// keyed by whichever id was active when Set Scene was opened) is the
// only record of it anywhere, and is what pre-fills the box here.
class SetSceneModal extends Modal {
  private plugin: KindroidPlugin;
  private sceneKey: string;
  private isGroup: boolean;
  private onSent: (scene: string) => void | Promise<void>;

  constructor(
    app: App,
    plugin: KindroidPlugin,
    sceneKey: string,
    isGroup: boolean,
    onSent: (scene: string) => void | Promise<void>
  ) {
    super(app);
    this.plugin = plugin;
    this.sceneKey = sceneKey;
    this.isGroup = isGroup;
    this.onSent = onSent;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ka-scene-modal");
    // See the matching comment in PhoneBookModal — this is the modal
    // card's own dark theming, separate from (and in addition to) the
    // already-dark textarea/buttons inside it.
    this.modalEl.addClass("ka-kindroid-modal");

    contentEl.createEl("h2", { text: "Set Scene" });
    contentEl.createEl("p", {
      text: "Sets the scene for this conversation, for example: location, attire, activity, time, etc.",
      cls: "setting-item-description",
    });

    const existing = this.plugin.settings.sceneBook[this.sceneKey] ?? "";

    const textarea = contentEl.createEl("textarea", {
      cls: "ka-scene-textarea",
      attr: { maxlength: String(SET_SCENE_MAX_LENGTH), rows: "3" },
    });
    textarea.value = existing;

    const counter = contentEl.createDiv("ka-scene-counter");
    const errorEl = contentEl.createDiv("ka-scene-error");

    const updateCounter = () => {
      const remaining = SET_SCENE_MAX_LENGTH - textarea.value.length;
      counter.setText(`${remaining} characters remaining`);
    };

    const btnRow = contentEl.createDiv("ka-btn-row");

    // Quick-fill presets — defined per-icon in Settings → Set Scene
    // Presets (SCENE_PRESET_ICONS is the shared list). Pressing one
    // overwrites whatever's currently typed, same as any other preset
    // button. Still styled to blend into the background at rest
    // (.ka-scene-icon-btn) — functional now, but not shouting about it.
    const iconRow = btnRow.createDiv("ka-scene-icon-row");
    for (const { key, label, primary, fallback } of SCENE_PRESET_ICONS) {
      const iconBtn = iconRow.createEl("button", {
        cls: "ka-scene-icon-btn",
        attr: { type: "button", title: label },
      });
      setIconOrFallback(iconBtn, [primary, fallback, "square"]);
      iconBtn.addEventListener("click", () => {
        textarea.value = (this.plugin.settings.scenePresets[key] ?? "").slice(
          0,
          SET_SCENE_MAX_LENGTH
        );
        updateCounter();
        errorEl.setText("");
        textarea.focus();
      });
    }

    const sendBtn = btnRow.createEl("button", {
      cls: "ka-btn ka-btn-primary",
      text: "Send",
    });

    textarea.addEventListener("input", () => {
      updateCounter();
      errorEl.setText("");
    });

    updateCounter();
    textarea.focus();

    // Send is always available, including with the box empty — sending
    // blank is the deliberate way to clear current_scene server-side,
    // not an accident to guard against.
    sendBtn.addEventListener("click", async () => {
      const scene = textarea.value.trim();

      sendBtn.disabled = true;
      sendBtn.setText("Sending…");
      errorEl.setText("");

      try {
        const apiKey = this.plugin.getApiKey();
        const url = this.isGroup
          ? "https://api.kindroid.ai/v1/groupchats-update"
          : "https://api.kindroid.ai/v1/update-info";
        const body = this.isGroup
          ? { group_id: this.sceneKey, current_scene: scene }
          : { ai_id: this.sceneKey, current_scene: scene };

        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) throw new Error(`Server returned ${res.status}`);

        // Close first, then hand the saved scene back to the view —
        // onSent persists it to sceneBook and posts the chat-log
        // confirmation, same as every other action here (Chat Break
        // included).
        this.close();
        await this.onSent(scene);
      } catch (err: any) {
        errorEl.setText(`⚠️ Could not set scene: ${err.message}`);
        sendBtn.disabled = false;
        sendBtn.setText("Send");
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class KindroidSettingTab extends PluginSettingTab {
  plugin: KindroidPlugin;
  // How many of the 10 AI/Group slots are currently shown, before the
  // rest are revealed by "+". Not persisted — recomputed each time this
  // tab opens, from however many are already filled in.
  private visibleAiSlots = 1;
  private visibleGroupSlots = 1;
  // Whether the Main Chat / Group Chat lists are expanded. Lives on the
  // tab instance (not settings) so it resets to open on a fresh Settings
  // visit, but survives a re-render caused by clicking "+" within the
  // same visit — display() is only re-run for a handful of actions, so
  // this doesn't get reset by ordinary typing in the fields.
  private mainChatExpanded = true;
  private groupChatExpanded = true;

  constructor(app: App, plugin: KindroidPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Kindroid Assistant" });

    // API Key — stored via Obsidian's SecretStorage (device-local,
    // outside the vault, never synced or written to data.json), not as
    // plain text. Settings only holds the secret's ID, resolved to the
    // real value at request time by KindroidPlugin.getApiKey().
    if ((this.app as any).secretStorage) {
      new Setting(containerEl)
        .setName("API Key")
        .setDesc(
          "Your Kindroid API key — starts with kn_... (Kindroid → General Settings). " +
          "Stored in Obsidian's own secret storage, not in this plugin's data file."
        )
        .addComponent((el) =>
          new SecretComponent(this.app, el)
            .setValue(this.plugin.settings.apiKeySecretId)
            .onChange(async (value: string) => {
              this.plugin.settings.apiKeySecretId = value;
              await this.plugin.saveSettings();
            })
        );
    } else {
      // Obsidian predates secret storage (pre-1.11.4) — fall back to a
      // plain field rather than leave the person with no way to set a
      // key at all. getApiKey() reads this when no secret is resolved.
      new Setting(containerEl)
        .setName("API Key")
        .setDesc(
          "Your Kindroid API key — starts with kn_... (Kindroid → General Settings). " +
          "Your Obsidian version is too old for secret storage, so this is stored as plain " +
          "text in this plugin's settings file — updating Obsidian would let this move to " +
          "secure storage instead."
        )
        .addText((t) =>
          t
            .setPlaceholder("kn_...")
            .setValue(this.plugin.settings.apiKey)
            .onChange(async (v) => {
              this.plugin.settings.apiKey = v.trim();
              await this.plugin.saveSettings();
            })
        );
    }

    // Hot-swap slots — up to 10 AIs (1:1) and up to 10 groups, switchable
    // from the dropdown in the panel header without coming back here.
    // Both lists show one blank row beyond however many are already
    // filled, so the page doesn't open cluttered with 10 empty boxes —
    // "+" reveals another, up to the cap. Each list also sits inside a
    // collapsible <details> section (native, so it needs no extra
    // library) so the settings page doesn't read as "soup" once several
    // companions/groups are saved.
    const filledAi = this.plugin.settings.aiSlots.filter((s) => s.name.trim() || s.id.trim()).length;
    // Never shrink back down after a "+" click just because the new
    // row is still empty — only grow to match filled count or a "+".
    this.visibleAiSlots = Math.min(10, Math.max(1, filledAi + 1, this.visibleAiSlots));

    const mainDetails = containerEl.createEl("details", { cls: "ka-settings-collapsible" });
    if (this.mainChatExpanded) mainDetails.setAttribute("open", "");
    mainDetails.addEventListener("toggle", () => {
      this.mainChatExpanded = mainDetails.hasAttribute("open");
    });
    mainDetails.createEl("summary", { text: "Main Chat (up to 10)" });

    // Seeding Contacts from these fields runs on blur, not on every
    // keystroke — seedPhoneBookFromAiSlots() never overwrites a
    // Contacts entry that already has a value (so a name deliberately
    // set differently there is left alone), but on every keystroke
    // that rule means the very first character typed into a brand-new
    // Name field becomes that permanent value, since it's "non-empty"
    // from that point on. Waiting for blur means the full name is
    // already in aiSlots by the time seeding runs.
    const seedOnBlur = (t: { inputEl: HTMLInputElement }) => {
      t.inputEl.addEventListener("blur", () => {
        if (this.plugin.seedPhoneBookFromAiSlots()) {
          void this.plugin.saveSettings();
        }
      });
    };

    for (let i = 0; i < this.visibleAiSlots; i++) {
      const idx = i;
      new Setting(mainDetails)
        .setName(`${idx + 1}.`)
        .addText((t) => {
          t
            .setPlaceholder("Name")
            .setValue(this.plugin.settings.aiSlots[idx].name)
            .onChange(async (v) => {
              this.plugin.settings.aiSlots[idx].name = v;
              this.plugin.applyActiveSlot();
              await this.plugin.saveSettings();
            });
          seedOnBlur(t);
        })
        .addText((t) => {
          t
            .setPlaceholder("AI ID")
            .setValue(this.plugin.settings.aiSlots[idx].id)
            .onChange(async (v) => {
              this.plugin.settings.aiSlots[idx].id = v.trim();
              this.plugin.applyActiveSlot();
              await this.plugin.saveSettings();
            });
          seedOnBlur(t);
        });
    }

    if (this.visibleAiSlots < 10) {
      new Setting(mainDetails).addButton((b) =>
        b.setButtonText("+ Add companion").onClick(() => {
          this.visibleAiSlots = Math.min(10, this.visibleAiSlots + 1);
          this.display();
        })
      );
    }

    const filledGroup = this.plugin.settings.groupSlots.filter((s) => s.name.trim() || s.id.trim()).length;
    this.visibleGroupSlots = Math.min(10, Math.max(1, filledGroup + 1, this.visibleGroupSlots));

    const groupDetails = containerEl.createEl("details", { cls: "ka-settings-collapsible" });
    if (this.groupChatExpanded) groupDetails.setAttribute("open", "");
    groupDetails.addEventListener("toggle", () => {
      this.groupChatExpanded = groupDetails.hasAttribute("open");
    });
    groupDetails.createEl("summary", { text: "Group Chat (up to 10)" });

    for (let i = 0; i < this.visibleGroupSlots; i++) {
      const idx = i;
      const row = new Setting(groupDetails)
        .setName(`${idx + 11}.`)
        .addText((t) =>
          t
            .setPlaceholder("Name")
            .setValue(this.plugin.settings.groupSlots[idx].name)
            .onChange(async (v) => {
              this.plugin.settings.groupSlots[idx].name = v;
              this.plugin.applyActiveSlot();
              await this.plugin.saveSettings();
            })
        );

      // "Single" checkbox, sitting between Name and Group Chat ID.
      // Unticked (default) = multi-companion, existing Poke behaviour
      // (groupchats-get-turn, then groupchats-ai-response for whoever
      // it names). Ticked = single-companion — reveals the AI ID field
      // below and makes Poke skip get-turn entirely, calling
      // groupchats-ai-response directly with that id. See pokeGroup().
      const singleLabel = row.controlEl.createEl("label", { cls: "ka-group-single-toggle" });
      const singleCheckbox = singleLabel.createEl("input", {
        attr: { type: "checkbox" },
      }) as HTMLInputElement;
      singleCheckbox.checked = this.plugin.settings.groupSlots[idx].companionMode === "single";
      singleLabel.createSpan({ text: "Single" });
      singleCheckbox.addEventListener("change", async () => {
        this.plugin.settings.groupSlots[idx].companionMode = singleCheckbox.checked ? "single" : "multi";
        await this.plugin.saveSettings();
        this.display();
      });

      row.addText((t) =>
        t
          .setPlaceholder("Group Chat ID")
          .setValue(this.plugin.settings.groupSlots[idx].id)
          .onChange(async (v) => {
            this.plugin.settings.groupSlots[idx].id = v.trim();
            this.plugin.applyActiveSlot();
            await this.plugin.saveSettings();
          })
      );

      if (this.plugin.settings.groupSlots[idx].companionMode === "single") {
        new Setting(groupDetails)
          .setName("Single-companion AI ID")
          .setDesc("That one companion's AI ID — nothing in the API exposes it otherwise.")
          .addText((t) =>
            t
              .setPlaceholder("AI ID")
              .setValue(this.plugin.settings.groupSlots[idx].singleCompanionId ?? "")
              .onChange(async (v) => {
                this.plugin.settings.groupSlots[idx].singleCompanionId = v.trim();
                await this.plugin.saveSettings();
              })
          );
      }
    }

    if (this.visibleGroupSlots < 10) {
      new Setting(groupDetails).addButton((b) =>
        b.setButtonText("+ Add group").onClick(() => {
          this.visibleGroupSlots = Math.min(10, this.visibleGroupSlots + 1);
          this.display();
        })
      );
    }

    // Max turns per group message — tested against the official
    // Kindroid web app's own typical range so this plugin's group
    // chats pace the same way theirs do, rather than running to a
    // much higher ceiling that was only ever a safety cap.
    containerEl.createEl("h3", { text: "Group Chat Max Turns" });
    new Setting(containerEl)
      .setName("Max turns per group message")
      .setDesc(
        "How many companions can speak in a row after you send a message in Group Chat, before the cursor " +
        "comes back to you. Kept to 1-5 to match what's typical in Kindroid's own web app."
      )
      .addSlider((s) =>
        s
          .setLimits(MIN_GROUP_TURNS, MAX_GROUP_TURNS_LIMIT, 1)
          .setValue(this.plugin.settings.maxGroupTurns)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxGroupTurns = v;
            await this.plugin.saveSettings();
          })
      );

    // Group Contacts — moved to its own popup (the phone icon next to
    // the panel's picker in the chat header), reachable without leaving
    // the chat, and so it doesn't grow this settings page unbounded as
    // more companions are learned. See PhoneBookModal.
    containerEl.createEl("h3", { text: "Contacts" });
    containerEl.createEl("p", {
      text:
        "Group companion names (Contacts) live in their own popup now — " +
        "click the phone icon next to the chat picker at the top of the Kindroid Assistant panel. " +
        "The Contact List is used to resolve the Display_Names of IDs found but not defined. " +
        "This will be used predominately for Group Chats, and later, in another build, chat history downloads.",
      cls: "setting-item-description",
    });

    // Set Scene Presets — one quick-fill phrase per icon shown at the
    // bottom of the Set Scene popup. Defined here; pressing the
    // matching icon there copies the text straight into the scene box.
    containerEl.createEl("h3", { text: "Set Scene Presets" });
    containerEl.createEl("p", {
      text:
        "Each icon below matches one of the five shown in the Set Scene popup. Whatever's typed " +
        "here is what pressing that icon copies into the scene box there — leave one blank and " +
        "its icon simply does nothing yet.",
      cls: "setting-item-description",
    });
    for (const { key, label, primary, fallback } of SCENE_PRESET_ICONS) {
      const setting = new Setting(containerEl)
        .setName(label)
        .addTextArea((t) => {
          t.inputEl.maxLength = SET_SCENE_MAX_LENGTH;
          t.inputEl.rows = 2;
          t
            .setPlaceholder("e.g. location, attire, activity, time, etc.")
            .setValue(this.plugin.settings.scenePresets[key] ?? "")
            .onChange(async (v) => {
              this.plugin.settings.scenePresets[key] = v.slice(0, SET_SCENE_MAX_LENGTH);
              await this.plugin.saveSettings();
            });
        });
      const iconEl = document.createElement("span");
      iconEl.addClass("ka-scene-preset-icon");
      setIconOrFallback(iconEl, [primary, fallback, "square"]);
      setting.nameEl.prepend(iconEl);
    }

    // Default Chat Break greeting
    containerEl.createEl("h3", { text: "Chat Break" });
    new Setting(containerEl)
      .setName("Default Chat Break greeting")
      .setDesc(
        "Chat Break sends whatever's typed in the message box as the greeting. " +
        "This is the fallback used only when the box is left empty."
      )
      .addTextArea((t) =>
        t
          .setPlaceholder("Hello! I'm ready to help…")
          .setValue(this.plugin.settings.greeting)
          .onChange(async (v) => {
            this.plugin.settings.greeting = v;
            await this.plugin.saveSettings();
          })
      );

    // Poke button lines
    containerEl.createEl("h3", { text: "Poke Button (👆)" });
    containerEl.createEl("p", {
      text:
        "In Single AI mode there's no way to nudge for a reply without sending a msg, " +
        "so the poke button sends one of these three lines at random. " +
        "Not used in Group Chat mode — there, poke continues the conversation without sending a msg, " +
        'much like the "Continue Conversation" button in the Kindroid Client.',
      cls: "setting-item-description",
    });

    const pokeLineNames = ["Poke line 1", "Poke line 2", "Poke line 3"];
    for (let i = 0; i < 3; i++) {
      const idx = i;
      new Setting(containerEl)
        .setName(pokeLineNames[idx])
        .addText((t) =>
          t
            .setPlaceholder(DEFAULT_SETTINGS.pokeLines[idx])
            .setValue(this.plugin.settings.pokeLines[idx])
            .onChange(async (v) => {
              this.plugin.settings.pokeLines[idx] = v;
              await this.plugin.saveSettings();
            })
        );
    }

    // Display names
    containerEl.createEl("h3", { text: "Display Names" });
    containerEl.createEl("p", {
      text:
        "The assistant's own label now comes from whichever AI is active in the picker — " +
        "set its name against slot 1–10 above, not here.",
      cls: "setting-item-description",
    });

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

    new Setting(containerEl)
      .setName("Startup greeting")
      .setDesc("The one-time welcome message shown when the chat panel first opens with nothing in it yet.")
      .addTextArea((t) => {
        t.setPlaceholder(DEFAULT_SETTINGS.startupGreeting)
          .setValue(this.plugin.settings.startupGreeting)
          .onChange(async (v) => {
            this.plugin.settings.startupGreeting = v.trim() || DEFAULT_SETTINGS.startupGreeting;
            await this.plugin.saveSettings();
          });
        t.inputEl.rows = 3;
      });

    // Text-to-Speech — below Appearance, above Microphone/Dictation.
    // Themes (when built) will slot in under Appearance, above this.
    containerEl.createEl("h3", { text: "Text-to-Speech" });

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

    voiceSetting.addButton((b) =>
      b.setButtonText("Test Voice").onClick(() => {
        speakText("Hello, I am your Kindroid assistant.", this.plugin.settings.selectedVoice);
      })
    );

    // Microphone mode — the mode dropdown is paused along with dictation
    // itself (see showDictationHelp() in the view); left commented here
    // rather than deleted, so it's easy to bring back once a replacement
    // is in place.
    containerEl.createEl("h3", { text: "Microphone / Dictation" });

    new Setting(containerEl)
      .setName("Dictation (paused)")
      .setDesc(
        "The microphone button is paused for now and doubles as a help button (click it for details). " +
        "Win+H may still work outside the plugin on Windows 11 or newer; a reliable, built-in replacement is being researched."
      );

    // new Setting(containerEl)
    //   .setName("Microphone button mode")
    //   .setDesc(
    //     "Native: attempts to use the browser built-in speech recognition. " +
    //     "This works on some systems (Linux, Mac) but is blocked by Obsidian on Windows. " +
    //     "If it fails, the button falls back to the tooltip automatically. " +
    //     "Tooltip: the mic button shows a reminder to use Win+H (Windows 10+). " +
    //     "Win+H will not work on older Windows, Linux, or Mac. " +
    //     "Those on other systems are welcome to fork this plugin and implement a working alternative."
    //   )
    //   .addDropdown((d) =>
    //     d
    //       .addOption("tooltip", "Tooltip — Win+H reminder (recommended for Windows)")
    //       .addOption("native", "Native — may work on Linux / Mac (untested)")
    //       .setValue(this.plugin.settings.micMode)
    //       .onChange(async (v: string) => {
    //         this.plugin.settings.micMode = v as "native" | "tooltip";
    //         await this.plugin.saveSettings();
    //       })
    //   );
  }
}

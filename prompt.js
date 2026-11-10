// "Share prompt" on the website: article links collected from any topic, copied to the clipboard.
// Kept only in this browser's localStorage (one entry per signed-in account). Nothing is sent to
// the backend or Firestore, and it is not shared with the Android app.
import { h, icon, toast } from "./dom.js";

export const MAX_ITEMS = 50;
export const DEFAULT_INTRO = "Hi, please go through the content in the following news articles and tell me the crux.";
const KEY_PREFIX = "tp_prompt_";
const GOOGLE_NEWS = /^https?:\/\/news\.google\.com\//i;

const state = { intro: DEFAULT_INTRO, items: [], shown: null };
const wrap = document.getElementById("prompt-fab");
const copyBtn = document.getElementById("prompt-copy");
const editBtn = document.getElementById("prompt-edit");
const countEl = document.getElementById("prompt-count");
const labelEl = document.getElementById("prompt-label");
const dialog = document.getElementById("dialog");
let storageKey = null;
let refreshDialog = null;

export const articles = (n) => (n === 1 ? "1 article" : `${n} articles`);

function parse(raw) {
  const p = { intro: DEFAULT_INTRO, items: [] };
  if (raw && typeof raw === "object") {
    if (typeof raw.intro === "string") p.intro = raw.intro;
    if (Array.isArray(raw.items)) p.items = raw.items.filter((e) => e && typeof e.url === "string" && e.url).slice(0, MAX_ITEMS);
  }
  return p;
}

function load() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(storageKey) || "null"); } catch { raw = null; }
  const p = parse(raw);
  state.intro = p.intro;
  state.items = p.items;
}

function save() {
  if (!storageKey) return;
  const data = { intro: state.intro.slice(0, 1000), items: state.items };
  try {
    if (state.items.length || state.intro !== DEFAULT_INTRO) localStorage.setItem(storageKey, JSON.stringify(data));
    else localStorage.removeItem(storageKey);
  } catch {
    toast("Could not save the prompt in this browser.");
  }
}

function changed() {
  save();
  render();
  if (refreshDialog) refreshDialog();
}

/** Intro, a blank line, then one link per line (the format the user pastes into a chat). */
export function promptText(p = state) {
  const intro = (p.intro || "").trim() || DEFAULT_INTRO;
  return `${intro}\n\n${p.items.map((e) => e.url).join("\n")}`.trim();
}

export function watchPrompt(uid) {
  storageKey = KEY_PREFIX + uid;
  state.shown = null;
  load();
  render();
}

export function stopPrompt() {
  storageKey = null;
  state.intro = DEFAULT_INTRO;
  state.items = [];
  state.shown = null;
  render();
}

/** Called on an explicit sign-out: the prompt does not outlive the session, as on Android. */
export function forgetPrompt() {
  if (storageKey) {
    try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
  }
  stopPrompt();
}

// Another tab of the site changed the prompt.
window.addEventListener("storage", (e) => {
  if (!storageKey || e.key !== storageKey) return;
  load();
  render();
  if (refreshDialog) refreshDialog();
});

function render() {
  const n = state.shown ?? state.items.length;
  wrap.hidden = n === 0 && state.shown === null;
  countEl.textContent = String(n);
  copyBtn.setAttribute("aria-label", `Copy prompt with ${articles(n)}`);
}

function addEntries(p, entries) {
  const have = new Set(p.items.map((e) => e.url));
  let added = 0;
  for (const e of entries) {
    if (p.items.length >= MAX_ITEMS) break;
    if (!e.url || have.has(e.url)) continue;
    have.add(e.url);
    p.items.push(e);
    added += 1;
  }
  return added;
}

export function clearPrompt() {
  state.items = [];
  changed();
}

function removeUrl(url) {
  state.items = state.items.filter((e) => e.url !== url);
  changed();
}

function setIntro(text) {
  state.intro = text;
  changed();
}

/**
 * Feed items whose Google News link the Android app has since resolved carry the old link in
 * gn_url. Swap those links in the prompt for the publisher's link.
 */
export function updatePromptLinks(items) {
  if (!storageKey || !state.items.length) return;
  const map = new Map();
  for (const it of items) {
    if (it && typeof it.gn_url === "string" && typeof it.url === "string" && it.url !== it.gn_url && !GOOGLE_NEWS.test(it.url)) {
      map.set(it.gn_url, it.url);
    }
  }
  if (!map.size) return;
  const have = new Set(state.items.map((e) => e.url));
  let swapped = false;
  state.items = state.items.flatMap((e) => {
    const to = map.get(e.url);
    if (!to) return [e];
    swapped = true;
    if (have.has(to)) return [];  // the original link is already in the prompt
    have.add(to);
    return [{ ...e, url: to }];
  });
  if (swapped) changed();
}

// ---- add, with the "collect" animation ---------------------------------------------------

/**
 * entries: [{url, title, source, topic_id, item_id, added_at}]
 * ghosts : elements (already positioned) that fly into the Copy prompt button
 */
export async function addToPrompt(entries, ghosts) {
  const have = new Set(state.items.map((e) => e.url));
  const fresh = entries.filter((e) => e.url && !have.has(e.url));
  const adding = fresh.slice(0, Math.max(0, MAX_ITEMS - state.items.length));
  if (!adding.length) {
    ghosts.forEach((g) => g.remove());
    toast(fresh.length ? `The prompt holds up to ${MAX_ITEMS} articles. Remove some first.`
      : "Those articles are already in the prompt.");
    return;
  }
  const keep = new Set(adding.map((e) => e.url));
  const flying = ghosts.filter((g) => keep.has(g.dataset.url));
  ghosts.filter((g) => !keep.has(g.dataset.url)).forEach((g) => g.remove());

  // Saved straight away; the count climbs as each thumbnail lands.
  const before = state.items.length;
  const added = addEntries(state, adding);
  save();
  if (refreshDialog) refreshDialog();
  state.shown = before;
  render();
  await fly(flying, () => { state.shown = Math.min(state.shown + 1, state.items.length); render(); });
  state.shown = null;
  render();
  if (added) toast(`Added ${articles(added)}. Click Copy prompt when you're ready.`);
}

/** A small copy of a tile's thumbnail at the tile's position, ready to fly. */
export function makeGhost(tile, url) {
  const src = tile.querySelector(".thumb") || tile;
  const r = src.getBoundingClientRect();
  const ghost = src.tagName === "IMG"
    ? h("img", { src: src.currentSrc || src.src, alt: "", referrerpolicy: "no-referrer" })
    : h("div", { class: "ghost-box" }, icon(tile.dataset.kind || "article"));
  ghost.classList.add("fly-ghost");
  ghost.dataset.url = url;
  Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  document.body.append(ghost);
  return ghost;
}

function fly(ghosts, onLand) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const t = copyBtn.getBoundingClientRect();
  const tx = t.left + t.width / 2;
  const ty = t.top + t.height / 2;
  const animations = ghosts.slice(0, 15).map((g, i) => {
    const r = g.getBoundingClientRect();
    const dx = tx - (r.left + r.width / 2);
    const dy = ty - (r.top + r.height / 2);
    const a = g.animate([
      { transform: "translate(0, 0) scale(1)", opacity: 1 },
      { transform: `translate(${dx * 0.55}px, ${dy * 0.55 - 70}px) scale(0.55)`, opacity: 0.95, offset: 0.55 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.08)`, opacity: 0.3 },
    ], { duration: reduce ? 1 : 700, delay: reduce ? 0 : i * 80, easing: "cubic-bezier(.45,0,.35,1)", fill: "forwards" });
    return a.finished.then(() => {
      g.remove();
      onLand();
      if (!reduce) copyBtn.animate([{ transform: "scale(1)" }, { transform: "scale(1.14)" }, { transform: "scale(1)" }], { duration: 220 });
    }).catch(() => g.remove());
  });
  ghosts.slice(15).forEach((g) => g.remove());
  return Promise.all(animations);
}

// ---- copy and review ----------------------------------------------------------------------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { style: "position:fixed;opacity:0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

async function copyPrompt(text = promptText()) {
  if (!state.items.length) return;
  if (!(await copyText(text))) {
    toast("Could not copy. Open the review (✎) and copy the text by hand.");
    return;
  }
  labelEl.textContent = "Copied";
  copyBtn.classList.add("copied");
  setTimeout(() => { labelEl.textContent = "Copy prompt"; copyBtn.classList.remove("copied"); }, 2000);
  toast(`Prompt with ${articles(state.items.length)} copied. Paste it into ChatGPT, Claude or any chat.`,
    { label: "Clear prompt", fn: clearPrompt });
}

function openReview() {
  const intro = h("textarea", { rows: "3", maxlength: "1000", "aria-label": "Your message" });
  intro.value = state.intro;
  let introChanged = false;
  intro.addEventListener("input", () => { introChanged = true; });
  const saveIntro = () => {
    if (!introChanged) return;
    introChanged = false;
    setIntro(intro.value);
  };
  intro.addEventListener("change", saveIntro);
  const count = h("h3", { class: "review-count" });
  const list = h("ul", { class: "review-list" });
  const fill = () => {
    count.textContent = articles(state.items.length);
    list.replaceChildren(...state.items.map((e) => {
      const remove = h("button", { class: "btn small", type: "button", title: "Remove from prompt", "aria-label": "Remove from prompt" }, icon("close"));
      remove.addEventListener("click", () => removeUrl(e.url));
      return h("li", {},
        h("div", { class: "review-text" }, h("div", { text: e.title || e.url }), h("div", { class: "small muted", text: e.source || "" })),
        remove);
    }));
    if (!state.items.length && dialog.open) dialog.close();
  };
  const clear = h("button", { class: "btn danger", type: "button" }, "Clear all");
  const close = h("button", { class: "btn", type: "button" }, "Close");
  const copy = h("button", { class: "btn primary", type: "button" }, "Copy prompt");
  clear.addEventListener("click", () => { clearPrompt(); dialog.close(); });
  close.addEventListener("click", () => dialog.close());
  copy.addEventListener("click", () => {
    // Copy first: browsers only allow clipboard writes right after the click.
    const text = promptText({ intro: intro.value, items: state.items });
    copyPrompt(text);
    saveIntro();
    dialog.close();
  });
  dialog.replaceChildren(h("div", { class: "dialog-body" },
    h("h2", { text: "Prompt" }),
    h("p", { class: "small muted", text: "Copied as your message followed by one link per line. Saved only in this browser." }),
    intro, count, list,
    h("div", { class: "actions" }, clear, h("span", { class: "spacer" }), close, copy)));
  refreshDialog = fill;
  dialog.addEventListener("close", () => { refreshDialog = null; saveIntro(); }, { once: true });
  fill();
  dialog.showModal();
}

copyBtn.addEventListener("click", () => copyPrompt());
editBtn.addEventListener("click", openReview);

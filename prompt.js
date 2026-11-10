// "Share prompt" on the website: article links collected from any topic, copied to the clipboard.
// Stored in users/{uid}.prompt, the same place the Android app uses, so both stay in sync.
import { auth, db, doc, onSnapshot, runTransaction, serverTimestamp } from "./firebase.js";
import { h, icon, toast } from "./dom.js";

export const MAX_ITEMS = 50;
export const DEFAULT_INTRO = "Hi, please go through the content in the following news articles and tell me the crux.";

const state = { intro: DEFAULT_INTRO, items: [], shown: null };
const wrap = document.getElementById("prompt-fab");
const copyBtn = document.getElementById("prompt-copy");
const editBtn = document.getElementById("prompt-edit");
const countEl = document.getElementById("prompt-count");
const labelEl = document.getElementById("prompt-label");
const dialog = document.getElementById("dialog");
let unsub = null;
let refreshDialog = null;

export const articles = (n) => (n === 1 ? "1 article" : `${n} articles`);

function parse(raw) {
  const p = { intro: DEFAULT_INTRO, items: [] };
  if (raw && typeof raw === "object") {
    if (typeof raw.intro === "string") p.intro = raw.intro;
    if (Array.isArray(raw.items)) p.items = raw.items.filter((e) => e && typeof e.url === "string" && e.url);
  }
  return p;
}

/** Intro, a blank line, then one link per line (the format the user pastes into a chat). */
export function promptText(p = state) {
  const intro = (p.intro || "").trim() || DEFAULT_INTRO;
  return `${intro}\n\n${p.items.map((e) => e.url).join("\n")}`.trim();
}

export function watchPrompt(uid) {
  stopPrompt();
  unsub = onSnapshot(doc(db, "users", uid), (snap) => {
    const p = parse(snap.exists() ? snap.data().prompt : null);
    state.intro = p.intro;
    state.items = p.items;
    render();
    if (refreshDialog) refreshDialog();
  }, () => { /* signed out */ });
}

export function stopPrompt() {
  if (unsub) unsub();
  unsub = null;
  state.items = [];
  state.shown = null;
  render();
}

function render() {
  const n = state.shown ?? state.items.length;
  wrap.hidden = n === 0 && state.shown === null;
  countEl.textContent = String(n);
  copyBtn.setAttribute("aria-label", `Copy prompt with ${articles(n)}`);
}

function mutate(change) {
  const ref = doc(db, "users", auth.currentUser.uid);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const p = parse(snap.exists() ? snap.data().prompt : null);
    const result = change(p);
    tx.update(ref, { prompt: { intro: p.intro.slice(0, 1000), items: p.items }, updated_at: serverTimestamp() });
    return result;
  });
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

export const clearPrompt = () => mutate((p) => { p.items = []; }).catch(() => toast("Could not clear the prompt."));
const removeUrl = (url) => mutate((p) => { p.items = p.items.filter((e) => e.url !== url); });
const setIntro = (text) => mutate((p) => { p.intro = text; });

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

  state.shown = state.items.length;
  render();
  const write = mutate((p) => addEntries(p, adding));
  await fly(flying, () => { state.shown += 1; render(); });
  let added = 0;
  try {
    added = await write;
    addEntries(state, adding);  // the snapshot listener confirms shortly
  } catch {
    toast("Could not add to the prompt. Check your connection.");
  }
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
  const saveIntro = async () => {
    if (!introChanged) return;
    introChanged = false;
    try { await setIntro(intro.value); } catch { toast("Could not save your message."); }
  };
  intro.addEventListener("change", saveIntro);
  const count = h("h3", { class: "review-count" });
  const list = h("ul", { class: "review-list" });
  const fill = () => {
    count.textContent = articles(state.items.length);
    list.replaceChildren(...state.items.map((e) => {
      const remove = h("button", { class: "btn small", type: "button", title: "Remove from prompt", "aria-label": "Remove from prompt" }, icon("close"));
      remove.addEventListener("click", () => removeUrl(e.url).catch(() => toast("Could not remove.")));
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
    h("p", { class: "small muted", text: "Copied as your message followed by one link per line. Synced with the Android app." }),
    intro, count, list,
    h("div", { class: "actions" }, clear, h("span", { class: "spacer" }), close, copy)));
  refreshDialog = fill;
  dialog.addEventListener("close", () => { refreshDialog = null; saveIntro(); }, { once: true });
  fill();
  dialog.showModal();
}

copyBtn.addEventListener("click", () => copyPrompt());
editBtn.addEventListener("click", openReview);

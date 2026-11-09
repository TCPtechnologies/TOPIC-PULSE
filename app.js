// Topic Pulse website: same topics, feeds and settings as the Android app (no notifications).
import {
  auth, db, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
  doc, collection, query, orderBy, limit, startAfter, onSnapshot, getDoc, getDocs,
  setDoc, updateDoc, serverTimestamp,
} from "./firebase.js";
import { Api, service } from "./api.js";
import { h, safeUrl, relative, dateTime, toast, icon } from "./dom.js";

const PAGE = 30;
const main = document.getElementById("main");
const banner = document.getElementById("banner");
const nav = document.getElementById("nav");
const dialog = document.getElementById("dialog");
let cleanups = [];
let statusUnsub = null;

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata";

function clearView() {
  cleanups.forEach((fn) => { try { fn(); } catch { /* listener already gone */ } });
  cleanups = [];
  main.replaceChildren();
  main.setAttribute("data-started", "1");
  document.title = "Topic Pulse";
}

// ---- sign-in ----------------------------------------------------------------------

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    if (statusUnsub) { statusUnsub(); statusUnsub = null; }
    showLogin();
    return;
  }
  try { await ensureUserDoc(user); } catch (e) { console.warn("user doc", e); }
  watchStatus();
  renderNav(user);
  route();
});

async function ensureUserDoc(user) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await updateDoc(ref, { email: user.email, display_name: user.displayName, updated_at: serverTimestamp() });
    return;
  }
  await setDoc(ref, {
    email: user.email,
    display_name: user.displayName,
    settings: { quiet_enabled: false, quiet_start: "22:00", quiet_end: "07:00", timezone: tz() },
    fcm_tokens: [],
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  });
}

function showLogin() {
  clearView();
  nav.replaceChildren();
  banner.hidden = true;
  const error = h("p", { class: "error", hidden: true });
  const button = h("button", { class: "btn primary big", type: "button" }, "Sign in with Google");
  button.addEventListener("click", async () => {
    button.disabled = true;
    error.hidden = true;
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) {
      if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
        error.textContent = `Sign-in failed (${e.code || e.message}). If a popup blocker is on, allow popups for this site.`;
        error.hidden = false;
      }
    } finally {
      button.disabled = false;
    }
  });
  main.append(h("section", { class: "login" },
    icon("pulse", "logo"),
    h("h1", { text: "Topic Pulse" }),
    h("p", { class: "muted", text: "Only the news that moves your topics." }),
    button, error,
    h("p", { class: "small muted", text: "Use the same Google account as in the Android app. Notifications are sent to the Android app; the website shows the same topics and feeds." })));
}

function renderNav(user) {
  nav.replaceChildren(
    h("a", { href: "#/", text: "Topics" }),
    h("a", { href: "#/settings", text: "Settings" }),
    h("span", { class: "who", text: user.email || "" }));
}

// ---- free-tier pause state ----------------------------------------------------------

function watchStatus() {
  if (statusUnsub) return;
  statusUnsub = onSnapshot(doc(db, "system", "status"), (snap) => {
    const s = snap.exists() ? snap.data() : {};
    service.paused = Boolean(s.paused);
    document.body.classList.toggle("paused", service.paused);
    if (!service.paused) { banner.hidden = true; return; }
    const resume = s.resume_at && s.resume_at.toDate ? s.resume_at.toDate() : null;
    banner.textContent = `Free tier over${s.reason ? `: ${s.reason}` : ""}. ` + (resume
      ? `Topic Pulse resumes automatically on ${dateTime(resume)}.`
      : "Topic Pulse is stopped until the service is restarted.");
    banner.hidden = false;
  }, () => { /* not signed in yet */ });
}

// ---- routing --------------------------------------------------------------------------

window.addEventListener("hashchange", route);

function route() {
  if (!auth.currentUser) return;
  if (dialog.open) dialog.close();
  clearView();
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "topic" && parts[1]) {
    if (parts[2] === "settings") renderTopicSettings(parts[1]);
    else renderFeed(parts[1]);
  } else if (parts[0] === "settings") {
    renderSettings();
  } else {
    renderTopics();
  }
  window.scrollTo(0, 0);
}

const topicHref = (id, suffix = "") => `#/topic/${encodeURIComponent(id)}${suffix}`;

// ---- topics list + add topic ------------------------------------------------------------

function statusLabel(status, mode) {
  if (status === "preparing" || status === "backfilling") return "Setting up…";
  if (status === "error") return "Setup failed";
  if (mode === "digest") return "Daily digest";
  if (mode === "off") return "Notifications off";
  return "Instant alerts";
}

function renderTopics() {
  const input = h("input", { type: "text", maxlength: "300", placeholder: "Add a topic, e.g. Gold prices", "aria-label": "New topic" });
  const add = h("button", { class: "btn primary needs-api", type: "submit" }, "Add");
  const progress = h("div", { class: "bar", hidden: true });
  const setBusy = (busy) => { add.disabled = busy; input.disabled = busy; progress.hidden = !busy; };
  const form = h("form", { class: "add-topic" }, input, add);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (text.length < 2) { toast("Type at least 2 characters."); return; }
    setBusy(true);
    try {
      const res = await Api.interpret(text);
      setBusy(false);
      showInterpretations(text, res, () => { input.value = ""; });
    } catch (err) {
      setBusy(false);
      toast(err.message);
    }
  });
  const list = h("div", { class: "topic-list" });
  const empty = h("p", { class: "muted empty", hidden: true, text: 'No topics yet. Type something you care about, like "Gold prices" or "Shahrukh Khan".' });
  main.append(h("h1", { text: "Topics" }), form, progress, empty, list);

  const uid = auth.currentUser.uid;
  cleanups.push(onSnapshot(query(collection(db, "users", uid, "topics"), orderBy("created_at", "desc")), (snap) => {
    list.replaceChildren(...snap.docs.map((d) => {
      const t = d.data();
      return h("a", { class: "card topic", href: topicHref(d.id) },
        h("div", { class: "topic-title", text: t.title || t.text || "Topic" }),
        h("div", { class: "muted", text: (t.statements || [])[0] || "" }),
        h("span", { class: "chip", text: statusLabel(t.status, t.notification_mode) }));
    }));
    empty.hidden = !snap.empty;
  }, (e) => toast(`Could not load topics (${e.code}).`)));
}

/** Show what the backend understood before creating the topic (one to six interpretations). */
function showInterpretations(text, res, onStart) {
  const items = (res.interpretations || []).filter((i) => i && i.statement);
  const choose = Boolean(res.needs_choice) && items.length > 1;
  const boxes = [];
  const body = [];
  let custom;
  if (choose) {
    body.push(h("p", { text: `"${text}" can mean different things. Pick one or more:` }));
    items.forEach((it, i) => {
      const cb = h("input", { type: "checkbox", checked: i === 0 });
      boxes.push([cb, it.statement]);
      body.push(h("label", { class: "option" }, cb, h("span", {}, h("strong", { text: it.label }), h("br"), it.statement)));
    });
    custom = h("textarea", { rows: "2", maxlength: "220", placeholder: "Something else (optional)" });
  } else {
    body.push(h("p", { text: "Check this, edit it if needed, then start." }));
    custom = h("textarea", { rows: "3", maxlength: "220" });
    custom.value = items[0] ? items[0].statement : `I want to be informed about ${text}`;
  }
  body.push(custom);
  const cancel = h("button", { class: "btn", type: "button" }, "Cancel");
  const start = h("button", { class: "btn primary needs-api", type: "button" }, "Start watching");
  cancel.addEventListener("click", () => dialog.close());
  start.addEventListener("click", () => {
    const chosen = boxes.filter(([cb]) => cb.checked).map(([, s]) => s);
    const extra = custom.value.trim();
    if (extra) chosen.push(extra);
    if (!chosen.length) { toast("Pick at least one option or write your own."); return; }
    dialog.close();
    onStart();
    createTopic(text, chosen);
  });
  dialog.replaceChildren(h("div", { class: "dialog-body" },
    h("h2", { text: choose ? "What should we watch?" : "We will watch for" }), ...body,
    h("div", { class: "actions" }, cancel, start)));
  dialog.showModal();
}

async function createTopic(text, statements) {
  toast(`Setting up "${text}". The last 24 hours of news will appear in about a minute.`);
  try {
    const res = await Api.createTopic(text, statements);
    if (res.status === "ready" && res.topic_id) location.hash = topicHref(res.topic_id);
    else if (res.status === "error") toast("Setup failed. Open the topic to retry.");
  } catch (e) {
    toast(e.message);
  }
}

// ---- feed --------------------------------------------------------------------------------

const TYPE = { analysis: "Analysis", event: "Event", data_release: "Data release" };
const HORIZON = { near: "Near term", mid: "Mid term", long: "Long term" };
const DIRECTION = { bullish: "Bullish", bearish: "Bearish", neutral: "Neutral" };

function feedTile(it) {
  const url = safeUrl(it.url);
  const thumb = safeUrl(it.thumbnail);
  const published = it.published_at && it.published_at.toDate ? it.published_at.toDate() : null;
  const kind = it.source_type === "video" ? "video" : "article";
  const chips = [it.is_update && "Update", TYPE[it.type], HORIZON[it.horizon], DIRECTION[it.direction]].filter(Boolean);
  const related = (it.related || []).filter((r) => r && safeUrl(r.url));
  const more = it.more_sources > 0
    ? h("details", { class: "related" },
      h("summary", { text: `+${it.more_sources} more source${it.more_sources === 1 ? "" : "s"}` }),
      h("ul", {}, related.map((r) => h("li", {},
        h("a", { href: safeUrl(r.url), target: "_blank", rel: "noopener noreferrer", text: `${r.source}: ${r.title}` })))))
    : null;
  const media = thumb
    ? h("img", { class: "thumb", src: thumb, alt: "", loading: "lazy", referrerpolicy: "no-referrer" })
    : h("div", { class: "thumb placeholder" }, icon(kind));
  if (thumb) media.addEventListener("error", () => media.replaceWith(h("div", { class: "thumb placeholder" }, icon(kind))));
  return h("article", { class: "card tile" },
    h("a", { class: "tile-main", href: url || "#", target: url ? "_blank" : null, rel: "noopener noreferrer" },
      media,
      h("div", { class: "tile-text" },
        h("h3", { text: it.title || "" }),
        h("div", { class: "meta" }, icon(kind), h("span", { text: `${it.source || ""} · ${relative(published)}` })))),
    chips.length ? h("div", { class: "chips" }, chips.map((c) => h("span", { class: c === "Update" ? "chip accent" : "chip", text: c }))) : null,
    it.why_it_matters ? h("p", { class: "why", text: it.why_it_matters }) : null,
    more);
}

function renderFeed(topicId) {
  const uid = auth.currentUser.uid;
  const title = h("h1", { text: "…" });
  const refresh = h("button", { class: "btn", type: "button" }, "Refresh");
  const settings = h("a", { class: "btn", href: topicHref(topicId, "/settings") }, "Topic settings");
  const loading = h("div", { class: "notice", hidden: true }, h("span", { class: "spinner" }), "Finding the last 24 hours of news and videos…");
  const errorText = h("span");
  const retry = h("button", { class: "btn needs-api", type: "button" }, "Retry");
  const errorBox = h("div", { class: "notice error-box", hidden: true }, errorText, retry);
  const empty = h("p", { class: "muted empty", hidden: true, text: "Nothing relevant in the last 24 hours yet. New items show up here, and as notifications on Android." });
  const list = h("div", { class: "feed" });
  const more = h("button", { class: "btn more", type: "button", hidden: true }, "Load more");
  main.append(
    h("div", { class: "feed-head" }, h("a", { href: "#/", class: "back", text: "← Topics" }), title,
      h("div", { class: "head-actions" }, refresh, settings)),
    loading, errorBox, empty, list, more);

  let status = "";
  let first = [];
  let older = [];
  let lastDoc = null;
  let noMore = false;
  const base = () => query(collection(db, "topics", topicId, "items"), orderBy("published_at", "desc"));

  const update = () => {
    const ids = new Set(first.map((d) => d.id));
    const all = first.concat(older.filter((d) => !ids.has(d.id)));
    list.replaceChildren(...all.map((d) => feedTile(d.data())));
    empty.hidden = !(all.length === 0 && status === "ready");
    more.hidden = noMore || !lastDoc;
  };

  cleanups.push(onSnapshot(doc(db, "users", uid, "topics", topicId), (snap) => {
    if (!snap.exists()) { title.textContent = "Topic not found"; return; }
    const t = snap.data();
    title.textContent = t.title || t.text || "Topic";
    document.title = `${title.textContent} · Topic Pulse`;
    status = t.status || "";
    loading.hidden = !(status === "preparing" || status === "backfilling");
    errorBox.hidden = status !== "error";
    errorText.textContent = t.error || "Setup failed.";
    update();
  }, (e) => toast(`Could not load the topic (${e.code}).`)));

  let unsubFirst = null;
  const listenFirst = () => {
    if (unsubFirst) unsubFirst();
    unsubFirst = onSnapshot(query(base(), limit(PAGE)), (snap) => {
      first = snap.docs;
      if (!older.length) {
        lastDoc = snap.docs[snap.docs.length - 1] || null;
        noMore = snap.docs.length < PAGE;
      }
      update();
    }, (e) => toast(`Could not load the feed (${e.code}).`));
  };
  cleanups.push(() => unsubFirst && unsubFirst());
  listenFirst();

  more.addEventListener("click", async () => {
    more.disabled = true;
    try {
      const snap = await getDocs(query(base(), startAfter(lastDoc), limit(PAGE)));
      older = older.concat(snap.docs);
      if (snap.docs.length) lastDoc = snap.docs[snap.docs.length - 1];
      noMore = snap.docs.length < PAGE;
      update();
    } catch (e) {
      toast(`Could not load more (${e.code || e.message}).`);
    } finally {
      more.disabled = false;
    }
  });
  refresh.addEventListener("click", () => { older = []; noMore = false; listenFirst(); toast("Feed refreshed."); });
  retry.addEventListener("click", async () => {
    errorBox.hidden = true;
    loading.hidden = false;
    try {
      await Api.retryTopic(topicId);
    } catch (e) {
      loading.hidden = true;
      errorBox.hidden = false;
      toast(e.message);
    }
  });
}

// ---- topic settings -------------------------------------------------------------------------

const SOURCE_TYPES = { youtube: ["YouTube channel", "video"], rss: ["Publisher feed", "article"], gnews: ["News search", "search"] };

function renderTopicSettings(topicId) {
  const uid = auth.currentUser.uid;
  const utRef = doc(db, "users", uid, "topics", topicId);
  const title = h("h1", { text: "Topic settings" });

  const modeInputs = {};
  const modeRows = [["instant", "Instant (relevance 65 and above)"], ["digest", "Daily digest"], ["off", "Off"]]
    .map(([value, label]) => {
      const radio = h("input", { type: "radio", name: "mode", value });
      modeInputs[value] = radio;
      return h("label", { class: "option" }, radio, h("span", { text: label }));
    });
  const digest = h("input", { type: "time", value: "20:00" });
  const digestRow = h("label", { class: "inline", hidden: true }, "Digest at ", digest);
  const currentMode = () => Object.keys(modeInputs).find((k) => modeInputs[k].checked) || "instant";
  const save = async () => {
    digestRow.hidden = currentMode() !== "digest";
    try {
      await updateDoc(utRef, { notification_mode: currentMode(), digest_time: digest.value || "20:00", timezone: tz(), updated_at: serverTimestamp() });
      toast("Saved.");
    } catch (e) {
      toast(`Could not save (${e.code || e.message}).`);
    }
  };
  Object.values(modeInputs).forEach((r) => r.addEventListener("change", save));
  digest.addEventListener("change", save);

  const sourceList = h("div", { class: "sources" });
  const addChannel = sourceForm("Add YouTube channel", "Channel name or channel URL", "add_youtube", topicId);
  const addQuery = sourceForm("Add news search", "Search words, e.g. gold ETF inflows", "add_query", topicId);
  const del = h("button", { class: "btn danger needs-api", type: "button" }, "Delete topic");
  del.addEventListener("click", async () => {
    if (!confirm(`Stop watching "${title.textContent}" and delete its feed?`)) return;
    try {
      await Api.deleteTopic(topicId);
      location.hash = "#/";
    } catch (e) {
      toast(e.message);
    }
  });

  main.append(
    h("a", { href: topicHref(topicId), class: "back", text: "← Feed" }), title,
    h("section", { class: "panel" }, h("h2", { text: "Notifications" }),
      h("p", { class: "small muted", text: "Notifications are delivered to the Android app." }), ...modeRows, digestRow),
    h("section", { class: "panel" }, h("h2", { text: "Sources" }),
      h("p", { class: "small muted", text: "News searches and YouTube channels this topic watches." }),
      sourceList, h("div", { class: "source-forms" }, addChannel, addQuery)),
    h("section", { class: "panel" }, del));

  cleanups.push(onSnapshot(utRef, (snap) => {
    if (!snap.exists()) return;
    const t = snap.data();
    title.textContent = t.title || t.text || "Topic settings";
    const mode = t.notification_mode || "instant";
    if (modeInputs[mode]) modeInputs[mode].checked = true;
    digest.value = t.digest_time || "20:00";
    digestRow.hidden = mode !== "digest";
  }));
  cleanups.push(onSnapshot(doc(db, "topics", topicId), (snap) => {
    if (!snap.exists()) return;
    const sources = snap.data().sources || [];
    sourceList.replaceChildren(...sources.map((s) => {
      const [label, kind] = SOURCE_TYPES[s.type] || ["Source", "article"];
      const toggle = h("input", { type: "checkbox", checked: s.enabled !== false, class: "needs-api", title: "Enabled" });
      toggle.addEventListener("change", () => editSource(topicId, { action: "toggle", source_id: s.id, enabled: toggle.checked }));
      const remove = h("button", { class: "btn small needs-api", type: "button" }, "Remove");
      remove.addEventListener("click", () => {
        if (confirm(`Remove source "${s.name}"?`)) editSource(topicId, { action: "remove", source_id: s.id });
      });
      return h("div", { class: "source" }, icon(kind),
        h("div", { class: "source-text" }, h("div", { text: s.name }), h("div", { class: "small muted", text: label })),
        h("label", { class: "switch" }, toggle, h("span", { text: "On" })), remove);
    }));
  }));
}

function sourceForm(label, placeholder, action, topicId) {
  const input = h("input", { type: "text", maxlength: "200", placeholder, "aria-label": label });
  const button = h("button", { class: "btn needs-api", type: "submit" }, label);
  const form = h("form", { class: "inline-form" }, input, button);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    button.disabled = true;
    if (await editSource(topicId, { action, value })) input.value = "";
    button.disabled = false;
  });
  return form;
}

async function editSource(topicId, body) {
  try {
    await Api.editSources(topicId, body);
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

// ---- app settings ----------------------------------------------------------------------------

function renderSettings() {
  const user = auth.currentUser;
  const userRef = doc(db, "users", user.uid);
  const quiet = h("input", { type: "checkbox" });
  const start = h("input", { type: "time", value: "22:00" });
  const end = h("input", { type: "time", value: "07:00" });
  const save = async () => {
    try {
      await updateDoc(userRef, {
        settings: { quiet_enabled: quiet.checked, quiet_start: start.value || "22:00", quiet_end: end.value || "07:00", timezone: tz() },
        updated_at: serverTimestamp(),
      });
      toast("Saved.");
    } catch (e) {
      toast(`Could not save (${e.code || e.message}).`);
    }
  };
  [quiet, start, end].forEach((el) => el.addEventListener("change", save));

  const serviceText = h("p", { text: "Running within the free tier." });
  const usageUpdated = h("p", { class: "small muted", text: "Usage by all users together. Each service stops being called before its free limit." });
  const usageTable = h("tbody");
  const out = h("button", { class: "btn", type: "button" }, "Sign out");
  out.addEventListener("click", () => signOut(auth));

  main.append(h("h1", { text: "Settings" }),
    h("section", { class: "panel" }, h("h2", { text: "Quiet hours" }),
      h("p", { class: "small muted", text: "No Android notifications during these hours. Alerts found meanwhile are sent together when quiet hours end." }),
      h("label", { class: "option" }, quiet, h("span", { text: "Enable quiet hours" })),
      h("div", { class: "row" }, h("label", { class: "inline" }, "From ", start), h("label", { class: "inline" }, "To ", end))),
    h("section", { class: "panel" }, h("h2", { text: "Service" }), serviceText),
    h("section", { class: "panel" }, h("h2", { text: "Free-tier usage" }), usageUpdated,
      h("table", { class: "usage" }, h("thead", {}, h("tr", {}, h("th", { text: "Service" }), h("th", { text: "Usage" }), h("th", { text: "State" }))), usageTable),
      h("p", { class: "small muted", text: "₹ marks services in the billed worker project. Everything else is in a project with no billing account." })),
    h("section", { class: "panel" }, h("h2", { text: "Account" }), h("p", { text: `Signed in as ${user.email}` }), out));

  cleanups.push(onSnapshot(userRef, (snap) => {
    const s = (snap.exists() && snap.data().settings) || {};
    quiet.checked = Boolean(s.quiet_enabled);
    start.value = s.quiet_start || "22:00";
    end.value = s.quiet_end || "07:00";
  }));
  cleanups.push(onSnapshot(doc(db, "system", "status"), (snap) => {
    const s = snap.exists() ? snap.data() : {};
    serviceText.textContent = s.paused ? `Paused: ${s.reason || "free tier limit reached"}.` : "Running within the free tier.";
  }));
  cleanups.push(onSnapshot(doc(db, "system", "usage"), (snap) => {
    if (!snap.exists()) return;
    const d = snap.data();
    if (d.updated_at && d.updated_at.toDate) {
      usageUpdated.textContent = `Usage by all users together, updated ${relative(d.updated_at.toDate())}. Each service stops being called before its free limit.`;
    }
    usageTable.replaceChildren(...(d.rows || []).map((r) => h("tr", { class: r.over ? "over" : "" },
      h("td", { text: `${r.billed ? "₹ " : ""}${r.name}` }),
      h("td", { text: r.text }),
      h("td", { text: r.over ? "stopped until reset" : "ok" }))));
  }));
}

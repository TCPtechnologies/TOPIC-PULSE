// Calls the Cloud Run backend with the user's Firebase ID token.
import { auth } from "./firebase.js";
import { API_BASE_URL } from "./config.js";

// Last known backend state (from system/status). While paused the website makes no API calls.
export const service = { paused: false };

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const PAUSED_MSG = "Free tier limit reached. Topic Pulse resumes automatically after the reset.";

export async function api(method, path, body) {
  if (service.paused) throw new ApiError(PAUSED_MSG, 503);
  const user = auth.currentUser;
  if (!user) throw new ApiError("Please sign in again.", 401);
  const token = await user.getIdToken();
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let resp;
  try {
    resp = await fetch(API_BASE_URL + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Network error. Check your connection and try again.", 0);
  }
  let data = {};
  try {
    data = await resp.json();
  } catch {
    data = {};
  }
  if (!resp.ok) {
    if (resp.status === 503 && data.error === "paused") throw new ApiError(PAUSED_MSG, 503);
    if (data.error && data.error !== "unauthorized") throw new ApiError(data.error, resp.status);
    if (resp.status === 401) throw new ApiError("Please sign in again.", 401);
    throw new ApiError(`Something went wrong (${resp.status}). Try again.`, resp.status);
  }
  return data;
}

export const Api = {
  interpret: (text) => api("POST", "/api/interpret", { text }),
  createTopic: (text, statements) => api("POST", "/api/topics", {
    text, statements, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }),
  retryTopic: (id) => api("POST", `/api/topics/${encodeURIComponent(id)}/retry`, {}),
  deleteTopic: (id) => api("DELETE", `/api/topics/${encodeURIComponent(id)}`),
  editSources: (id, body) => api("POST", `/api/topics/${encodeURIComponent(id)}/sources`, body),
};

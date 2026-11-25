import { config } from "./config";
import type { Appearance } from "./types";

export interface AdminTrack {
  id: number;
  filename: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
  sizeBytes: number | null;
  createdAt: string;
  onDisk: boolean;
  /** "upload" | "live" (a recorded show) | "folder" */
  source: string;
  onRepeat: boolean;
}

export interface AdminPlaylist {
  id: number;
  name: string;
  description: string | null;
  createdAt: string;
  trackCount?: number;
}

const TOKEN_KEY = "radio-jil:admin-token";

/** Session token lives in sessionStorage: gone when the tab closes. */
export const tokenStore = {
  get(): string | null {
    try {
      return window.sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string) {
    try {
      window.sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      // storage blocked: the session lasts until reload
    }
  },
  clear() {
    try {
      window.sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // ignore
    }
  },
};

export class AdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Multipart upload with progress (fetch can't report upload progress). */
function xhrUpload<T>(path: string, file: File, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${config.apiUrl}${path}`);
    const token = tokenStore.get();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener("load", () => {
      let data: { error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // non-JSON error page
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new AdminError(data.error ?? `Upload failed (${xhr.status})`, xhr.status));
    });
    xhr.addEventListener("error", () => reject(new AdminError("Network error: is the API reachable?", 0)));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = tokenStore.get();
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new AdminError(data.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export const adminApi = {
  login: (password: string) => request<{ token: string; expiresAt: number }>("POST", "/admin/login", { password }),
  session: () => request<{ ok: true }>("GET", "/admin/session"),
  tracks: () => request<{ items: AdminTrack[] }>("GET", "/admin/tracks").then((r) => r.items),
  updateTrack: (id: number, patch: Partial<Pick<AdminTrack, "title" | "artist" | "album">>) => request<AdminTrack>("PATCH", `/admin/tracks/${id}`, patch),
  deleteTrack: (id: number) => request<void>("DELETE", `/admin/tracks/${id}`),
  setRepeat: (trackId: number | null) => request<{ onRepeat: AdminTrack | null }>("PUT", "/admin/repeat", { trackId }),
  scan: () => request<{ added: number; updated: number; skipped: string[] }>("POST", "/admin/tracks/scan"),
  playlists: () => request<{ items: AdminPlaylist[] }>("GET", "/admin/playlists").then((r) => r.items),
  playlist: (id: number) => request<AdminPlaylist & { tracks: AdminTrack[] }>("GET", `/admin/playlists/${id}`),
  createPlaylist: (name: string) => request<AdminPlaylist>("POST", "/admin/playlists", { name }),
  renamePlaylist: (id: number, name: string) => request<AdminPlaylist>("PATCH", `/admin/playlists/${id}`, { name }),
  deletePlaylist: (id: number) => request<void>("DELETE", `/admin/playlists/${id}`),
  setPlaylistTracks: (id: number, trackIds: number[]) => request<void>("PUT", `/admin/playlists/${id}/tracks`, { trackIds }),

  /** Upload an MP3 with progress. */
  upload: (file: File, onProgress: (fraction: number) => void) => xhrUpload<AdminTrack>("/admin/tracks", file, onProgress),

  // ---- site appearance (home page background + text) ----
  appearance: () => request<Appearance>("GET", "/admin/appearance"),
  saveText: (text: string | null) => request<Appearance>("PUT", "/admin/appearance/text", { text }),
  saveTitle: (title: string | null) => request<Appearance>("PUT", "/admin/appearance/title", { title }),
  /** Upload a background video or photo; the server processes it before answering. */
  uploadBackground: (file: File, onProgress: (fraction: number) => void) =>
    xhrUpload<Appearance>("/admin/appearance/background", file, onProgress),
  /** Where phones (portrait screens) aim their crop of the uploaded background, 0..100. */
  saveBackgroundFocus: (focusX: number) => request<Appearance>("PUT", "/admin/appearance/background/focus", { focusX }),
  resetBackground: () => request<Appearance>("DELETE", "/admin/appearance/background"),
};

export function formatDuration(sec: number | null): string {
  if (sec === null) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function formatSize(bytes: number | null): string {
  if (bytes === null) return "—";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

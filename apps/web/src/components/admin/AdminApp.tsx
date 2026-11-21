"use client";

import Link from "next/link";
import { type DragEvent, type FormEvent, useCallback, useEffect, useState } from "react";
import { AdminError, type AdminPlaylist, type AdminTrack, adminApi, formatDuration, formatSize, tokenStore } from "@/lib/admin-api";
import { config } from "@/lib/config";
import { ThemeToggle } from "../ThemeToggle";
import s from "./admin.module.css";

type Auth = "checking" | "signed-out" | "signed-in";

const dateFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const message = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");

export function AdminApp() {
  const [auth, setAuth] = useState<Auth>("checking");

  useEffect(() => {
    void (async () => {
      if (!tokenStore.get()) return setAuth("signed-out");
      try {
        await adminApi.session();
        setAuth("signed-in");
      } catch {
        tokenStore.clear();
        setAuth("signed-out");
      }
    })();
  }, []);

  const signOut = useCallback(() => {
    tokenStore.clear();
    setAuth("signed-out");
  }, []);

  return (
    <div className={s.root}>
      <main className={s.sheet}>
        <header className={s.head}>
          <div>
            <span className={s.eyebrow}>ADMIN SHEET · MUSIC LIBRARY</span>
            <h1 className={s.h1}>RADIO JIL</h1>
          </div>
          <div className={s.headActions}>
            <Link className={s.btn} href="/" style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}>
              BACK TO THE STATION
            </Link>
            <ThemeToggle />
            {auth === "signed-in" ? (
              <button type="button" className={s.btn} onClick={signOut}>
                SIGN OUT
              </button>
            ) : null}
          </div>
        </header>

        {auth === "checking" ? <p className={s.note}>Checking your session…</p> : null}
        {auth === "signed-out" ? <Login onSignedIn={() => setAuth("signed-in")} /> : null}
        {auth === "signed-in" ? <Dashboard onExpired={signOut} /> : null}
      </main>
    </div>
  );
}

function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { token } = await adminApi.login(password);
      tokenStore.set(token);
      onSignedIn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={s.login} onSubmit={submit}>
      <h2 className={s.h2}>SIGN IN</h2>
      <label htmlFor="admin-password" className={s.label}>
        ADMIN PASSWORD
      </label>
      <input
        id="admin-password"
        className={s.input}
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
      />
      <button type="submit" className={s.btnSolid} disabled={busy || !password}>
        {busy ? "SIGNING IN…" : "SIGN IN"}
      </button>
      <p className={`${s.status} ${s.err}`} role="alert">
        {error}
      </p>
    </form>
  );
}

function Dashboard({ onExpired }: { onExpired: () => void }) {
  const [tracks, setTracks] = useState<AdminTrack[] | null>(null);
  const [error, setError] = useState("");

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof AdminError && err.status === 401) onExpired();
      else setError(message(err));
    },
    [onExpired],
  );

  const reload = useCallback(async () => {
    try {
      setTracks(await adminApi.tracks());
      setError("");
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  useEffect(() => {
    let alive = true;
    adminApi.tracks().then((items) => alive && setTracks(items), fail);
    return () => {
      alive = false;
    };
  }, [fail]);

  return (
    <>
      <GoingLive tracks={tracks} />
      <Upload onUploaded={reload} onError={fail} />
      <Tracks tracks={tracks} reload={reload} onError={fail} />
      <Playlists tracks={tracks ?? []} onError={fail} />
      {error ? (
        <p className={`${s.status} ${s.err}`} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

/* ---------------- going live ---------------- */
function GoingLive({ tracks }: { tracks: AdminTrack[] | null }) {
  const host = (() => {
    try {
      return new URL(config.apiUrl).hostname;
    } catch {
      return "your API domain";
    }
  })();
  const repeating = tracks?.find((t) => t.onRepeat);
  const rows: [string, string][] = [
    ["Server", host],
    ["Port", "8005"],
    ["Mount", "live-in"],
    ["User", "source"],
    ["Password", "LIVE_PASSWORD in the server's infra/.env"],
    ["Format", "MP3 320 kbps (or AAC), stereo, 44.1 kHz"],
  ];
  return (
    <section className={s.section} aria-labelledby="live-h">
      <h2 id="live-h" className={s.h2}>
        <span className={s.balloon} aria-hidden="true">0</span>GOING LIVE
      </h2>
      <p className={s.note}>
        In BUTT (or Mixxx / OBS) add an Icecast server with these settings and press play. The station switches to the live show
        within a few seconds. When the show ends, its recording appears below and plays on repeat. Turn on “update song name” so
        the show title reaches the website.
      </p>
      <dl className={s.liveGrid}>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className={s.label}>{k.toUpperCase()}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className={s.note}>
        On repeat now: <strong>{repeating ? repeating.title : "nothing (the library plays on shuffle)"}</strong>
      </p>
    </section>
  );
}

/* ---------------- ① upload ---------------- */
interface QueueItem {
  key: string;
  name: string;
  progress: number;
  state: "waiting" | "uploading" | "done" | "error";
  detail: string;
}

function Upload({ onUploaded, onError }: { onUploaded: () => void; onError: (err: unknown) => void }) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const busy = queue.some((q) => q.state === "uploading" || q.state === "waiting");

  async function uploadAll(files: File[]) {
    const items = files.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, name: f.name, progress: 0, state: "waiting" as const, detail: "" }));
    setQueue((q) => [...items, ...q].slice(0, 30));
    const patch = (key: string, p: Partial<QueueItem>) => setQueue((q) => q.map((it) => (it.key === key ? { ...it, ...p } : it)));
    for (const [i, file] of files.entries()) {
      const key = items[i]!.key;
      patch(key, { state: "uploading" });
      try {
        const t = await adminApi.upload(file, (progress) => patch(key, { progress }));
        patch(key, { state: "done", progress: 1, detail: `On air rotation as “${t.title}” · ${formatDuration(t.durationSec)}` });
        onUploaded();
      } catch (err) {
        if (err instanceof AdminError && err.status === 401) return onError(err);
        patch(key, { state: "error", detail: message(err) });
      }
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files].filter((f) => /\.mp3$/i.test(f.name) || f.type === "audio/mpeg");
    if (files.length) void uploadAll(files);
  }

  return (
    <section className={s.section} aria-labelledby="up-h">
      <h2 id="up-h" className={s.h2}>
        <span className={s.balloon} aria-hidden="true">1</span>UPLOAD MP3
      </h2>
      <div
        className={`${s.drop} ${dragging ? s.dropActive : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p className={s.note}>
          Drop MP3 files here, or choose them. Title, artist and album come from the file’s tags (you can edit them after). Uploaded
          tracks join the rotation within a few seconds.
        </p>
        <label className={`${s.btnSolid} ${s.fileLabel}`}>
          {busy ? "UPLOADING…" : "CHOOSE MP3 FILES"}
          <input
            type="file"
            accept=".mp3,audio/mpeg"
            multiple
            disabled={busy}
            onChange={(e) => {
              const files = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = "";
              if (files.length) void uploadAll(files);
            }}
          />
        </label>
      </div>
      {queue.length ? (
        <ul className={s.queue} aria-live="polite">
          {queue.map((q) => (
            <li key={q.key} className={s.queueItem}>
              <span className={s.truncate}>{q.name}</span>
              <span className={s.bar} aria-hidden="true">
                <span className={s.barFill} style={{ width: `${Math.round(q.progress * 100)}%` }} />
              </span>
              <span className={q.state === "error" ? s.err : s.ok}>
                {q.state === "waiting" ? "waiting" : q.state === "uploading" ? `${Math.round(q.progress * 100)} %` : q.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/* ---------------- ② tracks ---------------- */
function Tracks({ tracks, reload, onError }: { tracks: AdminTrack[] | null; reload: () => Promise<void>; onError: (err: unknown) => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState({ title: "", artist: "", album: "" });
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [status, setStatus] = useState("");

  const total = (tracks ?? []).reduce((sum, t) => sum + (t.durationSec ?? 0), 0);

  async function save(id: number) {
    try {
      await adminApi.updateTrack(id, { title: draft.title, artist: draft.artist || null, album: draft.album || null });
      setEditing(null);
      setStatus("Saved.");
      await reload();
    } catch (err) {
      onError(err);
    }
  }

  async function remove(id: number) {
    try {
      await adminApi.deleteTrack(id);
      setConfirmDelete(null);
      setStatus("Deleted. The file is gone from the rotation.");
      await reload();
    } catch (err) {
      onError(err);
    }
  }

  async function setRepeat(id: number | null) {
    try {
      await adminApi.setRepeat(id);
      setStatus(id === null ? "Repeat stopped. The station plays the library on shuffle." : "On repeat now. The station switches to it within seconds.");
      await reload();
    } catch (err) {
      onError(err);
    }
  }

  async function scan() {
    try {
      const r = await adminApi.scan();
      const parts = [r.added ? `Added ${r.added} new file(s).` : "No new files.", r.updated ? `Filled in length and size for ${r.updated} track(s).` : ""];
      setStatus(parts.filter(Boolean).join(" "));
      if (r.skipped.length) setStatus((m) => `${m} Skipped (not MP3): ${r.skipped.join(", ")}`);
      await reload();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <section className={s.section} aria-labelledby="tr-h">
      <div className={s.row} style={{ justifyContent: "space-between" }}>
        <h2 id="tr-h" className={s.h2}>
          <span className={s.balloon} aria-hidden="true">2</span>
          TRACKS · {tracks?.length ?? "…"} · {formatDuration(total)} TOTAL
        </h2>
        <button type="button" className={s.btn} onClick={() => void scan()}>
          SCAN MUSIC FOLDER
        </button>
      </div>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">TITLE</th>
              <th scope="col">ARTIST</th>
              <th scope="col">ALBUM</th>
              <th scope="col" className={s.num}>LENGTH</th>
              <th scope="col" className={s.num}>SIZE</th>
              <th scope="col">ADDED</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tracks === null ? (
              <tr>
                <td colSpan={7} className={s.empty}>Loading…</td>
              </tr>
            ) : tracks.length === 0 ? (
              <tr>
                <td colSpan={7} className={s.empty}>No tracks yet. Upload an MP3 above.</td>
              </tr>
            ) : (
              tracks.map((t) =>
                editing === t.id ? (
                  <tr key={t.id}>
                    <td>
                      <input aria-label="Title" className={s.input} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.currentTarget.value })} />
                    </td>
                    <td>
                      <input aria-label="Artist" className={s.input} value={draft.artist} onChange={(e) => setDraft({ ...draft, artist: e.currentTarget.value })} />
                    </td>
                    <td>
                      <input aria-label="Album" className={s.input} value={draft.album} onChange={(e) => setDraft({ ...draft, album: e.currentTarget.value })} />
                    </td>
                    <td className={s.num}>{formatDuration(t.durationSec)}</td>
                    <td className={s.num}>{formatSize(t.sizeBytes)}</td>
                    <td>{dateFormat.format(new Date(t.createdAt))}</td>
                    <td>
                      <div className={s.actions}>
                        <button type="button" className={`${s.btnSolid} ${s.small}`} disabled={!draft.title.trim()} onClick={() => void save(t.id)}>
                          SAVE
                        </button>
                        <button type="button" className={`${s.btn} ${s.small}`} onClick={() => setEditing(null)}>
                          CANCEL
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={t.id}>
                    <td>
                      {t.title}
                      {t.source === "live" ? <span className={s.tag}>LIVE REC</span> : null}
                      {t.onRepeat ? <span className={`${s.tag} ${s.tagHot}`}>ON REPEAT</span> : null}
                      {t.onDisk ? null : <span className={s.missing}> · FILE MISSING</span>}
                    </td>
                    <td>{t.artist ?? "—"}</td>
                    <td>{t.album ?? "—"}</td>
                    <td className={s.num}>{formatDuration(t.durationSec)}</td>
                    <td className={s.num}>{formatSize(t.sizeBytes)}</td>
                    <td>{dateFormat.format(new Date(t.createdAt))}</td>
                    <td>
                      <div className={s.actions}>
                        {confirmDelete === t.id ? (
                          <>
                            <button type="button" className={`${s.btnDanger} ${s.small}`} onClick={() => void remove(t.id)}>
                              DELETE FOR GOOD
                            </button>
                            <button type="button" className={`${s.btn} ${s.small}`} onClick={() => setConfirmDelete(null)}>
                              KEEP
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className={`${s.btn} ${s.small}`}
                              onClick={() => void setRepeat(t.onRepeat ? null : t.id)}
                              aria-pressed={t.onRepeat}
                              disabled={!t.onDisk}
                            >
                              {t.onRepeat ? "STOP REPEAT" : "REPEAT"}
                            </button>
                            <button
                              type="button"
                              className={`${s.btn} ${s.small}`}
                              onClick={() => {
                                setEditing(t.id);
                                setDraft({ title: t.title, artist: t.artist ?? "", album: t.album ?? "" });
                              }}
                            >
                              EDIT
                            </button>
                            <button type="button" className={`${s.btn} ${s.small}`} onClick={() => setConfirmDelete(t.id)} aria-label={`Delete ${t.title}`}>
                              DELETE
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ),
              )
            )}
          </tbody>
        </table>
      </div>
      <p className={s.status} role="status">
        {status}
      </p>
    </section>
  );
}

/* ---------------- ③ playlists ---------------- */
function Playlists({ tracks, onError }: { tracks: AdminTrack[]; onError: (err: unknown) => void }) {
  const [lists, setLists] = useState<AdminPlaylist[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [items, setItems] = useState<AdminTrack[]>([]);
  const [newName, setNewName] = useState("");
  const [rename, setRename] = useState("");
  const [addId, setAddId] = useState("");
  const [dirty, setDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [status, setStatus] = useState("");

  const loadLists = useCallback(async () => {
    try {
      setLists(await adminApi.playlists());
    } catch (err) {
      onError(err);
    }
  }, [onError]);

  useEffect(() => {
    let alive = true;
    adminApi.playlists().then((found) => alive && setLists(found), onError);
    return () => {
      alive = false;
    };
  }, [onError]);

  async function open(id: number) {
    try {
      const pl = await adminApi.playlist(id);
      setSelected(id);
      setItems(pl.tracks);
      setRename(pl.name);
      setDirty(false);
      setConfirmDelete(false);
      setStatus("");
    } catch (err) {
      onError(err);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const pl = await adminApi.createPlaylist(newName.trim());
      setNewName("");
      await loadLists();
      await open(pl.id);
    } catch (err) {
      if (err instanceof AdminError && err.status === 409) setStatus(err.message);
      else onError(err);
    }
  }

  async function saveTracks() {
    if (selected === null) return;
    try {
      await adminApi.setPlaylistTracks(selected, items.map((t) => t.id));
      if (rename.trim()) await adminApi.renamePlaylist(selected, rename.trim());
      setDirty(false);
      setStatus("Playlist saved.");
      await loadLists();
    } catch (err) {
      if (err instanceof AdminError && err.status === 409) setStatus(err.message);
      else onError(err);
    }
  }

  async function removePlaylist() {
    if (selected === null) return;
    try {
      await adminApi.deletePlaylist(selected);
      setSelected(null);
      setItems([]);
      setStatus("Playlist deleted.");
      await loadLists();
    } catch (err) {
      onError(err);
    }
  }

  const move = (i: number, d: -1 | 1) => {
    const next = [...items];
    const [it] = next.splice(i, 1);
    next.splice(i + d, 0, it!);
    setItems(next);
    setDirty(true);
  };

  const available = tracks.filter((t) => !items.some((i) => i.id === t.id));
  const current = lists?.find((l) => l.id === selected);

  return (
    <section className={s.section} aria-labelledby="pl-h">
      <h2 id="pl-h" className={s.h2}>
        <span className={s.balloon} aria-hidden="true">3</span>PLAYLISTS
      </h2>
      <p className={s.note}>
        Playlists are saved for scheduling later. For now the station plays every track in the library on shuffle.
      </p>
      <div className={s.plGrid}>
        <div className={s.section}>
          <form className={s.row} onSubmit={create}>
            <label htmlFor="pl-new" className="sr-only">
              New playlist name
            </label>
            <input id="pl-new" className={`${s.input} ${s.grow}`} placeholder="New playlist name" value={newName} onChange={(e) => setNewName(e.currentTarget.value)} />
            <button type="submit" className={s.btnSolid} disabled={!newName.trim()}>
              CREATE
            </button>
          </form>
          <ul className={s.plList}>
            {lists === null ? <li className={s.note} style={{ padding: 12 }}>Loading…</li> : null}
            {lists?.length === 0 ? <li className={s.note} style={{ padding: 12 }}>No playlists yet.</li> : null}
            {lists?.map((l) => (
              <li key={l.id}>
                <button type="button" className={s.plItem} aria-current={l.id === selected} onClick={() => void open(l.id)}>
                  <span className={s.truncate}>{l.name}</span>
                  <span>{l.trackCount ?? 0}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {selected !== null && current ? (
          <div className={s.plEditor}>
            <div className={s.row}>
              <label htmlFor="pl-rename" className={s.label}>
                NAME
              </label>
              <input
                id="pl-rename"
                className={`${s.input} ${s.grow}`}
                value={rename}
                onChange={(e) => {
                  setRename(e.currentTarget.value);
                  setDirty(true);
                }}
              />
            </div>
            <ol className={s.plTracks}>
              {items.length === 0 ? <li className={s.note}>Empty. Add tracks below.</li> : null}
              {items.map((t, i) => (
                <li key={t.id} className={s.plTrack}>
                  <span>{String(i + 1).padStart(2, "0")}</span>
                  <span className={s.truncate}>
                    {t.title} <span className={s.ok}>· {t.artist ?? "—"} · {formatDuration(t.durationSec)}</span>
                  </span>
                  <span className={s.actions}>
                    <button type="button" className={`${s.btn} ${s.small}`} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${t.title} up`}>
                      ↑
                    </button>
                    <button type="button" className={`${s.btn} ${s.small}`} disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${t.title} down`}>
                      ↓
                    </button>
                    <button
                      type="button"
                      className={`${s.btn} ${s.small}`}
                      onClick={() => {
                        setItems(items.filter((x) => x.id !== t.id));
                        setDirty(true);
                      }}
                      aria-label={`Remove ${t.title} from the playlist`}
                    >
                      REMOVE
                    </button>
                  </span>
                </li>
              ))}
            </ol>
            <div className={s.row}>
              <label htmlFor="pl-add" className="sr-only">
                Track to add
              </label>
              <select id="pl-add" className={`${s.input} ${s.grow}`} value={addId} onChange={(e) => setAddId(e.currentTarget.value)}>
                <option value="">Add a track…</option>
                {available.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title} · {t.artist ?? "—"} ({formatDuration(t.durationSec)})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={s.btn}
                disabled={!addId}
                onClick={() => {
                  const t = tracks.find((x) => String(x.id) === addId);
                  if (t) {
                    setItems([...items, t]);
                    setDirty(true);
                  }
                  setAddId("");
                }}
              >
                ADD
              </button>
            </div>
            <div className={s.row} style={{ justifyContent: "space-between" }}>
              <button type="button" className={s.btnSolid} disabled={!dirty} onClick={() => void saveTracks()}>
                SAVE PLAYLIST
              </button>
              {confirmDelete ? (
                <span className={s.actions}>
                  <button type="button" className={s.btnDanger} onClick={() => void removePlaylist()}>
                    DELETE PLAYLIST
                  </button>
                  <button type="button" className={s.btn} onClick={() => setConfirmDelete(false)}>
                    KEEP
                  </button>
                </span>
              ) : (
                <button type="button" className={s.btn} onClick={() => setConfirmDelete(true)}>
                  DELETE
                </button>
              )}
            </div>
          </div>
        ) : (
          <p className={s.note}>Pick a playlist to edit it.</p>
        )}
      </div>
      <p className={s.status} role="status">
        {status}
      </p>
    </section>
  );
}

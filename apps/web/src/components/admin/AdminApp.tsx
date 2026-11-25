"use client";

import Link from "next/link";
import { type DragEvent, type FormEvent, useCallback, useEffect, useState } from "react";
import { AdminError, type AdminTrack, adminApi, formatDuration, formatSize, tokenStore } from "@/lib/admin-api";
import { config } from "@/lib/config";
import { DEFAULT_BACKGROUND } from "@/lib/appearance";
import type { Appearance } from "@/lib/types";
import { ThemeToggle } from "../ThemeToggle";
import s from "./admin.module.css";
import { LiveDesk } from "./LiveDesk";

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
            <h1 className={s.h1}>RADIO AHA</h1>
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
      <LiveDesk tracks={tracks} onSaved={() => void reload()} />
      <Look onError={fail} />
      <Upload onUploaded={reload} onError={fail} />
      <Tracks tracks={tracks} reload={reload} onError={fail} />
      {error ? (
        <p className={`${s.status} ${s.err}`} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

/* ---------------- home page look ---------------- */
const MAX_TEXT = 1000;
const MAX_TITLE = 200;
const apiSrc = (p: string) => `${config.apiUrl}${p}`;

function Look({ onError }: { onError: (err: unknown) => void }) {
  const [look, setLook] = useState<Appearance | null>(null);
  const [text, setText] = useState("");
  const [textState, setTextState] = useState<"idle" | "saving" | "saved">("idle");
  const [title, setTitle] = useState("");
  const [titleState, setTitleState] = useState<"idle" | "saving" | "saved">("idle");
  const [focus, setFocus] = useState(50);
  const [focusState, setFocusState] = useState<"idle" | "saving" | "saved">("idle");
  const [upload, setUpload] = useState<{ state: "idle" | "uploading" | "processing" | "done" | "error"; progress: number; detail: string }>({
    state: "idle",
    progress: 0,
    detail: "",
  });
  const busy = upload.state === "uploading" || upload.state === "processing";

  useEffect(() => {
    let alive = true;
    adminApi.appearance().then((a) => {
      if (!alive) return;
      setLook(a);
      setText(a.text ?? "");
      setTitle(a.title ?? "");
      setFocus(a.background?.focusX ?? 50);
    }, onError);
    return () => {
      alive = false;
    };
  }, [onError]);

  async function saveText(e: FormEvent) {
    e.preventDefault();
    setTextState("saving");
    try {
      const a = await adminApi.saveText(text.trim() ? text : null);
      setLook(a);
      setText(a.text ?? "");
      setTextState("saved");
    } catch (err) {
      setTextState("idle");
      onError(err);
    }
  }

  async function saveTitle(e: FormEvent) {
    e.preventDefault();
    setTitleState("saving");
    try {
      const a = await adminApi.saveTitle(title.trim() ? title : null);
      setLook(a);
      setTitle(a.title ?? "");
      setTitleState("saved");
    } catch (err) {
      setTitleState("idle");
      onError(err);
    }
  }

  async function uploadBackground(file: File) {
    setUpload({ state: "uploading", progress: 0, detail: "" });
    try {
      const a = await adminApi.uploadBackground(file, (progress) =>
        setUpload({ state: progress >= 1 ? "processing" : "uploading", progress, detail: "" }),
      );
      setLook(a);
      setFocus(a.background?.focusX ?? 50);
      setFocusState("idle");
      setUpload({ state: "done", progress: 1, detail: "Saved. The site updates within a minute." });
    } catch (err) {
      if (err instanceof AdminError && err.status === 401) return onError(err);
      setUpload({ state: "error", progress: 0, detail: message(err) });
    }
  }

  async function saveFocus(e: FormEvent) {
    e.preventDefault();
    setFocusState("saving");
    try {
      const a = await adminApi.saveBackgroundFocus(focus);
      setLook(a);
      setFocus(a.background?.focusX ?? 50);
      setFocusState("saved");
    } catch (err) {
      setFocusState("idle");
      onError(err);
    }
  }

  async function reset() {
    try {
      setLook(await adminApi.resetBackground());
      setUpload({ state: "done", progress: 1, detail: "Back to the default fog video. The site updates within a minute." });
    } catch (err) {
      onError(err);
    }
  }

  const bg = look?.background;
  // What a phone shows: the uploaded background at the chosen focus, or the default fog at its fixed one.
  const phone = bg
    ? { kind: bg.kind, src: apiSrc(bg.url), poster: bg.poster ? apiSrc(bg.poster) : undefined, x: focus }
    : { kind: "video" as const, src: DEFAULT_BACKGROUND.src, poster: DEFAULT_BACKGROUND.poster ?? undefined, x: DEFAULT_BACKGROUND.focusX };

  return (
    <section className={s.section} aria-labelledby="look-h">
      <h2 id="look-h" className={s.h2}>
        HOME PAGE LOOK
      </h2>
      <p className={s.note}>The background and the text on the home page. Changes show up on the site within a minute.</p>

      <form className={s.lookText} onSubmit={saveTitle}>
        <label htmlFor="look-title" className={s.label}>
          NOW PLAYING TITLE
        </label>
        <input
          id="look-title"
          className={s.input}
          value={title}
          maxLength={MAX_TITLE}
          placeholder="Empty = the title of the track on air"
          onChange={(e) => {
            setTitle(e.currentTarget.value);
            setTitleState("idle");
          }}
        />
        <div className={s.row}>
          <button type="submit" className={s.btnSolid} disabled={titleState === "saving" || look === null}>
            {titleState === "saving" ? "SAVING…" : "SAVE TITLE"}
          </button>
          <span className={s.note} aria-live="polite">
            {title.length} / {MAX_TITLE}
            {titleState === "saved" ? " · saved" : ""}
          </span>
        </div>
      </form>

      <form className={s.lookText} onSubmit={saveText}>
        <label htmlFor="look-text" className={s.label}>
          TEXT
        </label>
        <textarea
          id="look-text"
          className={`${s.input} ${s.textarea}`}
          value={text}
          maxLength={MAX_TEXT}
          rows={6}
          placeholder="Empty = the default text"
          onChange={(e) => {
            setText(e.currentTarget.value);
            setTextState("idle");
          }}
        />
        <div className={s.row}>
          <button type="submit" className={s.btnSolid} disabled={textState === "saving" || look === null}>
            {textState === "saving" ? "SAVING…" : "SAVE TEXT"}
          </button>
          <span className={s.note} aria-live="polite">
            {text.length} / {MAX_TEXT}
            {textState === "saved" ? " · saved" : ""}
          </span>
        </div>
      </form>

      <div className={s.lookBg}>
        <span className={s.label}>BACKGROUND</span>
        <div className={s.lookPreviews}>
          <div className={s.lookPreview}>
            {bg?.kind === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element -- small admin preview from our API
              <img src={apiSrc(bg.url)} alt="Current background" />
            ) : bg?.kind === "video" ? (
              <video src={apiSrc(bg.url)} poster={bg.poster ? apiSrc(bg.poster) : undefined} muted loop playsInline autoPlay aria-label="Current background video" />
            ) : (
              <video src="/bg.mp4" poster="/bg.jpg" muted loop playsInline autoPlay aria-label="Default fog background video" />
            )}
          </div>
          <div className={s.lookPhone} aria-hidden="true">
            {phone.kind === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element -- small admin preview from our API
              <img src={phone.src} alt="" style={{ objectPosition: `${phone.x}% 50%` }} />
            ) : (
              <video src={phone.src} poster={phone.poster} muted loop playsInline autoPlay style={{ objectPosition: `${phone.x}% 50%` }} />
            )}
          </div>
        </div>
        {bg ? (
          <form className={s.lookFocus} onSubmit={saveFocus}>
            <label htmlFor="look-focus" className={s.label}>
              PHONE FOCUS
            </label>
            <p className={s.note}>Phones show only a narrow slice of the picture. Slide to choose which part, then save.</p>
            <input
              id="look-focus"
              type="range"
              min={0}
              max={100}
              step={1}
              value={focus}
              onChange={(e) => {
                setFocus(Number(e.currentTarget.value));
                setFocusState("idle");
              }}
            />
            <div className={s.row}>
              <button type="submit" className={s.btnSolid} disabled={focusState === "saving" || focus === bg.focusX}>
                {focusState === "saving" ? "SAVING…" : "SAVE FOCUS"}
              </button>
              <span className={s.note} aria-live="polite">
                {focus === 0 ? "left edge" : focus === 100 ? "right edge" : focus === 50 ? "centre" : `${focus} % from the left`}
                {focusState === "saved" ? " · saved" : ""}
              </span>
            </div>
          </form>
        ) : null}
        <p className={s.note}>
          {bg ? (bg.kind === "video" ? "Your video." : "Your photo.") : "The default fog video."} Upload a video (up to 60 seconds) or a
          photo to replace it. Videos lose their sound and get resized for the web.
        </p>
        <div className={s.row}>
          <label className={`${s.btnSolid} ${s.fileLabel}`}>
            {upload.state === "uploading" ? `UPLOADING ${Math.round(upload.progress * 100)} %` : upload.state === "processing" ? "PROCESSING…" : "CHOOSE VIDEO OR PHOTO"}
            <input
              type="file"
              accept="video/*,image/*"
              disabled={busy}
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                if (file) void uploadBackground(file);
              }}
            />
          </label>
          {bg ? (
            <button type="button" className={s.btn} onClick={() => void reset()} disabled={busy}>
              RESET TO DEFAULT
            </button>
          ) : null}
        </div>
        {busy ? (
          <span className={s.bar} aria-hidden="true">
            <span className={s.barFill} style={{ width: `${Math.round(upload.progress * 100)}%` }} />
          </span>
        ) : null}
        <p className={upload.state === "error" ? s.err : s.ok} role="status" aria-live="polite">
          {upload.state === "processing" ? "Processing on the server… this can take a minute for longer videos." : upload.detail}
        </p>
      </div>
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

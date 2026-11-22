"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type AdminTrack, adminApi, tokenStore } from "@/lib/admin-api";
import { config } from "@/lib/config";
import { type MicTestDeps, startMicTest } from "@/lib/mic-test";
import { afterShow, type BroadcastState, type Broadcaster, type BroadcasterDeps, createBroadcaster, formatOnAir } from "@/lib/live-broadcast";
import s from "./admin.module.css";
import { type LivePhase, LiveButton } from "./LiveButton";

const SAVE_POLL_MS = 2000;
const SAVE_WAIT_MS = 40_000;

type SaveState = { kind: "none" } | { kind: "saving" } | { kind: "saved"; title: string } | { kind: "too-short" } | { kind: "slow" };

export function LiveDesk({ tracks, onSaved }: { tracks: AdminTrack[] | null; onSaved: () => void }) {
  const broadcaster = useRef<Broadcaster | null>(null);
  const [state, setState] = useState<BroadcastState>({ phase: "idle", startedAt: null, message: "" });
  const [title, setTitle] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const micTest = useRef<ReturnType<typeof startMicTest> | null>(null);
  /** Playback of the last mic test (a local blob URL; nothing is uploaded). */
  const [testUrl, setTestUrl] = useState<string | null>(null);
  const [liveStream, setLiveStream] = useState<MediaStream | null>(null);
  const [clock, setClock] = useState(0);
  const [save, setSave] = useState<SaveState>({ kind: "none" });

  const onAir = state.phase === "on-air";
  const busy = state.phase === "mic" || state.phase === "connecting" || state.phase === "stopping";
  const repeating = tracks?.find((t) => t.onRepeat);

  /** Microphones with names (names only appear once the browser has mic permission). */
  const refreshDevices = useCallback(
    () =>
      navigator.mediaDevices
        ?.enumerateDevices()
        .then((all) => setDevices(all.filter((d) => d.kind === "audioinput" && d.label)))
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    // Mics already connected when the page opens (names show if permission was given before).
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) => setDevices(all.filter((d) => d.kind === "audioinput" && d.label)))
      .catch(() => {});
    navigator.mediaDevices?.addEventListener("devicechange", refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refreshDevices);
  }, [refreshDevices]);

  // Clock for the ON AIR timer; warn before closing the tab mid-show.
  useEffect(() => {
    if (!onAir) return;
    const t = setInterval(() => setClock(Date.now()), 1000);
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => {
      clearInterval(t);
      window.removeEventListener("beforeunload", warn);
    };
  }, [onAir]);

  // Leaving the admin page ends the show (or cancels a pending mic prompt).
  useEffect(() => () => broadcaster.current?.stop(), []);
  // Release a test-mic stream when it's replaced or the page closes.
  useEffect(() => () => preview?.getTracks().forEach((t) => t.stop()), [preview]);
  // Free the previous test recording when a new one replaces it.
  useEffect(() => () => (testUrl ? URL.revokeObjectURL(testUrl) : undefined), [testUrl]);

  /** Ends the mic test; with `keep`, the recording pops up for playback. */
  async function stopPreview(keep = false) {
    const test = micTest.current;
    micTest.current = null;
    const blob = await test?.stop();
    for (const t of preview?.getTracks() ?? []) t.stop();
    setPreview(null);
    if (keep && blob && blob.size > 0) setTestUrl(URL.createObjectURL(blob));
  }

  async function testMic() {
    if (preview) return stopPreview(true);
    setTestUrl(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      setPreview(stream);
      micTest.current = startMicTest(stream, {
        MediaRecorder: MediaRecorder as unknown as MicTestDeps["MediaRecorder"],
        onAutoStop: () => void stopPreview(true),
      });
      await refreshDevices();
    } catch {
      setState({ phase: "error", startedAt: null, message: "Microphone access was blocked. Allow it in the browser's address bar and try again." });
    }
  }

  /** After a show: wait for its recording to show up on repeat. */
  async function watchForRecording(startedAt: number) {
    setSave({ kind: "saving" });
    const deadline = Date.now() + SAVE_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SAVE_POLL_MS));
      const items = await adminApi.tracks().catch(() => null);
      const saved = items?.find((t) => t.source === "live" && t.onRepeat && Date.parse(t.createdAt) >= startedAt);
      if (saved) {
        setSave({ kind: "saved", title: saved.title });
        onSaved();
        return;
      }
    }
    setSave({ kind: "slow" });
    onSaved();
  }

  async function goLive() {
    await stopPreview();
    setTestUrl(null);
    setSave({ kind: "none" });
    const b = createBroadcaster({
      getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
      // The real browser classes, typed against the small interfaces the broadcaster needs.
      MediaRecorder: MediaRecorder as unknown as BroadcasterDeps["MediaRecorder"],
      WebSocket: WebSocket as unknown as BroadcasterDeps["WebSocket"],
      apiUrl: config.apiUrl,
      token: () => tokenStore.get(),
    });
    broadcaster.current = b;
    let startedAt: number | null = null;
    b.on("state", (st) => {
      setState(st);
      setLiveStream(st.phase === "on-air" ? (b.stream as MediaStream | null) : null);
      if (st.phase === "on-air") {
        startedAt = st.startedAt;
        setClock(Date.now());
      }
      // Whatever ended the show (Stop, lost connection), a recording is on its way if we were on air.
      if ((st.phase === "ended" || st.phase === "error") && startedAt !== null) {
        const began = startedAt;
        startedAt = null;
        const next = afterShow(st.phase, Date.now() - began);
        if (next === "watch") void watchForRecording(began);
        else if (next === "too-short") setSave({ kind: "too-short" });
        // "error": the error message itself is shown
      }
    });
    await b.start({ deviceId: deviceId || undefined, title: title.trim() || null });
    void refreshDevices();
  }

  const livePhase: LivePhase =
    state.phase === "mic" || state.phase === "connecting" ? "connecting" : state.phase === "stopping" ? "stopping" : onAir ? "live" : "idle";

  return (
    <section className={s.section} aria-labelledby="live-h">
      <h2 id="live-h" className={s.h2}>
        LIVE
      </h2>
      <div className={s.liveTop}>
        <p className={s.note}>
          Go live with this computer's microphone (or a mixer plugged into it). When you stop, the show is saved and plays on
          repeat. Use headphones, and don't play the station on this computer while you're live.
        </p>

        <div className={s.liveDesk}>
          <label className={s.liveField}>
            <span className={s.label}>SHOW TITLE (OPTIONAL)</span>
            <input
              className={`${s.input} ${s.inputSm}`}
              value={title}
              maxLength={120}
              disabled={onAir || busy}
              placeholder="e.g. Sunday Morning"
              onChange={(e) => setTitle(e.currentTarget.value)}
            />
          </label>

          {devices.length > 1 ? (
            <label className={s.liveField}>
              <span className={s.label}>MICROPHONE</span>
              <select className={`${s.input} ${s.inputSm}`} value={deviceId} disabled={onAir || busy} onChange={(e) => setDeviceId(e.currentTarget.value)}>
                <option value="">System default</option>
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className={s.liveField}>
            <span className={s.label}>MIC TEST</span>
            <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={onAir || busy} onClick={() => void testMic()}>
              {preview ? "STOP TEST" : "TEST MIC"}
            </button>
          </div>
        </div>
      </div>
      {preview ? <p className={s.note}>Recording a test… say something, then press STOP TEST to hear it.</p> : null}

      {testUrl && !onAir ? (
        <div className={s.liveField}>
          <span className={s.label}>YOUR MIC TEST (ONLY YOU HEAR THIS)</span>
          <audio className={s.testAudio} src={testUrl} controls autoPlay />
        </div>
      ) : null}

      <LiveButton
        stream={liveStream ?? preview}
        phase={livePhase}
        timer={`ON AIR ${formatOnAir(clock - (state.startedAt ?? clock))}`}
        onStart={() => void goLive()}
        onStop={() => broadcaster.current?.stop()}
      />

      <p className={save.kind === "none" && state.phase === "error" ? s.err : s.ok} role="status" aria-live="polite">
        {save.kind === "saving"
          ? "Show ended. Saving…"
          : save.kind === "saved"
            ? `Saved · on repeat now: ${save.title}`
            : save.kind === "too-short"
              ? "Not saved: shows shorter than 30 seconds are discarded."
              : save.kind === "slow"
                ? "Still saving… it will appear in the tracks list."
                : state.phase === "error"
                  ? state.message
                  : ""}
      </p>
      {save.kind === "none" ? (
        <p className={s.note}>
          On repeat now: <strong>{repeating ? repeating.title : "nothing (the library plays on shuffle)"}</strong>
        </p>
      ) : null}
    </section>
  );
}

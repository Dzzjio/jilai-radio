import { pickMimeType } from "./live-broadcast";

interface RecorderLike {
  state: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
}

export interface MicTestDeps {
  MediaRecorder: { new (stream: unknown, opts: { mimeType: string }): RecorderLike; isTypeSupported(t: string): boolean };
  /** The test stops by itself after this long (default 60 s). */
  maxMs?: number;
  onAutoStop?: () => void;
}

/**
 * Records a short mic test locally (nothing is sent anywhere) so the admin can play it back
 * and hear how they sound before going live.
 */
export function startMicTest(stream: unknown, deps: MicTestDeps): { stop(): Promise<Blob | null> } {
  const mimeType = pickMimeType((t) => deps.MediaRecorder.isTypeSupported(t));
  if (!mimeType) return { stop: async () => null };

  const chunks: Blob[] = [];
  const rec = new deps.MediaRecorder(stream, { mimeType });
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  let done: Promise<Blob | null> | null = null;
  const stop = () => {
    done ??= new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
      if (rec.state === "inactive") resolve(new Blob(chunks, { type: mimeType }));
      else rec.stop();
    });
    return done;
  };
  rec.start();
  const timer = setTimeout(() => {
    void stop();
    deps.onAutoStop?.();
  }, deps.maxMs ?? 60_000);
  return {
    stop() {
      clearTimeout(timer);
      return stop();
    },
  };
}

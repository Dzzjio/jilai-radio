import type { AudioFrame } from "./viz/analysis";
import type { AudioGraph, AudioLike } from "./audio-controller";

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

/**
 * Web Audio routing for the stream: <audio> → analyser → gain → speakers.
 * The analyser sits before the gain, so the visualizer reflects the music,
 * not the listener's volume. Requires the stream to send CORS headers
 * (Icecast: Access-Control-Allow-Origin), otherwise the browser feeds silence.
 */
export function createWebAudioGraph() {
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let td: Uint8Array<ArrayBuffer> | null = null;
  let fd: Uint8Array<ArrayBuffer> | null = null;

  return {
    connect(el: AudioLike): AudioGraph {
      const AC = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
      if (!AC) throw new Error("Web Audio is not available");
      const c = new AC();
      const source = c.createMediaElementSource(el as HTMLMediaElement);
      const an = c.createAnalyser();
      an.fftSize = 4096; // ~10.8 Hz bins: enough to separate the 31–63 Hz bands
      an.smoothingTimeConstant = 0.78;
      const gain = c.createGain();
      source.connect(an);
      an.connect(gain);
      gain.connect(c.destination);
      ctx = c;
      analyser = an;
      td = new Uint8Array(an.fftSize);
      fd = new Uint8Array(an.frequencyBinCount);
      return {
        setGain(value) {
          gain.gain.setTargetAtTime(value, c.currentTime, 0.015);
        },
        resume() {
          return c.state === "suspended" ? c.resume() : undefined;
        },
      };
    },

    /** Fills and returns the latest analysis frame, or null before the first play. */
    read(): AudioFrame | null {
      if (!ctx || !analyser || !td || !fd) return null;
      analyser.getByteTimeDomainData(td);
      analyser.getByteFrequencyData(fd);
      return { td, fd, sampleRate: ctx.sampleRate, minDb: analyser.minDecibels, maxDb: analyser.maxDecibels };
    },
  };
}

export type WebAudioGraph = ReturnType<typeof createWebAudioGraph>;

import type { AttachHls, AudioLike } from "./audio-controller";

/**
 * Plays a live HLS playlist through hls.js (Media Source). Loaded only when a show is on.
 * Browsers without Media Source get null: the controller falls back to the plain stream.
 */
export const attachHls: AttachHls = async (el: AudioLike, url: string, onFatal: () => void) => {
  const { default: Hls } = await import("hls.js");
  if (!Hls.isSupported()) return null;
  const hls = new Hls({
    // Keep the whole show reachable: never jump forward on its own, never speed up.
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: Number.POSITIVE_INFINITY,
    maxLiveSyncPlaybackRate: 1,
    // Audio is small: keep what was played so rewinding a little is instant.
    backBufferLength: 600,
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data.fatal) onFatal();
  });
  await new Promise<void>((resolve) => {
    hls.once(Hls.Events.MEDIA_ATTACHED, () => resolve());
    hls.attachMedia(el as HTMLMediaElement);
  });
  hls.loadSource(url);
  return {
    destroy: () => hls.destroy(),
    liveSyncPosition: () => hls.liveSyncPosition,
  };
};

import { spawn as nodeSpawn } from "node:child_process";
import type { FastifyBaseLogger } from "fastify";

/** Liquidsoap's live input (harbor), the same place BUTT used to connect to. */
export interface LiveTarget {
  host: string;
  port: number;
  mount: string;
  password: string;
}

/**
 * Voice processing for the live show (one microphone, talk only). It runs before Liquidsoap,
 * so the recording, and therefore the show's repeat, carries it too.
 *   mono        average the channels: a mic that arrives on one channel only still reaches both ears
 *   highpass    remove rumble below 80 Hz (desk bumps, traffic, handling noise)
 *   acompressor even out quiet and loud moments (above −24 dB, 3:1), then +6 dB back
 *   alimiter    lookahead limiter at −1.5 dB: laughs and shouts never clip
 *   pan         copy the mono voice to both channels at full level (ffmpeg's own upmix drops 3 dB)
 */
export const VOICE_FILTER =
  "aformat=channel_layouts=mono,highpass=f=80," +
  "acompressor=threshold=0.063:ratio=3:attack=10:release=250:knee=2:makeup=2," +
  "alimiter=limit=0.84:attack=5:release=100:level=disabled,pan=stereo|c0=c0|c1=c0";

/** ffmpeg: whatever the browser recorded (WebM/Ogg Opus or MP4 AAC) on stdin → voice processing → MP3 into the live input. */
export function ffmpegLiveArgs(t: LiveTarget): string[] {
  const auth = `source:${encodeURIComponent(t.password)}`;
  return [
    "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
    "-af", VOICE_FILTER,
    "-c:a", "libmp3lame", "-b:a", "320k", "-ar", "44100", "-ac", "2",
    "-content_type", "audio/mpeg", "-f", "mp3",
    `icecast://${auth}@${t.host}:${t.port}/${t.mount}`,
  ];
}

/** ffmpeg prints its output URL in errors; never let the live password reach logs or the browser. */
export function redactSecrets(text: string): string {
  return text.replace(/source:[^@\s]*@/g, "source:***@");
}

export class BroadcastBusyError extends Error {
  constructor() {
    super("Someone is already live.");
    this.name = "BroadcastBusyError";
  }
}

export interface BroadcastSession {
  write(chunk: Buffer): void;
  /** Ends the show: ffmpeg flushes and exits, Liquidsoap sees the disconnect and saves the recording. */
  stop(): void;
  onExit(cb: (code: number | null, stderr: string) => void): void;
  /** No audio arrived for `idleMs` (laptop asleep, network gone): the show is being stopped. */
  onIdle(cb: () => void): void;
}

interface ChildLike {
  stdin: NodeJS.WritableStream & { writableEnded?: boolean; on(e: "error", cb: (err: Error) => void): unknown };
  stderr: NodeJS.ReadableStream | null;
  on(e: "exit", cb: (code: number | null, signal: string | null) => void): unknown;
  on(e: "error", cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface LiveBroadcastOptions {
  target: LiveTarget;
  spawn?: (cmd: string, args: string[], opts: object) => ChildLike;
  log?: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  ffmpegPath?: string;
  /** End the show when no audio chunk arrives for this long (default 5 s; the browser sends every 250 ms). */
  idleMs?: number;
}

const quiet = { info() {}, warn() {}, error() {} };

/** One browser live show at a time, fed to Liquidsoap through ffmpeg. */
export class LiveBroadcast {
  #session: BroadcastSession | null = null;
  #title: string | null = null;

  constructor(private readonly opts: LiveBroadcastOptions) {}

  /** No LIVE_PASSWORD → the live input is locked, so nobody can go live. */
  get enabled() {
    return this.opts.target.password !== "";
  }

  get busy() {
    return this.#session !== null;
  }

  /** Title of the browser show on air (Liquidsoap's "live started" call uses it). */
  get currentTitle(): string | null {
    return this.#session ? this.#title : null;
  }

  start(title: string | null): BroadcastSession {
    if (this.#session) throw new BroadcastBusyError();
    const log = this.opts.log ?? quiet;
    const spawn = this.opts.spawn ?? (nodeSpawn as unknown as NonNullable<LiveBroadcastOptions["spawn"]>);
    const child = spawn(this.opts.ffmpegPath ?? "ffmpeg", ffmpegLiveArgs(this.opts.target), { stdio: ["pipe", "ignore", "pipe"] });

    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr = redactSecrets(stderr + d.toString()).slice(-2000);
    });
    child.stdin.on("error", () => {}); // EPIPE after ffmpeg died; reported through "exit"

    const exitCbs: ((code: number | null, stderr: string) => void)[] = [];
    const idleCbs: (() => void)[] = [];
    const idleMs = this.opts.idleMs ?? 5000;
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        log.warn({ idleMs }, "browser live: no audio, ending the show");
        for (const cb of idleCbs) cb();
        session.stop();
      }, idleMs);
      idleTimer.unref();
    };
    let exited = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (exited) return;
      exited = true;
      clearTimeout(killTimer);
      clearTimeout(idleTimer);
      if (this.#session === session) this.#session = null;
      log.info({ code }, "browser live: ffmpeg exited");
      for (const cb of exitCbs) cb(code, stderr.trim());
    };
    child.on("exit", (code) => finish(code));
    child.on("error", (err) => {
      stderr += redactSecrets(err.message);
      finish(null);
    });

    const session: BroadcastSession = {
      write(chunk) {
        if (exited || child.stdin.writableEnded) return;
        child.stdin.write(chunk);
        armIdle();
      },
      stop() {
        clearTimeout(idleTimer);
        if (exited || child.stdin.writableEnded) return;
        child.stdin.end();
        // ffmpeg normally exits as soon as stdin closes; make sure it can't linger.
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
        killTimer.unref();
      },
      onExit(cb) {
        exitCbs.push(cb);
      },
      onIdle(cb) {
        idleCbs.push(cb);
      },
    };
    this.#session = session;
    this.#title = title;
    armIdle();
    log.info({ title }, "browser live: started");

    return session;
  }
}

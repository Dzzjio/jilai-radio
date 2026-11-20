#!/usr/bin/liquidsoap
# Radio Jil — one 24/7 stream, same for every listener.
#
# /music (shuffled, crossfaded) -> fallback jingle/silence -> blank -> Icecast /live
# Every track change is POSTed to the API so it can log history and push "now playing".

settings.log.stdout := true
settings.log.file := false
settings.log.level := 3

def env(name, default) =
  environment.get(default=default, name)
end

music_dir        = env("MUSIC_DIR", "/music")
fallback_dir     = env("FALLBACK_DIR", "/fallback")
api_url          = env("API_URL", "http://api:4000")
internal_secret  = env("INTERNAL_SECRET", "")
icecast_host     = env("ICECAST_HOST", "icecast")
icecast_port     = int_of_string(env("ICECAST_PORT", "8000"))
icecast_password = env("ICECAST_SOURCE_PASSWORD", "hackme")
icecast_mount    = env("ICECAST_MOUNT", "live")
station_name     = env("STATION_NAME", "Radio Jil")
station_desc     = env("STATION_DESCRIPTION", "24/7 online radio")
station_genre    = env("STATION_GENRE", "Various")
station_url      = env("STATION_URL", "http://localhost:3000")
bitrate          = int_of_string(env("STREAM_BITRATE", "128"))
crossfade_secs   = float_of_string(env("CROSSFADE_SECONDS", "5."))

# --- Sources -----------------------------------------------------------------

# Watch the folder: uploads/deletes are picked up without a restart.
# An empty folder makes this source unavailable, so the fallback below kicks in.
music = playlist(id="music", mode="randomize", reload_mode="watch", music_dir)
music = crossfade(duration=crossfade_secs, fade_in=crossfade_secs / 2., fade_out=crossfade_secs / 2., music)

# Prefer a jingle if one was provided, otherwise loop silence.
jingle_file = "#{fallback_dir}/jingle.mp3"
silence_file = "#{fallback_dir}/silence.mp3"
fallback_file = if file.exists(jingle_file) then jingle_file else silence_file end
emergency = single(id="fallback", fallback_file)

# mksafe adds generated blank audio as a last resort: the stream never drops.
radio = mksafe(fallback(id="radio", track_sensitive=false, [music, emergency]))

# --- Now playing hook --------------------------------------------------------

# Remembers whether the last notified item was the fallback, so a looping
# jingle/silence file is reported once instead of on every loop.
last_was_fallback = ref(false)

def send_now_playing(m, filename, is_fallback) =
  payload = json.stringify({
    title = m["title"],
    artist = m["artist"],
    album = m["album"],
    filename = filename,
    fallback = is_fallback
  })
  log.important(label="now_playing", "Track change: #{m['artist']} - #{m['title']} (#{filename})")
  try
    resp = http.post(
      timeout=5.,
      headers=[("Content-Type", "application/json"), ("X-Internal-Secret", internal_secret)],
      data=payload,
      "#{api_url}/internal/track-changed"
    )
    if resp.status_code != 200 and resp.status_code != 204 then
      log.important(label="now_playing", "API answered #{resp.status_code}")
    end
  catch err do
    log.important(label="now_playing", "API notify failed: #{err.message}")
  end
end


def notify_api(m) =
  filename = m["filename"]
  is_fallback = filename == "" or string.contains(prefix=fallback_dir, filename)
  if filename == "" and m["title"] == "" then
    # Empty metadata emitted during transitions: nothing to report.
    ()
  elsif is_fallback and last_was_fallback() then
    ()
  else
    last_was_fallback := is_fallback
    send_now_playing(m, filename, is_fallback)
  end
end

# synchronous=false: the callback runs in its own task, so a slow API never stalls audio.
radio.on_track(synchronous=false, notify_api)

# --- Output ------------------------------------------------------------------

output.icecast(
  %mp3(bitrate=bitrate, samplerate=44100, stereo=true),
  host=icecast_host,
  port=icecast_port,
  password=icecast_password,
  mount=icecast_mount,
  name=station_name,
  description=station_desc,
  genre=station_genre,
  url=station_url,
  public=false,
  radio
)

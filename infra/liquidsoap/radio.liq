#!/usr/bin/liquidsoap
# Radio Aha — one 24/7 stream, same for every listener.
#
# What plays, in priority order:
#   live      the live show, while a source is connected to the live input (port 8005, mount /live-in;
#             normally the API, streaming the admin's microphone from the browser)
#   repeat    after a show: its recording, on repeat (the API decides which file)
#   music     the library folder, shuffled and crossfaded
#   emergency silence/jingle, so the stream never drops (plus mksafe)
#
# The live input is also recorded to /recordings; each finished file is handed to the API,
# which saves it in the library and puts it on repeat.
# Every track change is POSTed to the API so it can log history and push "now playing".

settings.log.stdout := true
settings.log.file := false
settings.log.level := 3

def env(name, default) =
  environment.get(default=default, name)
end

music_dir        = env("MUSIC_DIR", "/music")
fallback_dir     = env("FALLBACK_DIR", "/fallback")
recordings_dir   = env("RECORDINGS_DIR", "/recordings")
api_url          = env("API_URL", "http://api:4000")
internal_secret  = env("INTERNAL_SECRET", "")
icecast_host     = env("ICECAST_HOST", "icecast")
icecast_port     = int_of_string(env("ICECAST_PORT", "8000"))
icecast_password = env("ICECAST_SOURCE_PASSWORD", "hackme")
icecast_mount    = env("ICECAST_MOUNT", "live")
station_name     = env("STATION_NAME", "Radio Aha")
station_desc     = env("STATION_DESCRIPTION", "24/7 online radio")
station_genre    = env("STATION_GENRE", "Various")
station_url      = env("STATION_URL", "http://localhost:3000")
bitrate          = int_of_string(env("STREAM_BITRATE", "128"))
crossfade_secs   = float_of_string(env("CROSSFADE_SECONDS", "5."))
live_port        = int_of_string(env("LIVE_PORT", "8005"))
live_mount       = env("LIVE_MOUNT", "live-in")
live_password    = env("LIVE_PASSWORD", "")

# No password configured → nobody can go live (an unguessable throwaway value is used).
live_password =
  if live_password == "" then
    log.critical(label="live", "LIVE_PASSWORD is not set: the live input is locked.")
    "locked-#{random.int(min=100000000, max=999999999)}-#{random.int(min=100000000, max=999999999)}-#{time()}"
  else
    live_password
  end

# --- API helper ---------------------------------------------------------------

def api_post(route, payload) =
  try
    resp = http.post(
      timeout=5.,
      headers=[("Content-Type", "application/json"), ("X-Internal-Secret", internal_secret)],
      data=payload,
      "#{api_url}#{route}"
    )
    if resp.status_code >= 300 then
      log.important(label="api", "#{route}: API answered #{resp.status_code}")
    end
  catch err do
    log.important(label="api", "#{route}: API unreachable: #{err.message}")
  end
end

# --- Repeat (after a show) ------------------------------------------------------

# Asks the API which file to repeat. The same file every time = a loop. Nothing → unavailable.
def next_repeat() =
  try
    resp = http.get(timeout=15., headers=[("X-Internal-Secret", internal_secret)], "#{api_url}/internal/repeat")
    if resp.status_code == 200 then
      let json.parse (data : {path: string}) = resp
      request.create(data.path)
    else
      null
    end
  catch err do
    log.important(label="repeat", "API unreachable: #{err.message}")
    null
  end
end

repeat_requests = request.dynamic(id="repeat", retry_delay=5., next_repeat)
repeat = crossfade(duration=crossfade_secs, fade_in=crossfade_secs / 2., fade_out=crossfade_secs / 2., repeat_requests)

# Right after a show the library is held back for a few seconds, so the new recording
# (registered ~1 s later) starts straight away instead of a library track sneaking in.
waiting_for_recording = ref(false)


# --- Live input ---------------------------------------------------------------

is_live = ref(false)

def on_live_connect(_) =
  is_live := true
  log.important(label="live", "DJ connected")
  # Drop any queued repeat (the previous show): after this show, its own recording comes next.
  repeat_requests.set_queue([])
  repeat.skip()
  thread.run(fun () -> api_post("/internal/live", json.stringify({live = true})))
end

def on_live_disconnect() =
  is_live := false
  waiting_for_recording := true
  thread.run(delay=12., fun () -> waiting_for_recording := false)
  log.important(label="live", "DJ disconnected")
  thread.run(fun () -> api_post("/internal/live", json.stringify({live = false})))
end

live = input.harbor(
  id="live",
  live_mount,
  port=live_port,
  user="source",
  password=live_password,
  buffer=2.,
  max=10.,
  on_connect=on_live_connect,
  on_disconnect=on_live_disconnect
)

# Titles the DJ sends from his app (show name, song titles) → now playing + history.
live.on_metadata(synchronous=false, fun (m) -> begin
  title = m["title"]
  if title != "" then
    api_post("/internal/track-changed", json.stringify({title = title, artist = m["artist"], album = "", filename = "", fallback = false, live = true}))
  end
end)

# Record the live input while it is connected: one file per connection, 320 kbps.
recorder = output.file(
  id="recorder",
  %mp3(bitrate=320, samplerate=44100, stereo=true),
  # A getter: evaluated each time a file is opened, so every connection gets its own file.
  {"#{recordings_dir}/live-#{int_of_float(time())}.mp3"},
  live,
  fallible=true,
  on_close=fun (f) -> thread.run(fun () -> begin
    log.important(label="live", "Recording closed: #{f}")
    api_post("/internal/live-recording", json.stringify({path = f}))
    waiting_for_recording := false
  end)
)

# --- Library ---------------------------------------------------------------------

# Watch the folder: uploads/deletes are picked up without a restart.
# An empty folder makes this source unavailable, so the fallback below kicks in.
music = playlist(id="music", mode="randomize", reload_mode="watch", music_dir)
music = crossfade(duration=crossfade_secs, fade_in=crossfade_secs / 2., fade_out=crossfade_secs / 2., music)
music = switch(id="library", track_sensitive=false, [({not waiting_for_recording()}, music)])

# Prefer a jingle if one was provided, otherwise loop silence.
jingle_file = "#{fallback_dir}/jingle.mp3"
silence_file = "#{fallback_dir}/silence.mp3"
fallback_file = if file.exists(jingle_file) then jingle_file else silence_file end
emergency = single(id="fallback", fallback_file)

# Short crossfade whenever the station switches source (into/out of live, into repeat).
def switch_fade(a, b) =
  add(normalize=false, [fade.in(duration=1.5, b), fade.out(duration=1.5, a)])
end

# mksafe adds generated blank audio as a last resort: the stream never drops.
radio = mksafe(fallback(
  id="radio",
  track_sensitive=false,
  transitions=[switch_fade, switch_fade, switch_fade, switch_fade],
  [live, repeat, music, emergency]
))

# --- Now playing hook ------------------------------------------------------------

# Remembers whether the last notified item was the fallback, so a looping
# jingle/silence file is reported once instead of on every loop.
last_was_fallback = ref(false)

def notify_api(m) =
  filename = m["filename"]
  is_fallback = filename != "" and string.contains(prefix=fallback_dir, filename)
  if is_live() then
    # Live titles are reported by live.on_metadata above.
    ()
  elsif filename == "" and m["title"] == "" then
    # Empty metadata emitted during transitions: nothing to report.
    ()
  elsif is_fallback and last_was_fallback() then
    ()
  else
    last_was_fallback := is_fallback
    log.important(label="now_playing", "Track change: #{m['artist']} - #{m['title']} (#{filename})")
    api_post("/internal/track-changed", json.stringify({
      title = m["title"],
      artist = m["artist"],
      album = m["album"],
      filename = filename,
      fallback = is_fallback,
      live = false
    }))
  end
end

# synchronous=false: the callback runs in its own task, so a slow API never stalls audio.
radio.on_track(synchronous=false, notify_api)

# --- Output ----------------------------------------------------------------------

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

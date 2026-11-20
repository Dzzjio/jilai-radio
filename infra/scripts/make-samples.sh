#!/usr/bin/env bash
# Generate short, tagged test loops in infra/music for local testing.
# They have a kick, bass, pad and hi-hats so the visualizer has something real to show.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/music"
DURATION="${1:-40}"
mkdir -p "$DIR"

make_loop() { # name title artist bpm root_hz
  local out="$DIR/$1.mp3" beat
  beat=$(awk -v b="$4" 'BEGIN { printf "%.4f", 60 / b }')
  local r="$5"
  local expr="0.55*sin(2*PI*(55+90*exp(-25*mod(t,$beat)))*t)*exp(-7*mod(t,$beat))"
  expr="$expr+0.18*sin(2*PI*$r*t)*(0.6+0.4*sin(2*PI*t/($beat*8)))"
  expr="$expr+0.10*sin(2*PI*$r*2.997*t)+0.08*sin(2*PI*$r*3.775*t)+0.07*sin(2*PI*$r*5.04*t)"
  expr="$expr+0.06*(random(0)*2-1)*exp(-40*mod(t+$beat/2,$beat/2))"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "aevalsrc='$expr':s=44100:d=$DURATION" -ac 2 \
    -af "highpass=f=25,alimiter=limit=0.9" -c:a libmp3lame -b:a 128k \
    -metadata title="$2" -metadata artist="$3" -metadata album="Test Loops" "$out"
  chmod 644 "$out"
  echo "created $out"
}

make_loop test-loop-1 "Night Bus Loop" "Sample Artist 1" 104 110
make_loop test-loop-2 "Copper Static Loop" "Sample Artist 2" 92 98
make_loop test-loop-3 "Low Orbit Loop" "Sample Artist 3" 120 130.81
make_loop test-loop-4 "Warm Frequency Loop" "Sample Artist 4" 84 87.31

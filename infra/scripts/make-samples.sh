#!/usr/bin/env bash
# Generate a few short, tagged test-tone MP3s in infra/music for local testing.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/music"
DURATION="${1:-40}"
mkdir -p "$DIR"
i=0
for freq in 220 330 440 550; do
  i=$((i + 1))
  out="$DIR/test-tone-$freq.mp3"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "sine=frequency=$freq:sample_rate=44100:duration=$DURATION" -ac 2 \
    -c:a libmp3lame -b:a 128k \
    -metadata title="Test Tone $freq Hz" -metadata artist="Sample Artist $i" -metadata album="Test Tones" \
    "$out"
  chmod 644 "$out"
  echo "created $out"
done

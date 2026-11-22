/** Station copy and facts, used for page text, metadata and JSON-LD. Edit freely. */
export const site = {
  name: "Radio Aha",
  shortName: "Aha",
  tagline: "Always on. Always together.",
  description:
    "Radio Aha is a free 24/7 online radio station. Press play and hear the same live stream as every other listener, wherever you are.",
  locale: "en_US",
  language: "en",
  genres: ["Eclectic", "Indie", "Electronic"],
  /** Facts about the broadcast chain (infra/liquidsoap/radio.liq). */
  stream: { format: "MP3", bitrateKbps: 128, sampleRateKhz: 44.1, crossfadeSeconds: 5 },
  about: [
    "Radio Aha is an independent online radio station that broadcasts around the clock. There are no playlists to pick and no skip button: like a real radio, everyone tunes in to the same live stream at the same moment, so when a song starts, it starts for all of us.",
    "Our rotation is hand-picked and shuffled continuously, with smooth crossfades between tracks. You can see what is on air right now, how many people are listening with you, and the last tracks that played.",
    "Listening is free and needs no account or app. Radio Aha works in any modern browser on your phone, tablet or computer. Just press play.",
  ],
} as const;

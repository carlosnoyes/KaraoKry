# KaraoKry song format (version 1)

V2 never reads UltraStar or any other karaoke format directly. Every song is converted into
the files below, so a licensed catalog can later be converted the same way without touching
the app. `v2/tools/publish.mjs` builds them, and `v2/tools/ultrastar.mjs` does the UltraStar
conversion.

All times are **milliseconds from the start of the audio file**.

## Where the files live

A private Cloudflare R2 bucket, `karaokry-songs`. Nothing in it is public; the app reads it
through the song server, a Worker at `https://karaokry-songs.karaokry.workers.dev`
(code in `v2/worker`).

### Reading the songs

1. `POST /api/session` with `{"code": "<access code>"}` returns
   `{"token": "…", "expiresAt": "…"}`. A token lasts 12 hours. A wrong code gets `403`, and
   too many sign-ins from one address in a minute get `429`.
2. Every file is at `/<bucket key>?t=<token>`, for example
   `/catalog/songs.json?t=…` or `/songs/usdb-56/audio.m4a?t=…`. Without a valid token the
   answer is `401`: get a new token and try again.

Audio supports `Range` requests, so an `<audio>` element given the URL starts playing at once
and can seek; every audio file keeps its index at the start. The catalog is sent with
`no-cache`; song files may be cached for a week (add `&v=<version>` from the catalog to get a
fresh copy after a song changes). Pages on `https://carlosnoyes.github.io` and on `localhost`
may read the files from scripts (CORS).

The access code is in `C:\Users\Carlos\KaraoKry-songs\secrets\worker-secrets.json`.

```
catalog/songs.json             every song, short entries for listing and picking
catalog/playlists.json         the playlists, each a list of song ids, best known first
songs/<id>/audio.m4a           the recording (AAC), vocals included
songs/<id>/lyrics.json         timed lyrics: lines, syllables, pitch
songs/<id>/meta.json           everything known about the song and its files
songs/<id>/cover.jpg           cover picture (usually 1000 px)
songs/<id>/cover-small.jpg     the same, 256 px wide, for lists
songs/<id>/ultrastar.txt       the original UltraStar file, kept so songs can be re-converted
```

Song ids say where a song came from: `usdb-56` is USDB song 56. Licensed songs will get their
own prefix.

## catalog/songs.json

```json
{ "format": "karaokry-catalog", "formatVersion": 1, "generated": "…", "songCount": 1092,
  "songs": [ {
    "id": "usdb-56", "title": "Black Velvet", "artist": "Alannah Myles", "year": 1989,
    "genre": "Rock", "durationMs": 290667, "duet": false,
    "previewStartMs": 12840,
    "loudnessLufs": -17.5,
    "fame": 790510,
    "playlists": [ { "id": "soft-rock", "fameRank": 33 } ],
    "audioBytes": 4755510,
    "version": "77ab8e945b2d7de2"
  } ] }
```

- `previewStartMs`: where a short preview should start: the file's own preview point, else its
  medley start, else the first sung note.
- `loudnessLufs`: EBU R128 integrated loudness. To play every song at the same volume, set the
  gain to `targetLufs - loudnessLufs` dB (for example a target of -14).
- `fame`: Deezer's popularity score; `fameRank` is the song's place in that playlist's ranking.
- `version`: changes whenever any of the song's files change. Use it to know when a song
  saved on the phone is out of date.

## catalog/playlists.json

```json
{ "format": "karaokry-playlists", "formatVersion": 1, "generated": "…",
  "playlists": [ { "id": "disney", "name": "Disney Classics", "songs": ["usdb-20598", "…"] } ] }
```

Only songs that are in the bucket are listed.

## songs/&lt;id&gt;/lyrics.json

```json
{ "format": "karaokry-lyrics", "formatVersion": 1, "id": "usdb-56",
  "singers": [ { "id": "P1", "name": null } ],
  "lines": [ {
    "singer": "P1", "start": 21912, "end": 24034, "breakAt": 24299,
    "text": "You can dance",
    "notes": [
      { "start": 21912, "end": 22221, "text": "You", "pitch": 73, "kind": "normal" },
      { "start": 22266, "end": 22487, "text": " ", "pitch": 71, "kind": "normal" }
    ]
  } ] }
```

- Lines are in time order, duets included; `singer` is `P1`, `P2` or `both`.
- `start`/`end` of a line are its first note's start and last note's end. `breakAt` is when the
  song file says the line should leave the screen (null for the last line).
- A note's `text` keeps its spaces: a trailing or leading space marks a word boundary, and
  joining a line's notes gives the line's words. An empty text is a held note.
- `pitch` is a MIDI note number (60 is middle C), for scoring how well someone sings.
- `kind` is `normal`, `golden` (bonus note), `freestyle` (not scored), `rap` or `rap-golden`
  (spoken, only the timing counts).

## songs/&lt;id&gt;/meta.json

Everything in the catalog entry, plus:

- `lyricsStartMs`, `lyricsEndMs`, `lineCount`, `noteCount`, `singers`, `hasGolden`, `hasRap`,
  `hasFreestyle`.
- `playStartMs` / `playEndMs`: where the song file says playback should start or stop, or null.
- `previewStartMs` (the file's own value, or null) and `medley` (`{ startMs, endMs }`, the
  part chosen for medleys, or null).
- `files`: each file's `key`, `bytes` and `sha256`. The audio also has `codec`, `sampleRate`,
  `channels`, `bitrate`, `durationMs`, `loudness` (`integratedLufs`, `rangeLu`, `truePeakDbfs`)
  and `vocals` (`included` for now; a future instrumental would say `removed`). Covers have
  `width` and `height`.
- `fame`, `source` (where the song came from: USDB id and link, the file's creator, edition,
  tags, rating and views) and `license`.

## License status

Every prototype song says `"license": { "status": "prototype-only", … }`. These songs are for
internal play-testing only and must be replaced by licensed recordings before any release.

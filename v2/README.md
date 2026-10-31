# KaraoKry V2: song catalog (prototype)

V2 plays karaoke tracks with timed lyrics instead of Spotify. For play-testing, the songs are
UltraStar songs from [USDB](https://usdb.animux.de), downloaded with USDB Syncer's own code.
They are for internal testing only and will be replaced by a licensed catalog.

**The song files are never in this repo.** They live on Carlos's PC in
`C:\Users\Carlos\KaraoKry-songs\songs`, one folder per song:

| File | What it is |
| --- | --- |
| `Artist - Title.txt` | UltraStar notes: every syllable with its start, length and pitch, plus `#GAP`, `#BPM` |
| `Artist - Title.m4a` | The song's audio |
| `Artist - Title [CO].jpg` | Cover picture |
| `*.usdb` | USDB Syncer's record of where everything came from |

## The catalog

| File | What it holds |
| --- | --- |
| `catalog/playlist-concepts.json` | The 20 playlists and the Deezer search words behind each |
| `catalog/playlists.json` | Each playlist's songs (USDB ids), best known first, up to 300 |
| `catalog/songs.json` | Every song once: artist, title, year, fame data, playlists, and its folder and files once downloaded |

"Best known" is Deezer's popularity score (`rank`), much like Spotify play counts. A song
can be in several playlists. Only English UltraStar songs are used.

## Rebuilding it

Run from the repo root. `<py>` is `C:/Users/Carlos/Tools/usdb-headless/.venv/Scripts/python.exe`
(Python with `usdb_syncer` installed), and FFmpeg must be on the PATH
(`C:/Users/Carlos/Tools/ffmpeg/bin`).

1. `node v2/tools/rank-deezer.mjs`: rank candidate songs for each playlist with Deezer's public API.
2. `node v2/tools/match-usdb.mjs`: match them to USDB, write `playlists.json`, `songs.json` and the download list.
3. `<py> v2/tools/usdb_download.py C:/Users/Carlos/KaraoKry-songs/.work/download-ids.json C:/Users/Carlos/KaraoKry-songs/songs --results C:/Users/Carlos/KaraoKry-songs/.work/download-results.json`:
   download notes, audio and covers (no video). It uses the USDB login saved in USDB Syncer
   and skips songs already on disk, so it can be stopped and started again.
4. `node v2/tools/refresh-catalog.mjs`: record each song's folder and files in `songs.json`.
5. `node v2/tools/publish.mjs --upload`: convert every downloaded song into KaraoKry's own
   format and upload it to the private Cloudflare R2 bucket `karaokry-songs`. Without
   `--upload` it only builds the files in `.work/publish`. It needs FFmpeg and a one-time
   `npx wrangler login`, and it only uploads files that changed since the last run.
   [SONG-FORMAT.md](SONG-FORMAT.md) describes every file.

`node --test v2/tests/ultrastar.test.mjs` tests the UltraStar conversion (`npm test` runs it too).

Working files (Deezer cache, download list, logs) are in `C:\Users\Carlos\KaraoKry-songs\.work`.

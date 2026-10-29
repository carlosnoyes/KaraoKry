# KaraoKry

**Sing it wrong.** A party game for friends: the singer hears one song in their headphones but sees the lyrics of a different song, and sings those wrong words to the tune. Everyone else guesses the real song and artist.

KaraoKry is an installable web app (PWA) for Chrome on Android. Music comes from Spotify and lyrics come from [LRCLIB](https://lrclib.net). There is no server: the files are hosted on GitHub Pages.

- Live site: <https://carlosnoyes.github.io/KaraoKry/>
- Full design: [`KaraoKry — Functional Spec.md`](KaraoKry%20—%20Functional%20Spec.md)

---

## Setup

Three one-time jobs need the owner's own accounts. Do them in this order.

### A. Publish the site on GitHub Pages (about 5 minutes)

1. The repository must be public. Free GitHub accounts can only use Pages with public repositories.
2. Push the project files to the `main` branch.
3. In the repository, open **Settings → Pages**. Under "Build and deployment", choose **Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
4. After a minute or two the site is live at `https://carlosnoyes.github.io/KaraoKry/`.

### B. Register the Spotify app (about 5 minutes)

1. Go to the Spotify Developer Dashboard at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and log in with a **Premium** account.
2. Create an app. Name: `KaraoKry`. Description: a short line such as "Party lyrics game for friends".
3. Redirect URIs, add both, exactly (including the capital letters and the final `/`):
   - `https://carlosnoyes.github.io/KaraoKry/`
   - `http://127.0.0.1:5500/` (for local testing)
4. Under the APIs used, tick **Web API** and **Web Playback SDK**.
5. Accept the terms and save. Copy the **Client ID**.
6. Paste the Client ID into [`config.js`](config.js) as `SPOTIFY_CLIENT_ID`, commit and push. A Client ID is not a secret and is safe in a public repository. There is no client secret in this app.

The Spotify app owner must keep Premium active, or KaraoKry stops working for everyone using that Client ID.

### C. Let friends log in (1 minute per friend)

1. In the dashboard, open the KaraoKry app, then **Settings → User Management**.
2. Add each friend's full name and the email address of their Spotify account.
3. The limit is **5 accounts in total**. The owner counts toward it if they log in themselves.
4. A friend can only host a game on their own phone if their Spotify is **Premium**. Friends without Premium can still sing on someone else's phone.

Anyone not on the list sees "You're not on the guest list yet" after logging in.

### D. Installing on an Android phone (each user)

1. Open `https://carlosnoyes.github.io/KaraoKry/` in Chrome.
2. Tap KaraoKry's own **Install KaraoKry** button on the welcome screen. It appears when Chrome offers installation.
3. If that button is missing, use Chrome's menu (three dots) and choose **Install app** or **Add to Home screen**.
4. KaraoKry then has its own icon and opens full-screen in portrait, like any app.
5. Updates arrive automatically. When a new version is deployed, the app shows "New version ready. Tap to refresh."

### App stores

KaraoKry is not in the Google Play Store. A web app on GitHub Pages is installed from Chrome instead, which looks and behaves like a store app. A Play Store listing would need a Trusted Web Activity wrapper (such as Bubblewrap), a paid Google Play developer account and Google's review, and it would not get around Spotify's 5-account limit.

### Friends beyond the 5-account limit

A friend with Premium can do step B themselves (same redirect URI), then paste their own Client ID into **Settings → Advanced → Use my own Spotify app (Client ID)** on their phone. Their app has its own allowance of 5 accounts.

---

## Playing

1. Log in with Spotify and pick one of **your own** playlists (Spotify does not let hobby apps read playlists you only follow; copy those songs into a playlist you made). Playlists with "karaokry" in their name are listed first.
2. KaraoKry drops podcasts, local files, duplicates and songs under a minute, then shuffles the rest once and locks the order. It only shows how many songs are ready.
3. It finds lyrics for the first few songs, which takes a second or two, and looks up the rest in the background during the game, always about 10 songs ahead. Songs with lyrics play first; songs without any wait at the back of the list.
4. Each round, the singer puts on the headphones and taps **I'm ready**. While song *k* plays, the screen shows the lyrics of song *k − 1* (song 1 gets the lyrics of the last song), with the title of the song they're hearing at the top. If song *k − 1* has no lyrics, the round borrows them from a song already played, the one shown least often.
5. The front camera films the singer and records their voice. The music is only in their headphones, so the recording is just their singing. A cyan ring around the selfie bubble swells with their voice, which shows the microphone hears them.
6. Tap **Got It!** when someone guesses. The replay fills the screen straight away, with the right answer across the top, and loops until you tap **Next singer**. **Save video** puts it in the phone's Downloads; **Share** opens Android's share sheet (Google Photos, WhatsApp...). A skipped song's recording is thrown away.

### Filming notes

- Videos are always upright portrait. KaraoKry draws the camera picture the way the screen shows it and records that, because Chrome on some Android phones otherwise records a wide strip or a sideways picture. It also asks for the front camera's full, uncropped picture (the widest view a web app can get), and the replay fills the screen, trimming a little off the sides. Phones' extra-wide selfie modes aren't available to web apps.

- The replay plays wherever the phone's sound goes. With the Bluetooth headphones still connected, that's the headphones: put them back in their case or switch them off and Android moves the sound to the phone speaker. A web app can't pick the speaker itself.
- KaraoKry records from the phone's own microphone. If the music in Bluetooth headphones still turns to phone-call quality while filming, open the phone's Bluetooth settings, tap the headphones and turn off **Calls**. **Settings → Recording** has a microphone picker, and a switch to turn filming off.
- No cyan ring while singing means the microphone hears nothing: check Android's **Microphone access** switch in quick settings. KaraoKry warns about this, and first tries the phone's default microphone by itself.
- Some phones claim to record MP4 with sound, then leave the sound out. KaraoKry checks the first second of every recording, and if the sound is missing it switches to WebM and remembers that for this phone. **Settings → Advanced → Debug info** shows the format, whether the recording contains sound, the microphone level and whether the replay had sound.
- Recordings stay on the phone and are deleted when the next round starts, unless you saved them. If the app was closed mid-round, that round has no replay and the answer card is shown instead.

Playback happens inside KaraoKry with Spotify's Web Playback SDK. If a phone can't do that (some Android DRM settings block it), KaraoKry switches to remote-controlling the Spotify app instead. You can choose in **Settings → Playback**.

---

## Development

No build step and no dependencies: plain HTML, CSS and JavaScript modules. You need [Node.js](https://nodejs.org) 20 or newer only for the local server and the tests.

```bash
npm run serve
```

Then open <http://127.0.0.1:5500/>. (Spotify only accepts `127.0.0.1` for local logins, not `localhost`.) On `127.0.0.1` the welcome screen also offers **Try the demo**, which plays through every game screen with made-up songs and no Spotify. The service worker is switched off on `127.0.0.1` so you always see your latest files.

```bash
npm test
```

Runs the automated tests (`node --test`): pairing and borrowed lyrics, shuffling, track filters, playlist sorting and paging, the background lyrics lookups, title and lyrics cleaning, instrumental stretches, the LRCLIB client, the Spotify API wrapper, end-of-song detection, the game state machine, and a check that the service worker caches every app file.

```bash
npm run icons
```

Re-renders the PNG icons from `icons/icon.svg` with headless Chrome or Edge.

### Deploying a change

1. Bump the version in **both** `config.js` (`APP_VERSION`) and `sw.js` (`VERSION`). The tests fail if they differ.
2. If you added a file under `js/`, `css/` or `icons/`, add it to the `SHELL` list in `sw.js` (the tests check this too).
3. Commit and push to `main`. GitHub Pages republishes within a minute or two, and installed apps offer the update.

### Project layout

```
index.html               the single page; each screen is a <section>
manifest.webmanifest     PWA manifest
sw.js                    service worker (app shell cache only)
config.js                Spotify Client ID and app version
css/app.css              design tokens and all styles
icons/                   icon.svg (master) and the PNG icons
js/
  main.js                boot: login redirect, resume, screens, window guard
  app.js                 flows shared by screens (after login, start, end, logout)
  router.js              one screen at a time; Android back button
  auth.js                PKCE login, tokens, refresh, logout
  spotify-api.js         every Spotify HTTP call (401 refresh, 429/5xx retries)
  playlists.js           list playlists, read playlist items
  prepare.js             filters, shuffle and lock, lyrics for the first songs
  lyrics.js              LRCLIB client, cleaning, LRC parsing, instrumental gaps
  lyrics-ahead.js        looks up lyrics a few songs ahead during the game
  game.js                game state machine, lyrics pairing and saved game (no DOM)
  storage.js             localStorage and IndexedDB helpers
  wake-lock.js           keeps the screen awake during a game
  pwa.js                 service worker, install prompt, update toast
  debug.js               Settings → Debug info
  playback/              engine interface, SDK engine, Spotify-app engine, manager
  ui/                    screens, lyrics view, scrub bar, dialogs, toasts, confetti...
  dev/demo.js            development-only demo game
tests/                   node --test suites
tools/                   local server and icon renderer
```

### Manual test on a phone

Make a playlist named "KaraoKry test" containing three well-known pop songs, one song with a long intro, one instrumental track, one podcast episode, the same song added twice, a song under 60 seconds, and one very obscure song. Then run a full game with Bluetooth headphones and work through the acceptance checklist in section 15.3 of the spec.

---

Lyrics come from a community database and are shown for private fun among friends. Please don't publish or promote KaraoKry beyond that.

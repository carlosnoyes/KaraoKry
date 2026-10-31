"""Downloads UltraStar songs from USDB without opening the USDB Syncer window.

Uses USDB Syncer's own download code and the USDB login saved in the syncer. For each
song it gets the notes and lyrics (.txt), the audio and the cover, but no video. Songs
already downloaded are skipped, so the script can be stopped and started again.
Settings changed here are temporary and leave the syncer's saved settings alone.

Run it with the Python that has usdb_syncer installed:

  C:/Users/Carlos/Tools/usdb-headless/.venv/Scripts/python.exe v2/tools/usdb_download.py \
      ids.json C:/Users/Carlos/KaraoKry-songs/songs --results results.json

ids.json is a JSON list of USDB song ids, in the order to download them.
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import sys
import time
from pathlib import Path

from PySide6 import QtCore
from usdb_syncer import SongId, db, events, settings, utils
from usdb_syncer import logger as syncer_logger
from usdb_syncer.song_loader import DownloadManager
from usdb_syncer.usdb_scraper import SessionManager
from usdb_syncer.usdb_song import DownloadStatus, UsdbSong

BATCH_SIZE = 24
REPORT_EVERY_MS = 60_000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("ids", type=Path, help="JSON list of USDB song ids")
    parser.add_argument("song_dir", type=Path, help="folder the songs are saved in")
    parser.add_argument("--results", type=Path, required=True, help="JSON file for each song's outcome")
    parser.add_argument("--log", type=Path, help="log file (default: next to --results)")
    parser.add_argument("--threads", type=int, default=4, help="songs downloaded at once")
    parser.add_argument("--min-free-gb", type=float, default=20, help="stop when the disk has less free space")
    return parser.parse_args()


def has_files(song: UsdbSong) -> bool:
    """True when the song's notes and audio are really on disk."""
    txt, audio = song.txt_path(), song.audio_path()
    return bool(song.is_local() and txt and txt.exists() and audio and audio.exists())


class Run:
    """Feeds songs to the syncer's DownloadManager a batch at a time."""

    def __init__(self, app: QtCore.QCoreApplication, args: argparse.Namespace, ids: list[int]) -> None:
        self.app = app
        self.args = args
        self.results: dict[str, str] = {}
        if args.results.exists():
            self.results = json.loads(args.results.read_text(encoding="utf-8"))
        self.queue: list[UsdbSong] = []
        for song_id in ids:
            song = UsdbSong.get(SongId(song_id))
            if song is None:
                self.results[str(song_id)] = "not on USDB"
            elif has_files(song):
                self.results[str(song_id)] = "downloaded"
            else:
                if song.is_local():
                    # Its folder was deleted: forget the old copy, or the download fails.
                    with db.transaction():
                        song.remove_sync_meta()
                self.queue.append(song)
        self.total = len(self.queue)
        self.pending: set[int] = set()
        self.done = 0
        self.started_at = time.monotonic()
        events.DownloadsFinished.subscribe(self.on_finished)
        self.timer = QtCore.QTimer()
        self.timer.timeout.connect(self.report)
        self.timer.start(REPORT_EVERY_MS)

    def free_gb(self) -> float:
        return shutil.disk_usage(self.args.song_dir).free / 1e9

    def start_batch(self) -> None:
        if not self.queue:
            self.finish("all songs handled")
            return
        if self.free_gb() < self.args.min_free_gb:
            self.finish(f"stopped: less than {self.args.min_free_gb:g} GB free on the disk")
            return
        batch, self.queue = self.queue[:BATCH_SIZE], self.queue[BATCH_SIZE:]
        self.pending = {int(song.song_id) for song in batch}
        DownloadManager.download(batch, utils.ProgressProxy(""))

    def on_finished(self, event: events.DownloadsFinished) -> None:
        UsdbSong.clear_cache()
        for song_id in event.song_ids:
            if int(song_id) not in self.pending:
                continue
            self.pending.discard(int(song_id))
            song = UsdbSong.get(song_id)
            if song is None:
                outcome = "deleted from USDB"
            elif song.status is DownloadStatus.SYNCHRONIZED and has_files(song):
                outcome = "downloaded"
            elif song.status is DownloadStatus.SYNCHRONIZED:
                outcome = "no audio"
            else:
                outcome = "failed"
            self.results[str(int(song_id))] = outcome
            self.done += 1
        self.save()
        if not self.pending:
            self.start_batch()

    def save(self) -> None:
        self.args.results.write_text(json.dumps(self.results, indent=1), encoding="utf-8")

    def report(self) -> None:
        counts: dict[str, int] = {}
        for outcome in self.results.values():
            counts[outcome] = counts.get(outcome, 0) + 1
        minutes = (time.monotonic() - self.started_at) / 60
        print(f"progress {self.done}/{self.total} in {minutes:.0f} min; {counts}; {self.free_gb():.0f} GB free", flush=True)

    def finish(self, reason: str) -> None:
        self.save()
        self.report()
        print(f"finished: {reason}", flush=True)
        self.timer.stop()
        QtCore.QTimer.singleShot(0, self.app.quit)


def main() -> None:
    args = parse_args()
    ids = [int(i) for i in json.loads(args.ids.read_text(encoding="utf-8"))]
    args.song_dir.mkdir(parents=True, exist_ok=True)
    log_file = args.log or args.results.with_suffix(".log")

    app = QtCore.QCoreApplication(sys.argv)
    # Same names as the syncer, so its saved login and settings are found.
    app.setOrganizationName("bohning")
    app.setApplicationName("usdb_syncer")
    utils.AppPaths.make_dirs()
    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    syncer_logger.configure_logging(file_handler, formatter=syncer_logger.DEBUG_FORMATTER)
    file_handler.setLevel(logging.INFO)

    settings.set_song_dir(args.song_dir.resolve(), temp=True)
    settings.set_audio(True, temp=True)
    settings.set_cover(True, temp=True)
    settings.set_throttling_threads(args.threads, temp=True)
    # The syncer ignores a temporary setting of False, so these are switched off here
    # instead. KaraoKry needs no video or background picture.
    settings.get_video = lambda: False
    settings.get_background = lambda: False
    # The browser choice the syncer saved can't be read outside its own bundle, so log in
    # with the saved username and password instead of browser cookies.
    settings.set_browser(settings.Browser.NONE, temp=True)

    db.connect(utils.AppPaths.db)
    SessionManager.session()
    if SessionManager.get_user() is None:
        print("finished: not logged in to USDB (USDB > USDB Login in the syncer)", flush=True)
        sys.exit(2)

    run = Run(app, args, ids)
    print(f"starting: {run.total} to download, {len(ids) - run.total} already handled", flush=True)
    QtCore.QTimer.singleShot(0, run.start_batch)
    app.exec()


if __name__ == "__main__":
    main()

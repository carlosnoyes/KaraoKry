// Reads an UltraStar song file (.txt) and turns it into KaraoKry's own lyrics format, with
// every time in milliseconds from the start of the audio. Keeping our own format means a
// licensed catalog can later be converted the same way, and the app never reads UltraStar.
//
// UltraStar basics: `#KEY:value` headers, then one line per note,
//   <kind> <startBeat> <lengthBeats> <pitch> <syllable>
// where kind is ":" normal, "*" golden, "F" freestyle, "R" rap, "G" golden rap.
// "- <beat>" ends a lyric line, "P1"/"P2" switch singer in duets, and "E" ends the song.
// A beat lasts 15000 / #BPM ms, and beat 0 is at #GAP ms.

const KINDS = { ':': 'normal', '*': 'golden', F: 'freestyle', R: 'rap', G: 'rap-golden' };
// UltraStar pitch 0 is middle C, which is MIDI note 60.
const MIDDLE_C = 60;

function number(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const n = Number(text.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Parses the file's text into its headers and raw notes, grouped into lines per singer. */
export function parseUltraStar(text) {
  const headers = {};
  const lines = [];
  let singer = 'P1';
  let current = null;
  let relativeOffset = 0;
  let relative = false;

  const endLine = (breakBeat) => {
    if (current?.notes.length) {
      current.breakBeat = breakBeat;
      lines.push(current);
    }
    current = null;
  };

  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    if (raw.startsWith('#')) {
      const at = raw.indexOf(':');
      if (at > 1) headers[raw.slice(1, at).trim().toUpperCase()] = raw.slice(at + 1).trim();
      if (/^yes$/i.test(headers.RELATIVE ?? '')) relative = true;
      continue;
    }
    const kind = raw[0];
    if (kind === 'E') break;
    if (kind === 'P') {
      endLine(null);
      const n = raw.slice(1).trim();
      singer = n === '3' ? 'both' : `P${n}`;
      continue;
    }
    if (kind === '-') {
      const [a, b] = raw.slice(1).trim().split(/\s+/).map(number);
      endLine(a == null ? null : a + relativeOffset);
      if (relative) relativeOffset += b ?? a ?? 0;
      continue;
    }
    if (!KINDS[kind]) continue;
    // The syllable is everything after the fourth field, spaces included: a trailing or
    // leading space marks the end or start of a word.
    const m = raw.match(/^.\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s?(.*)$/);
    if (!m) continue;
    current ??= { singer, notes: [] };
    current.notes.push({
      beat: Number(m[1]) + relativeOffset,
      length: Number(m[2]),
      pitch: Number(m[3]),
      text: m[4],
      kind: KINDS[kind],
    });
  }
  endLine(null);
  return { headers, lines };
}

/** Converts an UltraStar file into KaraoKry lyrics plus the facts the catalog needs. */
export function convertUltraStar(text) {
  const { headers, lines } = parseUltraStar(text);
  const bpm = number(headers.BPM);
  if (!bpm || bpm <= 0) throw new Error('The file has no usable #BPM');
  const gap = number(headers.GAP) ?? 0;
  const msPerBeat = 15000 / bpm;
  const ms = (beat) => Math.round(gap + beat * msPerBeat);

  const outLines = lines.map((line) => {
    const notes = line.notes.map((n) => ({
      start: ms(n.beat),
      end: ms(n.beat + n.length),
      // "~" marks a syllable held on to a new pitch; it isn't shown.
      text: n.text.replace(/~/g, ''),
      pitch: n.pitch + MIDDLE_C,
      kind: n.kind,
    }));
    return {
      singer: line.singer,
      start: notes[0].start,
      end: notes.at(-1).end,
      breakAt: line.breakBeat == null ? null : ms(line.breakBeat),
      text: notes.map((n) => n.text).join('').replace(/\s+/g, ' ').trim(),
      notes,
    };
  });
  // Duets list each singer's part separately; the app wants one timeline.
  outLines.sort((a, b) => a.start - b.start);

  const singerIds = [...new Set(outLines.map((l) => l.singer))].filter((s) => s !== 'both');
  const singers = singerIds.map((id) => ({
    id,
    name: headers[id] ?? headers[`DUETSINGER${id}`] ?? null,
  }));
  const allNotes = outLines.flatMap((l) => l.notes);
  const kinds = new Set(allNotes.map((n) => n.kind));
  const seconds = (key) => (number(headers[key]) == null ? null : Math.round(number(headers[key]) * 1000));
  const medleyStart = number(headers.MEDLEYSTARTBEAT);
  const medleyEnd = number(headers.MEDLEYENDBEAT);

  return {
    headers,
    lyrics: { singers, lines: outLines },
    facts: {
      duet: singers.length > 1,
      singers,
      lineCount: outLines.length,
      noteCount: allNotes.length,
      lyricsStartMs: allNotes[0]?.start ?? null,
      lyricsEndMs: allNotes.at(-1)?.end ?? null,
      hasGolden: kinds.has('golden') || kinds.has('rap-golden'),
      hasRap: kinds.has('rap') || kinds.has('rap-golden'),
      hasFreestyle: kinds.has('freestyle'),
      playStartMs: seconds('START'),
      playEndMs: number(headers.END) == null ? null : Math.round(number(headers.END)),
      previewStartMs: seconds('PREVIEWSTART'),
      medley: medleyStart == null || medleyEnd == null ? null : { startMs: ms(medleyStart), endMs: ms(medleyEnd) },
    },
  };
}

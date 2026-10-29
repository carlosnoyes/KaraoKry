import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseMimeType, chooseMicrophone, fileExtension, headerTracks, meterLevel, MIME_TYPES,
} from '../js/recording.js';

test('MP4 with AAC is preferred, then WebM, and an empty string lets the browser decide', () => {
  assert.equal(chooseMimeType(() => true), 'video/mp4;codecs=avc1,mp4a.40.2');
  assert.equal(chooseMimeType((type) => type.startsWith('video/webm')), 'video/webm;codecs=vp8,opus');
  assert.equal(chooseMimeType((type) => type === 'video/webm'), 'video/webm');
  assert.equal(chooseMimeType(() => false), '');
  assert.equal(chooseMimeType(() => { throw new Error('boom'); }), '');
  assert.ok(MIME_TYPES.every((type) => type.startsWith('video/')));
});

test('Opus sound inside MP4 comes after WebM, since phone galleries often play it silent', () => {
  const noAac = (type) => type !== 'video/mp4;codecs=avc1,mp4a.40.2';
  assert.equal(chooseMimeType(noAac), 'video/webm;codecs=vp8,opus');
  assert.equal(chooseMimeType((type) => type.startsWith('video/mp4') && noAac(type)), 'video/mp4;codecs=avc1,opus');
});

test('formats that recorded no sound on this phone are skipped', () => {
  assert.equal(chooseMimeType(() => true, ['video/mp4;codecs=avc1,mp4a.40.2']), 'video/webm;codecs=vp8,opus');
  assert.equal(chooseMimeType(() => true, MIME_TYPES), '');
});

const text = (s) => [...s].map((c) => c.charCodeAt(0));
const bytes = (...parts) => new Uint8Array(parts.flat());
// An MP4 'hdlr' box: size, type, version and flags, pre_defined, handler type, then padding.
const hdlr = (kind) => [0, 0, 0, 33, ...text('hdlr'), 0, 0, 0, 0, 0, 0, 0, 0, ...text(kind), 0, 0, 0, 0];
// A WebM CodecID element: ID 0x86, a one-byte length, the codec name.
const codecId = (name) => [0x86, 0x80 | name.length, ...text(name)];

test('headerTracks reads the tracks an MP4 header declares', () => {
  assert.deepEqual(headerTracks(bytes(text('ftypisom'), hdlr('vide'), hdlr('soun'), [0, 0, 0, 0])), { video: true, audio: true });
  assert.deepEqual(headerTracks(bytes(text('ftypisom'), hdlr('vide'), [0, 0, 0, 0])), { video: true, audio: false });
});

test('headerTracks reads the tracks a WebM header declares', () => {
  assert.deepEqual(headerTracks(bytes([0x1A, 0x45, 0xDF, 0xA3], codecId('V_VP8'), codecId('A_OPUS'), [0, 0, 0, 0, 0, 0, 0, 0])), { video: true, audio: true });
  assert.deepEqual(headerTracks(bytes([0x1A, 0x45, 0xDF, 0xA3], codecId('V_VP9'), [0, 0, 0, 0, 0, 0, 0, 0])), { video: true, audio: false });
});

test('headerTracks returns null while no header has arrived', () => {
  assert.equal(headerTracks(new Uint8Array(0)), null);
  assert.equal(headerTracks(bytes(text('mdat just some video data here'))), null);
});

test('meterLevel maps a peak sample to 0..1 on a decibel scale', () => {
  assert.equal(meterLevel(0), 0);
  assert.equal(meterLevel(null), 0);
  assert.equal(meterLevel(10 ** (-60 / 20)), 0);
  assert.equal(meterLevel(1), 1);
  assert.ok(Math.abs(meterLevel(10 ** (-28 / 20)) - 0.5) < 1e-9);
});

const androidMics = [
  { deviceId: 'default', label: 'Default' },
  { deviceId: 'a1', label: 'Speakerphone' },
  { deviceId: 'a2', label: 'Headset earpiece' },
  { deviceId: 'a3', label: 'Bluetooth headset' },
];

test('auto picks the phone microphone, never the Bluetooth one', () => {
  assert.equal(chooseMicrophone(androidMics, 'auto'), 'a1');
  assert.equal(chooseMicrophone([
    { deviceId: 'default', label: 'Default' },
    { deviceId: 'b1', label: 'Galaxy Buds2 Pro (Bluetooth)' },
    { deviceId: 'b2', label: 'Headset earpiece' },
  ], 'auto'), 'b2');
});

test('auto keeps the default when no Bluetooth mic is visible, or names are hidden', () => {
  assert.equal(chooseMicrophone([{ deviceId: 'x', label: 'USB audio' }], 'auto'), null);
  assert.equal(chooseMicrophone([{ deviceId: '', label: '' }, { deviceId: '', label: '' }], 'auto'), null);
  assert.equal(chooseMicrophone([], 'auto'), null);
});

test('"default" and explicit choices are respected', () => {
  assert.equal(chooseMicrophone(androidMics, 'default'), null);
  assert.equal(chooseMicrophone(androidMics, 'a3'), 'a3');
  assert.equal(chooseMicrophone(androidMics, 'gone'), null);
});

test('file extensions follow the recording format', () => {
  assert.equal(fileExtension('video/mp4;codecs=avc1,mp4a.40.2'), 'mp4');
  assert.equal(fileExtension('video/webm;codecs=vp8,opus'), 'webm');
  assert.equal(fileExtension(''), 'webm');
});

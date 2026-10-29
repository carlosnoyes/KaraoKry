import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseMimeType, chooseMicrophone, fileExtension, MIME_TYPES } from '../js/recording.js';

test('MP4 is preferred, WebM is the fallback, and an empty string lets the browser decide', () => {
  assert.equal(chooseMimeType(() => true), 'video/mp4;codecs=avc1,mp4a.40.2');
  assert.equal(chooseMimeType((type) => type.startsWith('video/webm')), 'video/webm;codecs=vp9,opus');
  assert.equal(chooseMimeType((type) => type === 'video/webm'), 'video/webm');
  assert.equal(chooseMimeType(() => false), '');
  assert.equal(chooseMimeType(() => { throw new Error('boom'); }), '');
  assert.ok(MIME_TYPES.every((type) => type.startsWith('video/')));
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

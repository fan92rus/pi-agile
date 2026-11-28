import test from 'node:test';
import assert from 'node:assert/strict';
import * as wave from '../lib/wave-overlap.mjs';

test('wave overlap module loads', () => {
  assert.equal(typeof wave, 'object');
});

test('waveA returns its success marker', () => {
  assert.equal(wave.waveA(), 'WAVE A OK');
});

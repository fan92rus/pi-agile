import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUnionConflicts, hasConflictMarkers } from '../docs/plans/taskflow-pilot/mvp/scripts/merge-resolution.mjs';

test('union resolver keeps both additive sides of a conflict', () => {
  const input = [
    '# file',
    '',
    'base',
    '<<<<<<< HEAD',
    'WAVE ONE OK',
    '=======',
    'WAVE TWO OK',
    '>>>>>>> tf-campaign/TEST-O2',
    '',
  ].join('\n');
  const output = resolveUnionConflicts(input);
  assert.equal(hasConflictMarkers(output), false);
  assert.match(output, /WAVE ONE OK/);
  assert.match(output, /WAVE TWO OK/);
  assert.equal(output.indexOf('WAVE ONE OK') < output.indexOf('WAVE TWO OK'), true);
});

test('union resolver preserves CRLF and removes duplicate lines', () => {
  const input = [
    '<<<<<<< HEAD',
    'same line',
    '=======',
    'same line',
    'other line',
    '>>>>>>> branch',
  ].join('\r\n');
  const output = resolveUnionConflicts(input);
  assert.match(output, /\r\n/);
  assert.equal(output.split(/\r?\n/).filter((line) => line === 'same line').length, 1);
  assert.match(output, /other line/);
});

test('union resolver leaves non-conflict content untouched', () => {
  const input = '# file\nbase\n';
  assert.equal(resolveUnionConflicts(input), input);
  assert.equal(hasConflictMarkers(input), false);
});

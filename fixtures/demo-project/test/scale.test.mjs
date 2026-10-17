import { test } from 'node:test'
import assert from 'node:assert/strict'
import { noteName, majorScale } from '../scale.mjs'

test('noteName uses scientific pitch octaves', () => {
  assert.equal(noteName(60), 'C4')
  assert.equal(noteName(69), 'A4')
})

test('majorScale has 7 notes', () => {
  assert.deepEqual(majorScale(60), [60, 62, 64, 65, 67, 69, 71])
})

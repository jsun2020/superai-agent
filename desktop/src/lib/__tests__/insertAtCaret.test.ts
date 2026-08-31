import { describe, expect, test } from 'bun:test'
import { insertAtCaret } from '../insertAtCaret'

describe('insertAtCaret', () => {
  test('inserts at the caret instead of appending', () => {
    // The case that motivated extracting this: dictating into the middle of a
    // half-typed message. Appending would put the words in the wrong place.
    const { next, caret } = insertAtCaret('please  the file', 7, 'summarise')
    expect(next).toBe('please summarise the file')
    // Caret sits after the dictated words so the next utterance continues here.
    expect(next.slice(0, caret)).toBe('please summarise')
  })

  test('never discards text the user already typed', () => {
    const current = 'keep every word of this'
    const { next } = insertAtCaret(current, 0, 'hello')
    for (const word of current.split(' ')) expect(next).toContain(word)
  })

  test('adds a separating space only where one is missing', () => {
    expect(insertAtCaret('hello', 5, 'world').next).toBe('hello world')
    // Already spaced: must not become a double space.
    expect(insertAtCaret('hello ', 6, 'world').next).toBe('hello world')
    // Empty field: no leading space.
    expect(insertAtCaret('', 0, 'world').next).toBe('world')
  })

  test('spaces on both sides when inserting between words', () => {
    expect(insertAtCaret('ab', 1, 'X').next).toBe('a X b')
  })

  test('ignores blank or whitespace-only speech', () => {
    // The recogniser emits an empty final for silence; that must not mutate the
    // composer or move the caret.
    expect(insertAtCaret('unchanged', 3, '   ')).toEqual({
      next: 'unchanged',
      caret: 3,
    })
  })

  test('trims the transcript rather than inserting its padding', () => {
    expect(insertAtCaret('', 0, '  hi there  ').next).toBe('hi there')
  })

  test('clamps a caret that is out of range', () => {
    // A caret captured before an external edit can point past the end.
    expect(insertAtCaret('abc', 99, 'X').next).toBe('abc X')
    expect(insertAtCaret('abc', -5, 'X').next).toBe('X abc')
  })
})

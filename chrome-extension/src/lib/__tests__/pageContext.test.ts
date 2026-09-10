import { describe, expect, test } from 'bun:test'
import {
  CONTEXT_CLOSE,
  CONTEXT_OPEN,
  DEFAULT_LIMITS,
  composeMessage,
  formatPageContext,
  isFailedRequest,
  summarizeSnapshot,
  type PageSnapshot,
} from '../pageContext'

const NOW = 1_000_000
const base: PageSnapshot = {
  url: 'https://myapp.local/checkout',
  title: 'Checkout',
  viewport: { width: 1280, height: 720 },
  capturedAt: NOW,
  console: [],
  network: [],
}

describe('formatPageContext', () => {
  test('a quiet page produces no block, so the user text goes out bare', () => {
    expect(formatPageContext(base, DEFAULT_LIMITS, NOW)).toBe('')
    expect(composeMessage('hello', '')).toBe('hello')
  })

  test('console errors and failed requests are listed with where and when', () => {
    const snap: PageSnapshot = {
      ...base,
      console: [{ level: 'error', text: 'TypeError: cart is undefined', ts: NOW - 5000, source: 'checkout.js:41:7' }],
      network: [{ method: 'POST', url: 'https://myapp.local/api/pay', status: 500, resourceType: 'xmlhttprequest', ts: NOW - 2000 }],
    }
    const block = formatPageContext(snap, DEFAULT_LIMITS, NOW)
    expect(block.startsWith(CONTEXT_OPEN)).toBe(true)
    expect(block.endsWith(CONTEXT_CLOSE)).toBe(true)
    expect(block).toContain('URL: https://myapp.local/checkout')
    expect(block).toContain('- [error] TypeError: cart is undefined (checkout.js:41:7) — 5s ago')
    expect(block).toContain('- POST https://myapp.local/api/pay → HTTP 500 [xmlhttprequest] — 2s ago')
  })

  test('successful requests are not reported; network errors are', () => {
    const snap: PageSnapshot = {
      ...base,
      network: [
        { method: 'GET', url: 'https://myapp.local/ok', status: 200, ts: NOW },
        { method: 'GET', url: 'https://api.local/x', error: 'net::ERR_CONNECTION_REFUSED', ts: NOW },
      ],
    }
    const block = formatPageContext(snap, DEFAULT_LIMITS, NOW)
    expect(block).not.toContain('/ok')
    expect(block).toContain('→ net::ERR_CONNECTION_REFUSED')
    expect(isFailedRequest({ status: 200 })).toBe(false)
    expect(isFailedRequest({ status: 404 })).toBe(true)
    expect(isFailedRequest({ error: 'net::ERR_FAILED' })).toBe(true)
  })

  test('a page that logs ten thousand errors yields a bounded block', () => {
    const snap: PageSnapshot = {
      ...base,
      console: Array.from({ length: 10_000 }, (_, i) => ({ level: 'error' as const, text: `boom ${i} ${'x'.repeat(2000)}`, ts: NOW })),
    }
    const block = formatPageContext(snap, DEFAULT_LIMITS, NOW)
    expect(block.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxTotalChars + 200)
    // Most recent entries win, and the omission is stated.
    expect(block).toContain('boom 9999')
    expect(block).not.toContain('boom 0 ')
    expect(block).toContain('9970 older omitted')
    // Each entry is clipped with the amount shown.
    expect(block).toMatch(/… \[\+\d+ chars\]/)
  })

  test('the selected element is included as HTML with its path', () => {
    const snap: PageSnapshot = {
      ...base,
      element: { path: 'main > form#pay > button.primary', outerHTML: '<button class="primary">Pay</button>', text: 'Pay' },
    }
    const block = formatPageContext(snap, DEFAULT_LIMITS, NOW)
    expect(block).toContain('Selected element: main > form#pay > button.primary')
    expect(block).toContain('```html\n<button class="primary">Pay</button>\n```')
  })

  test('composeMessage puts the block first and the user text last', () => {
    expect(composeMessage('  why?  ', '<page-debug-context>\nx\n</page-debug-context>')).toBe(
      '<page-debug-context>\nx\n</page-debug-context>\n\nwhy?',
    )
  })

  test('summary counts what will actually be sent, not what was captured', () => {
    const snap: PageSnapshot = {
      ...base,
      console: Array.from({ length: 50 }, () => ({ level: 'warn' as const, text: 'w', ts: NOW })),
      network: [{ method: 'GET', url: 'u', status: 404, ts: NOW }, { method: 'GET', url: 'v', status: 200, ts: NOW }],
      element: { path: 'p', outerHTML: '<p/>' },
    }
    expect(summarizeSnapshot(snap)).toBe('30 console, 1 failed request, element')
    expect(summarizeSnapshot(base)).toBe('')
  })
})

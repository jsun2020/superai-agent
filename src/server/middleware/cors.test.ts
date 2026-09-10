import { describe, expect, it } from 'bun:test'
import { corsHeaders } from './cors'

describe('corsHeaders', () => {
  it('allows localhost browser origins', () => {
    expect(corsHeaders('http://127.0.0.1:1420')['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:1420')
    expect(corsHeaders('http://localhost:3000')['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
  })

  it('allows tauri webview origins used in production builds', () => {
    expect(corsHeaders('http://tauri.localhost')['Access-Control-Allow-Origin']).toBe('http://tauri.localhost')
    expect(corsHeaders('https://tauri.localhost')['Access-Control-Allow-Origin']).toBe('https://tauri.localhost')
    expect(corsHeaders('tauri://localhost')['Access-Control-Allow-Origin']).toBe('tauri://localhost')
  })

  it('allows the SuperAI Agent Chrome extension origin, but only a well-formed one', () => {
    const id = 'abcdefghijklmnopabcdefghijklmnop' // 32 letters a-p, as Chrome mints them
    expect(corsHeaders(`chrome-extension://${id}`)['Access-Control-Allow-Origin']).toBe(`chrome-extension://${id}`)
    // Wrong length / characters are not extension ids and get the fallback.
    expect(corsHeaders('chrome-extension://short')['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
    expect(corsHeaders('chrome-extension://abcdefghijklmnopabcdefghijklmnoz')['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
  })

  it('falls back for unknown origins', () => {
    expect(corsHeaders('https://example.com')['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
    expect(corsHeaders(null)['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
  })
})

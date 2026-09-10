/**
 * CORS middleware for local desktop app communication
 */

// Localhost (http/https), Tauri WebView origins, and the "SuperAI Agent in
// Chrome" extension. Extension ids are 32 lowercase letters; the server binds
// loopback, so this only lets a browser-side client that already reached
// 127.0.0.1 read the responses it is served.
const ALLOWED_ORIGIN_RE =
  /^(?:https?:\/\/(?:localhost|127\.0\.0\.1|tauri\.localhost)(?::\d+)?|tauri:\/\/localhost|asset:\/\/localhost|chrome-extension:\/\/[a-p]{32})$/

export function corsHeaders(origin?: string | null): Record<string, string> {
  // Allow localhost origins (http/https), Tauri WebView origins, the Chrome extension
  const allowedOrigin =
    origin && ALLOWED_ORIGIN_RE.test(origin) ? origin : 'http://localhost:3000'
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  }
}

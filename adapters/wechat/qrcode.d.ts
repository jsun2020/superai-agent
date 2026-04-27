// Ambient type stub for the `qrcode` npm package — only the surface our
// wechat-login script uses. Avoids pulling in @types/qrcode just for two
// function signatures.
declare module 'qrcode' {
  type ToFileOptions = {
    width?: number
    margin?: number
    color?: { dark?: string; light?: string }
    errorCorrectionLevel?: 'low' | 'medium' | 'quartile' | 'high' | 'L' | 'M' | 'Q' | 'H'
  }
  type ToStringOptions = {
    type?: 'utf8' | 'svg' | 'terminal'
    small?: boolean
    margin?: number
    errorCorrectionLevel?: 'low' | 'medium' | 'quartile' | 'high' | 'L' | 'M' | 'Q' | 'H'
  }
  function toFile(path: string, text: string, options?: ToFileOptions): Promise<void>
  function toString(text: string, options?: ToStringOptions): Promise<string>
  const _default: { toFile: typeof toFile; toString: typeof toString }
  export default _default
  export { toFile, toString }
}

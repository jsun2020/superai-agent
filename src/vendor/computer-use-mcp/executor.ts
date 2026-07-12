export interface DisplayGeometry {
  id?: number
  displayId?: number
  width: number
  height: number
  scaleFactor: number
  originX: number
  originY: number
  isPrimary?: boolean
  name?: string
  label?: string
}

export interface ScreenshotResult {
  base64: string
  width: number
  height: number
  displayWidth: number
  displayHeight: number
  displayId?: number
  originX: number
  originY: number
}

export interface FrontmostApp {
  bundleId: string
  displayName: string
}

export interface RunningApp {
  bundleId: string
  displayName: string
}

export interface InstalledApp {
  bundleId: string
  displayName: string
  path: string
  iconDataUrl?: string
}

export interface ResolvePrepareCaptureResult extends ScreenshotResult {
  hidden: string[]
  display: DisplayGeometry
  resolvedDisplayId?: number
  captureError?: string
}

/** One interactive element from the OS accessibility tree. Coordinates are
 *  the element's center in logical points (virtual-screen origin) — the same
 *  space `click(x, y)` consumes. */
export interface UiElement {
  role: string
  name: string
  x: number
  y: number
  width: number
  height: number
}

export interface UiElementsResult {
  app: string
  windowTitle: string
  elements: UiElement[]
  truncated: boolean
}

export interface ComputerExecutor {
  capabilities: {
    screenshotFiltering: 'native' | 'none'
    platform: 'darwin' | 'win32'
    hostBundleId: string
    teachMode?: boolean
  }
  prepareForAction(allowlistBundleIds: string[], displayId?: number): Promise<string[]>
  previewHideSet(allowlistBundleIds: string[], displayId?: number): Promise<Array<{ bundleId: string; displayName: string }>>
  getDisplaySize(displayId?: number): Promise<DisplayGeometry>
  listDisplays(): Promise<DisplayGeometry[]>
  findWindowDisplays(bundleIds: string[]): Promise<Array<{ bundleId: string; displayIds: number[] }>>
  resolvePrepareCapture(opts: {
    allowedBundleIds: string[]
    preferredDisplayId?: number
    autoResolve: boolean
    doHide?: boolean
  }): Promise<ResolvePrepareCaptureResult>
  screenshot(opts: { allowedBundleIds: string[]; displayId?: number }): Promise<ScreenshotResult>
  zoom(
    regionLogical: { x: number; y: number; w: number; h: number },
    allowedBundleIds: string[],
    displayId?: number,
  ): Promise<{ base64: string; width: number; height: number }>
  key(keySequence: string, repeat?: number): Promise<void>
  holdKey(keyNames: string[], durationMs: number): Promise<void>
  type(text: string, opts: { viaClipboard: boolean }): Promise<void>
  click(
    x: number,
    y: number,
    button: 'left' | 'right' | 'middle',
    count: 1 | 2 | 3,
    modifiers?: string[],
  ): Promise<void>
  drag(
    from: { x: number; y: number } | undefined,
    to: { x: number; y: number },
  ): Promise<void>
  moveMouse(x: number, y: number): Promise<void>
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>
  mouseDown(): Promise<void>
  mouseUp(): Promise<void>
  getCursorPosition(): Promise<{ x: number; y: number }>
  /** Enumerate interactive UI elements of the focused window via the OS
   *  accessibility tree. Optional — only hosts with an accessibility bridge
   *  (Windows UIA) implement it; `read_ui_elements` is unlisted otherwise. */
  readUiElements?(opts: {
    filter?: string
    maxElements?: number
  }): Promise<UiElementsResult>
  getFrontmostApp(): Promise<FrontmostApp | null>
  appUnderPoint(x: number, y: number): Promise<{ bundleId: string; displayName: string } | null>
  listInstalledApps(): Promise<InstalledApp[]>
  getAppIcon?(path: string): Promise<string | undefined>
  listRunningApps(): Promise<RunningApp[]>
  openApp(bundleId: string): Promise<void>
  readClipboard(): Promise<string>
  writeClipboard(text: string): Promise<void>
}

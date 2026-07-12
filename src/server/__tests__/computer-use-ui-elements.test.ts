import { describe, expect, test } from 'bun:test'
import type {
  DisplayGeometry,
  ScreenshotResult,
  UiElement,
} from '../../vendor/computer-use-mcp/executor.js'
import { _test } from '../../vendor/computer-use-mcp/toolCalls.js'

const { uiElementToModelSpace, scaleCoord } = _test

const noopLogger = {
  silly: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const display: DisplayGeometry = {
  id: 0,
  displayId: 0,
  width: 2560,
  height: 1440,
  scaleFactor: 1.25,
  originX: 0,
  originY: 0,
}

// 2560x1440 display captured with the 1568-px long-edge downsample.
const shot: ScreenshotResult = {
  base64: '',
  width: 1568,
  height: 882,
  displayWidth: 2560,
  displayHeight: 1440,
  displayId: 0,
  originX: 0,
  originY: 0,
}

const el = (x: number, y: number, w = 200, h = 40): UiElement => ({
  role: 'Button',
  name: 'Save',
  x,
  y,
  width: w,
  height: h,
})

describe('uiElementToModelSpace', () => {
  test('pixels mode with screenshot: image-pixel transform, round-trips through scaleCoord', () => {
    const converted = uiElementToModelSpace(el(1280, 720), 'pixels', display, shot)
    expect(converted).not.toBeNull()
    expect(converted!.x).toBe(784) // 1280 * (1568/2560)
    expect(converted!.y).toBe(441) // 720 * (882/1440)

    // The whole point: clicking the returned coords resolves to the element.
    const clicked = scaleCoord(converted!.x, converted!.y, 'pixels', display, shot, noopLogger)
    expect(Math.abs(clicked.x - 1280)).toBeLessThanOrEqual(1)
    expect(Math.abs(clicked.y - 720)).toBeLessThanOrEqual(1)
  })

  test('pixels mode with screenshot: element on another monitor is dropped', () => {
    // Second monitor to the right of the captured one.
    expect(uiElementToModelSpace(el(3000, 500), 'pixels', display, shot)).toBeNull()
    expect(uiElementToModelSpace(el(-100, 500), 'pixels', display, shot)).toBeNull()
  })

  test('pixels mode cold start (no screenshot): inverts the /scaleFactor fallback', () => {
    const converted = uiElementToModelSpace(el(1000, 400), 'pixels', display, undefined)
    expect(converted).not.toBeNull()
    const clicked = scaleCoord(converted!.x, converted!.y, 'pixels', display, undefined, noopLogger)
    expect(Math.abs(clicked.x - 1000)).toBeLessThanOrEqual(1)
    expect(Math.abs(clicked.y - 400)).toBeLessThanOrEqual(1)
  })

  test('normalized_0_100 mode: percentages of the selected display', () => {
    const converted = uiElementToModelSpace(el(1280, 720), 'normalized_0_100', display, undefined)
    expect(converted).not.toBeNull()
    expect(converted!.x).toBe(50)
    expect(converted!.y).toBe(50)
    const clicked = scaleCoord(converted!.x, converted!.y, 'normalized_0_100', display, undefined, noopLogger)
    expect(Math.abs(clicked.x - 1280)).toBeLessThanOrEqual(1)
    expect(Math.abs(clicked.y - 720)).toBeLessThanOrEqual(1)
  })

  test('secondary display with virtual-screen origin offset round-trips', () => {
    const second: DisplayGeometry = { ...display, originX: 2560, originY: 0 }
    const secondShot: ScreenshotResult = { ...shot, originX: 2560, originY: 0 }
    const converted = uiElementToModelSpace(el(2560 + 640, 360), 'pixels', second, secondShot)
    expect(converted).not.toBeNull()
    const clicked = scaleCoord(converted!.x, converted!.y, 'pixels', second, secondShot, noopLogger)
    expect(Math.abs(clicked.x - (2560 + 640))).toBeLessThanOrEqual(1)
    expect(Math.abs(clicked.y - 360)).toBeLessThanOrEqual(1)
  })

  test('width/height are scaled into the same space', () => {
    const converted = uiElementToModelSpace(el(1280, 720, 400, 80), 'pixels', display, shot)
    expect(converted!.width).toBe(245) // 400 * (1568/2560)
    expect(converted!.height).toBe(49) // 80 * (882/1440)
  })
})

describe('windows python runtime', () => {
  test('requirements-win.txt includes uiautomation for read_ui_elements', async () => {
    const reqs = await Bun.file(
      new URL('../../../runtime/requirements-win.txt', import.meta.url),
    ).text()
    expect(reqs).toContain('uiautomation')
  })

  test('win_helper.py handles the ui_elements command', async () => {
    const helper = await Bun.file(
      new URL('../../../runtime/win_helper.py', import.meta.url),
    ).text()
    expect(helper).toContain('if command == "ui_elements":')
    expect(helper).toContain('def ui_elements(')
  })
})

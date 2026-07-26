import { describe, expect, test } from 'bun:test'
import { OFFICE_AGENT } from '../../tools/AgentTool/built-in/officeAgent.js'

describe('OFFICE_AGENT definition', () => {
  test('is a built-in agent named "office"', () => {
    expect(OFFICE_AGENT.agentType).toBe('office')
    expect(OFFICE_AGENT.source).toBe('built-in')
    expect(OFFICE_AGENT.baseDir).toBe('built-in')
  })

  test('has access to all tools (needs Bash/Read/Write for file processing)', () => {
    expect(OFFICE_AGENT.tools).toEqual(['*'])
  })

  test('whenToUse covers every requested file/media type', () => {
    const w = OFFICE_AGENT.whenToUse.toLowerCase()
    for (const kind of ['powerpoint', 'excel', 'word', 'pdf', 'photo', 'video']) {
      expect(w).toContain(kind)
    }
  })

  test('system prompt includes format-specific guidance and verification rule', () => {
    const prompt = OFFICE_AGENT.getSystemPrompt({
      toolUseContext: { options: {} },
    } as Parameters<typeof OFFICE_AGENT.getSystemPrompt>[0])
    for (const expected of [
      'python-pptx',
      'openpyxl',
      'rich_text=True',
      'python-docx',
      'PyMuPDF',
      'Pillow',
      'ffmpeg',
      'aspect ratio',
      'VERIFY',
    ]) {
      expect(prompt).toContain(expected)
    }
  })

  test('system prompt prefers OfficeCLI with detection, core commands, and fallback', () => {
    const prompt = OFFICE_AGENT.getSystemPrompt({
      toolUseContext: { options: {} },
    } as Parameters<typeof OFFICE_AGENT.getSystemPrompt>[0])
    for (const expected of [
      'officecli --version',
      'officecli load_skill',
      'view', // rendering/read commands
      'screenshot',
      'batch',
      'merge',
      '--json',
      'fall back', // graceful degradation to the Python toolbelt
      'npm install -g @officecli/officecli',
    ]) {
      expect(prompt).toContain(expected)
    }
  })

  test('system prompt includes workplace deliverable recipes', () => {
    const prompt = OFFICE_AGENT.getSystemPrompt({
      toolUseContext: { options: {} },
    } as Parameters<typeof OFFICE_AGENT.getSystemPrompt>[0])
    const lowered = prompt.toLowerCase()
    for (const expected of ['deck', 'template', 'analysis', 'organiz']) {
      expect(lowered).toContain(expected)
    }
  })

  test('system prompt demands render-based verification for formatted documents', () => {
    const prompt = OFFICE_AGENT.getSystemPrompt({
      toolUseContext: { options: {} },
    } as Parameters<typeof OFFICE_AGENT.getSystemPrompt>[0])
    expect(prompt.toLowerCase()).toContain('render')
    expect(prompt.toLowerCase()).toContain('extraction')
  })
})

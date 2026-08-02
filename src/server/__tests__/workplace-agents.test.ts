import { describe, expect, test } from 'bun:test'
import { ANALYST_AGENT } from '../../tools/AgentTool/built-in/analystAgent.js'
import { ASSISTANT_AGENT } from '../../tools/AgentTool/built-in/assistantAgent.js'
import { SALES_AGENT } from '../../tools/AgentTool/built-in/salesAgent.js'
import { OFFICE_AGENT } from '../../tools/AgentTool/built-in/officeAgent.js'
import { WORKPLACE_DELIVERY_RULES } from '../../tools/AgentTool/built-in/workplaceConventions.js'

const ROLE_AGENTS = [ASSISTANT_AGENT, SALES_AGENT, ANALYST_AGENT]

function promptOf(agent: typeof ASSISTANT_AGENT): string {
  return agent.getSystemPrompt({
    toolUseContext: { options: {} },
  } as Parameters<typeof agent.getSystemPrompt>[0])
}

describe('workplace role agents', () => {
  test('each is a built-in agent with the expected type', () => {
    expect(ASSISTANT_AGENT.agentType).toBe('assistant')
    expect(SALES_AGENT.agentType).toBe('sales')
    expect(ANALYST_AGENT.agentType).toBe('analyst')

    for (const agent of ROLE_AGENTS) {
      expect(agent.source).toBe('built-in')
      expect(agent.baseDir).toBe('built-in')
      // Workplace tasks need Bash/Read/Write plus the Agent tool to delegate
      // file mechanics to the office agent.
      expect(agent.tools).toEqual(['*'])
    }
  })

  test('agent types are unique and do not collide with the office agent', () => {
    const types = [...ROLE_AGENTS, OFFICE_AGENT].map((a) => a.agentType)
    expect(new Set(types).size).toBe(types.length)
  })

  test('every role carries the shared workplace delivery rules', () => {
    for (const agent of ROLE_AGENTS) {
      expect(promptOf(agent)).toContain(WORKPLACE_DELIVERY_RULES)
    }
  })

  test('the shared rules gate outbound actions, invention, and overwrites', () => {
    // These four are the promises the Work-mode product makes. If any of them
    // is edited away the role agents stop being safe to point at a real inbox.
    expect(WORKPLACE_DELIVERY_RULES).toContain('approval')
    expect(WORKPLACE_DELIVERY_RULES).toContain('Do not invent facts')
    expect(WORKPLACE_DELIVERY_RULES).toContain('in place')
    expect(WORKPLACE_DELIVERY_RULES).toContain('absolute path')
    expect(WORKPLACE_DELIVERY_RULES).toContain("'office' subagent")
  })

  test('prompts are ASCII-only (they travel through Windows CLI arguments)', () => {
    for (const agent of ROLE_AGENTS) {
      expect(promptOf(agent)).toMatch(/^[\x20-\x7E\n]*$/)
    }
    expect(WORKPLACE_DELIVERY_RULES).toMatch(/^[\x20-\x7E\n]*$/)
  })

  test('assistant covers inbox triage, calendar and meeting follow-through', () => {
    const prompt = promptOf(ASSISTANT_AGENT).toLowerCase()
    for (const expected of [
      'act now',
      'act later',
      'fyi',
      "user's own voice",
      'timezone',
      'action item',
      'phishing',
    ]) {
      expect(prompt).toContain(expected)
    }
    const when = ASSISTANT_AGENT.whenToUse.toLowerCase()
    for (const expected of ['inbox', 'calendar', 'meeting']) {
      expect(when).toContain(expected)
    }
  })

  test('sales separates facts from inferences and refuses to invent terms', () => {
    const prompt = promptOf(SALES_AGENT)
    expect(prompt).toContain('FACTS')
    expect(prompt).toContain('INFERENCES')
    // A fabricated price or delivery date creates a real obligation.
    expect(prompt).toContain('NEVER invent a commitment, a price, a discount')
    expect(prompt.toLowerCase()).toContain('crm')
    const when = SALES_AGENT.whenToUse.toLowerCase()
    for (const expected of ['account', 'follow-up', 'crm', 'pipeline']) {
      expect(when).toContain(expected)
    }
  })

  test('analyst leads with the finding and reports dropped rows', () => {
    const prompt = promptOf(ANALYST_AGENT)
    expect(prompt).toContain('Answer first')
    expect(prompt).toContain('as-of date')
    // Silently dropping rows is the most common way an analysis becomes wrong.
    expect(prompt).toContain('row count')
    expect(prompt).toContain('NEVER write over the raw data')
    const when = ANALYST_AGENT.whenToUse.toLowerCase()
    for (const expected of ['spreadsheet', 'report', 'metric']) {
      expect(when).toContain(expected)
    }
  })

  test('each whenToUse tells the model when NOT to pick it', () => {
    // Without a boundary the four workplace agents overlap and the model picks
    // arbitrarily between them.
    expect(ASSISTANT_AGENT.whenToUse).toContain("'office'")
    expect(ANALYST_AGENT.whenToUse).toContain('office')
  })
})

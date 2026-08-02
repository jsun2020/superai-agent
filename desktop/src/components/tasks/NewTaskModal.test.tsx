import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => {
    const translations: Record<string, string> = {
      'newTask.title': 'New Scheduled Task',
      'newTask.name': 'Name',
      'newTask.description': 'Description',
      'newTask.frequency': 'Frequency',
      'newTask.weekdays': 'Weekdays',
      'newTask.specificDays': 'Specific days',
      'newTask.daily': 'Daily',
      'taskTemplate.pickerLabel': 'Start from a template',
      'taskTemplate.morningBriefName': 'Morning brief',
      'taskTemplate.morningBriefDesc': 'A one-screen summary of the day',
      'taskTemplate.morningBriefPrompt': 'Prepare my morning brief for today.',
      'taskTemplate.weeklyReportName': 'Weekly report',
      'taskTemplate.weeklyReportDesc': 'The same report every Friday',
      'taskTemplate.weeklyReportPrompt': "Build this week's report.",
      'taskTemplate.inboxTriageName': 'Inbox triage',
      'taskTemplate.inboxTriageDesc': 'Sort the inbox',
      'taskTemplate.inboxTriagePrompt': 'Triage my inbox.',
    }
    return translations[key] ?? key
  },
}))

// The prompt editor pulls in model/provider selection, which is irrelevant here.
vi.mock('./PromptEditor', () => ({
  PromptEditor: ({ value }: { value: string }) => (
    <textarea data-testid="prompt-editor" value={value} readOnly />
  ),
}))
vi.mock('./DayOfWeekPicker', () => ({
  DayOfWeekPicker: () => <div data-testid="day-of-week-picker" />,
}))

import { NewTaskModal, WORK_TASK_TEMPLATES } from './NewTaskModal'
import { useUIStore } from '../../stores/uiStore'
import { useTaskStore } from '../../stores/taskStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useAdapterStore } from '../../stores/adapterStore'

describe('NewTaskModal work templates', () => {
  beforeEach(() => {
    useTaskStore.setState({
      createTask: vi.fn(),
      updateTask: vi.fn(),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)
    useSessionStore.setState({ sessions: [], activeSessionId: null })
    useAdapterStore.setState({
      config: {},
      fetchConfig: vi.fn(),
    } as Partial<ReturnType<typeof useAdapterStore.getState>>)
    useUIStore.setState({ appMode: 'work' })
  })

  it('offers a template for each shipped preset in Work mode', () => {
    render(<NewTaskModal open onClose={() => {}} />)

    expect(screen.getByTestId('work-task-templates')).toBeInTheDocument()
    for (const template of WORK_TASK_TEMPLATES) {
      expect(screen.getByTestId(`task-template-${template.id}`)).toBeInTheDocument()
    }
  })

  it('hides templates in Code mode', () => {
    // Code mode must look exactly as it did before this feature.
    useUIStore.setState({ appMode: 'code' })
    render(<NewTaskModal open onClose={() => {}} />)

    expect(screen.queryByTestId('work-task-templates')).not.toBeInTheDocument()
  })

  it('fills the form from the picked template', () => {
    render(<NewTaskModal open onClose={() => {}} />)

    fireEvent.click(screen.getByTestId('task-template-morningBrief'))

    expect(screen.getByDisplayValue('Morning brief')).toBeInTheDocument()
    expect(screen.getByDisplayValue('A one-screen summary of the day')).toBeInTheDocument()
    expect(screen.getByTestId('prompt-editor')).toHaveValue('Prepare my morning brief for today.')
    expect(screen.getByDisplayValue('08:30')).toBeInTheDocument()
  })

  it('schedules the weekly report on Friday afternoon', () => {
    render(<NewTaskModal open onClose={() => {}} />)

    fireEvent.click(screen.getByTestId('task-template-weeklyReport'))

    expect(screen.getByDisplayValue('16:00')).toBeInTheDocument()
    // specificDays + [5] is what buildCron turns into "0 16 * * 5".
    expect(screen.getByTestId('day-of-week-picker')).toBeInTheDocument()
  })

  it('every template carries a name, a description and a real prompt', () => {
    for (const template of WORK_TASK_TEMPLATES) {
      expect(template.nameKey).toBeTruthy()
      expect(template.descKey).toBeTruthy()
      expect(template.promptKey).toBeTruthy()
      expect(template.time).toMatch(/^\d{2}:\d{2}$/)
    }
    const weekly = WORK_TASK_TEMPLATES.find((tpl) => tpl.id === 'weeklyReport')
    expect(weekly?.frequency).toBe('specificDays')
    expect(weekly?.selectedDays).toEqual([5])
  })
})

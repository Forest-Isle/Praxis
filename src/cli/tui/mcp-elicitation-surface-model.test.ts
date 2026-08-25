import { describe, expect, it } from 'vitest'

import { createTuiElicitationForm } from './mcp-elicitation.js'
import { projectTuiElicitationSurface } from './mcp-elicitation-surface-model.js'

const baseRequest = {
  serverName: 'demo',
  message: 'Please continue',
  mode: 'url' as const,
  url: 'https://example.com/auth',
}

describe('projectTuiElicitationSurface', () => {
  it('projects URL state, action labels, and clamps selection', () => {
    const surface = projectTuiElicitationSurface({
      request: { ...baseRequest, elicitationId: 'elicit-1' },
      form: { focusIndex: 99 } as ReturnType<typeof createTuiElicitationForm>,
      input: '',
      urlWaiting: true,
    })
    expect(surface).toEqual({
      kind: 'elicitation-url',
      serverName: 'demo',
      message: 'Please continue',
      url: 'https://example.com/auth',
      waiting: true,
      actionLabel: 'Skip confirmation',
      selection: 0,
    })
  })

  it('projects URL selection one and the non-id action label', () => {
    const surface = projectTuiElicitationSurface({
      request: baseRequest,
      form: { focusIndex: 1 } as ReturnType<typeof createTuiElicitationForm>,
      input: '',
      urlWaiting: false,
    })
    expect(surface).toMatchObject({
      kind: 'elicitation-url',
      actionLabel: 'Continue without waiting',
      selection: 1,
    })
  })

  it('creates a form by default and preserves supplied form identity', () => {
    const request = {
      serverName: 'demo',
      message: 'Provide details',
      mode: 'form' as const,
      requestedSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
      },
    }
    const created = projectTuiElicitationSurface({
      request,
      input: 'draft',
      urlWaiting: false,
    })
    expect(created.kind).toBe('elicitation-form')
    if (created.kind === 'elicitation-form') {
      expect(created.state.fields[0]?.name).toBe('name')
      expect(created.input).toBe('draft')
      expect(created.maxVisibleFields).toBe(3)
      const supplied = createTuiElicitationForm(request.requestedSchema)
      const reused = projectTuiElicitationSurface({
        request,
        form: supplied,
        input: '',
        urlWaiting: false,
      })
      expect(reused.kind).toBe('elicitation-form')
      if (reused.kind === 'elicitation-form')
        expect(reused.state).toBe(supplied)
    }
  })

  it('projects deterministic visible-field budgets from viewport rows', () => {
    const request = {
      serverName: 'demo',
      message: 'Provide details',
      mode: 'form' as const,
    }
    const project = (viewportRows?: number) => {
      const surface = projectTuiElicitationSurface({
        request,
        input: '',
        urlWaiting: false,
        ...(viewportRows === undefined ? {} : { viewportRows }),
      })
      if (surface.kind !== 'elicitation-form') throw new Error('expected form')
      return surface.maxVisibleFields
    }
    expect(project(8)).toBe(2)
    expect(project()).toBe(3)
    expect(project(44)).toBe(10)
  })
})

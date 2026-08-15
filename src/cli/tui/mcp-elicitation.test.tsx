import { describe, expect, it } from 'vitest'

import {
  commitElicitationText,
  createTuiElicitationForm,
  elicitationFormIsValid,
  expandElicitationOptions,
  moveElicitationFocus,
  moveElicitationOption,
  selectElicitationOption,
  toggleElicitationBoolean,
  validateTuiElicitationForm,
} from './mcp-elicitation.js'

const schema = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      title: 'Display name',
      description: 'Shown in reports',
      minLength: 3,
    },
    count: { type: 'integer', minimum: 1, default: 2 },
    enabled: { type: 'boolean' },
    color: {
      type: 'string',
      enum: ['red', 'blue'],
      enumNames: ['Red', 'Blue'],
    },
    tags: {
      type: 'array',
      items: { type: 'string', enum: ['fast', 'safe'] },
      minItems: 1,
    },
  },
  required: ['name', 'enabled'],
}

describe('MCP elicitation form state', () => {
  it('projects primitive fields, defaults, titles, and required markers', () => {
    const form = createTuiElicitationForm(schema)
    expect(
      form.fields.map(({ name, kind, required }) => ({ name, kind, required })),
    ).toEqual([
      { name: 'name', kind: 'text', required: true },
      { name: 'count', kind: 'integer', required: false },
      { name: 'enabled', kind: 'boolean', required: true },
      { name: 'color', kind: 'enum', required: false },
      { name: 'tags', kind: 'multi-enum', required: false },
    ])
    expect(form.fields[0]).toMatchObject({
      title: 'Display name',
      description: 'Shown in reports',
    })
    expect(form.values).toEqual({ count: 2 })
  })

  it('validates text, integer, required, and multi-select constraints', () => {
    let form = createTuiElicitationForm(schema)
    form = commitElicitationText(form, 'ab')
    expect(form.errors.name).toBe('Must be at least 3 characters')
    form = commitElicitationText(form, 'Alice')
    form = moveElicitationFocus(form, 1)
    form = commitElicitationText(form, '1.5')
    expect(form.errors.count).toBe('Enter a whole number')
    form = moveElicitationFocus(form, 1)
    form = toggleElicitationBoolean(form)
    form = moveElicitationFocus(form, 1)
    form = moveElicitationFocus(form, 1)
    form = expandElicitationOptions(form)
    form = selectElicitationOption(form, false)
    form = validateTuiElicitationForm(form)
    expect(form.values).toMatchObject({
      name: 'Alice',
      count: '1.5',
      enabled: true,
      tags: ['fast'],
    })
    expect(elicitationFormIsValid(form)).toBe(false)
  })

  it('reports missing required values and focuses the first invalid field', () => {
    const form = validateTuiElicitationForm(createTuiElicitationForm(schema))
    expect(form.errors).toMatchObject({
      name: 'This field is required',
      enabled: 'This field is required',
    })
    expect(form.focusIndex).toBe(0)
  })

  it('supports titled oneOf and anyOf options', () => {
    const form = createTuiElicitationForm({
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          oneOf: [
            { const: 'quick', title: 'Quick mode' },
            { const: 'safe', title: 'Safe mode' },
          ],
        },
        scopes: {
          type: 'array',
          items: {
            anyOf: [
              { const: 'read', title: 'Read files' },
              { const: 'write', title: 'Write files' },
            ],
          },
        },
      },
    })

    expect(form.fields[0]?.options).toEqual([
      { value: 'quick', label: 'Quick mode' },
      { value: 'safe', label: 'Safe mode' },
    ])
    expect(form.fields[1]?.options).toEqual([
      { value: 'read', label: 'Read files' },
      { value: 'write', label: 'Write files' },
    ])
  })

  it('collapses accordions at the upper edge and advances at the lower edge', () => {
    let form = createTuiElicitationForm({
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['quick', 'safe'] },
        note: { type: 'string' },
      },
    })
    form = expandElicitationOptions(form)
    form = moveElicitationOption(form, -1)
    expect(form).toMatchObject({ focusIndex: 0, expandedField: undefined })

    form = expandElicitationOptions(form)
    form = moveElicitationOption(form, 1)
    form = moveElicitationOption(form, 1)
    expect(form).toMatchObject({ focusIndex: 1, expandedField: undefined })
  })

  it('validates defaults and common string formats immediately', () => {
    let form = createTuiElicitationForm({
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email', default: 'invalid' },
        homepage: { type: 'string', format: 'uri' },
        date: { type: 'string', format: 'date' },
      },
    })
    expect(form.errors.email).toContain('valid email address')
    form = moveElicitationFocus(form, 1)
    form = commitElicitationText(form, 'not a URL')
    expect(form.errors.homepage).toContain('valid URI')
    form = moveElicitationFocus(form, 1)
    form = commitElicitationText(form, '2026-02-30')
    expect(form.errors.date).toBe('Enter a date as YYYY-MM-DD')
  })
})

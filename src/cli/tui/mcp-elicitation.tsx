import { Box, Text } from 'ink'

export type TuiElicitationValue = string | number | boolean | string[]

interface PrimitiveSchema {
  type?: unknown
  title?: unknown
  description?: unknown
  default?: unknown
  enum?: unknown
  enumNames?: unknown
  oneOf?: unknown
  anyOf?: unknown
  items?: unknown
  minLength?: unknown
  maxLength?: unknown
  pattern?: unknown
  format?: unknown
  minimum?: unknown
  maximum?: unknown
  exclusiveMinimum?: unknown
  exclusiveMaximum?: unknown
  minItems?: unknown
  maxItems?: unknown
}

export interface TuiElicitationField {
  name: string
  title: string
  description: string | undefined
  required: boolean
  schema: PrimitiveSchema
  kind: 'text' | 'number' | 'integer' | 'boolean' | 'enum' | 'multi-enum'
  options: readonly { value: string; label: string }[]
}

export interface TuiElicitationFormState {
  fields: readonly TuiElicitationField[]
  values: Readonly<Record<string, TuiElicitationValue>>
  errors: Readonly<Record<string, string>>
  focusIndex: number
  expandedField: string | undefined
  optionIndex: number
  typeahead: string
  typeaheadAt: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function options(
  schema: PrimitiveSchema,
): readonly { value: string; label: string }[] {
  const titledOptions = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined
  if (titledOptions) {
    return titledOptions.flatMap((candidate) => {
      if (!record(candidate) || typeof candidate.const !== 'string') return []
      return [
        {
          value: candidate.const,
          label:
            typeof candidate.title === 'string'
              ? candidate.title
              : candidate.const,
        },
      ]
    })
  }
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum.filter((value): value is string => typeof value === 'string')
    : []
  const enumNames = Array.isArray(schema.enumNames)
    ? schema.enumNames.filter(
        (value): value is string => typeof value === 'string',
      )
    : []
  return enumValues.map((value, index) => ({
    value,
    label: enumNames[index] ?? value,
  }))
}

function fieldKind(
  schema: PrimitiveSchema,
): TuiElicitationField['kind'] | null {
  if (schema.type === 'array' && record(schema.items)) {
    return options(schema.items).length > 0 ? 'multi-enum' : null
  }
  if (options(schema).length > 0) return 'enum'
  if (schema.type === 'string') return 'text'
  if (schema.type === 'number') return 'number'
  if (schema.type === 'integer') return 'integer'
  if (schema.type === 'boolean') return 'boolean'
  return null
}

function validDefault(
  field: TuiElicitationField,
  value: unknown,
): TuiElicitationValue | undefined {
  if (field.kind === 'boolean')
    return typeof value === 'boolean' ? value : undefined
  if (field.kind === 'number' || field.kind === 'integer')
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined
  if (field.kind === 'multi-enum') {
    if (!Array.isArray(value)) return undefined
    const allowed = new Set(field.options.map((option) => option.value))
    const selected = value.filter(
      (item): item is string => typeof item === 'string' && allowed.has(item),
    )
    return selected
  }
  return typeof value === 'string' ? value : undefined
}

export function createTuiElicitationForm(
  requestedSchema: Record<string, unknown> | undefined,
): TuiElicitationFormState {
  const properties = record(requestedSchema?.properties)
    ? requestedSchema.properties
    : {}
  const required = new Set(
    Array.isArray(requestedSchema?.required)
      ? requestedSchema.required.filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
  )
  const fields = Object.entries(properties).flatMap(([name, value]) => {
    if (!record(value)) return []
    const schema = value as PrimitiveSchema
    const kind = fieldKind(schema)
    if (!kind) return []
    const optionSchema =
      kind === 'multi-enum' && record(schema.items)
        ? (schema.items as PrimitiveSchema)
        : schema
    return [
      {
        name,
        title: stringValue(schema.title) ?? name,
        description: stringValue(schema.description),
        required: required.has(name),
        schema,
        kind,
        options: options(optionSchema),
      } satisfies TuiElicitationField,
    ]
  })
  const values: Record<string, TuiElicitationValue> = {}
  const errors: Record<string, string> = {}
  for (const field of fields) {
    const value = validDefault(field, field.schema.default)
    if (value !== undefined) {
      values[field.name] = value
      if (['text', 'number', 'integer'].includes(field.kind)) {
        const error = validateText(field, String(value)).error
        if (error) errors[field.name] = error
      }
    }
  }
  return {
    fields,
    values,
    errors,
    focusIndex: fields.length > 0 ? 0 : fields.length,
    expandedField: undefined,
    optionIndex: 0,
    typeahead: '',
    typeaheadAt: 0,
  }
}

export function focusedElicitationField(
  state: TuiElicitationFormState,
): TuiElicitationField | undefined {
  return state.fields[state.focusIndex]
}

export function elicitationTextValue(state: TuiElicitationFormState): string {
  const field = focusedElicitationField(state)
  if (!field || !['text', 'number', 'integer'].includes(field.kind)) return ''
  const value = state.values[field.name]
  return value === undefined ? '' : String(value)
}

function withError(
  state: TuiElicitationFormState,
  name: string,
  error?: string,
): TuiElicitationFormState {
  const errors = { ...state.errors }
  if (error) errors[name] = error
  else delete errors[name]
  return { ...state, errors }
}

function validateText(
  field: TuiElicitationField,
  raw: string,
): { value?: TuiElicitationValue; error?: string } {
  const text = raw.trim()
  if (!text) {
    if (field.required) return { error: 'This field is required' }
    return {}
  }
  if (field.kind === 'number' || field.kind === 'integer') {
    const value = Number(text)
    if (!Number.isFinite(value))
      return { value: raw, error: 'Enter a valid number' }
    if (field.kind === 'integer' && !Number.isInteger(value))
      return { value: raw, error: 'Enter a whole number' }
    const minimum = finite(field.schema.minimum)
    const maximum = finite(field.schema.maximum)
    const exclusiveMinimum = finite(field.schema.exclusiveMinimum)
    const exclusiveMaximum = finite(field.schema.exclusiveMaximum)
    if (minimum !== undefined && value < minimum)
      return { value, error: `Must be at least ${minimum}` }
    if (maximum !== undefined && value > maximum)
      return { value, error: `Must be at most ${maximum}` }
    if (exclusiveMinimum !== undefined && value <= exclusiveMinimum)
      return { value, error: `Must be greater than ${exclusiveMinimum}` }
    if (exclusiveMaximum !== undefined && value >= exclusiveMaximum)
      return { value, error: `Must be less than ${exclusiveMaximum}` }
    return { value }
  }
  const minLength = finite(field.schema.minLength)
  const maxLength = finite(field.schema.maxLength)
  if (minLength !== undefined && raw.length < minLength)
    return { value: raw, error: `Must be at least ${minLength} characters` }
  if (maxLength !== undefined && raw.length > maxLength)
    return { value: raw, error: `Must be at most ${maxLength} characters` }
  const pattern = stringValue(field.schema.pattern)
  if (pattern) {
    try {
      if (!new RegExp(pattern, 'u').test(raw))
        return { value: raw, error: 'Does not match the required format' }
    } catch {
      return { value: raw, error: 'Invalid schema pattern' }
    }
  }
  const format = stringValue(field.schema.format)
  if (format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text))
    return {
      value: raw,
      error: 'Must be a valid email address, e.g. user@example.com',
    }
  if (format === 'uri') {
    try {
      new URL(text)
    } catch {
      return {
        value: raw,
        error: 'Must be a valid URI, e.g. https://example.com',
      }
    }
  }
  if (format === 'date' && !validIsoDate(text))
    return { value: raw, error: 'Enter a date as YYYY-MM-DD' }
  if (
    format === 'date-time' &&
    (!/^\d{4}-\d{2}-\d{2}T/u.test(text) || Number.isNaN(Date.parse(text)))
  )
    return { value: raw, error: 'Enter a valid date and time' }
  return { value: raw }
}

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

export function commitElicitationText(
  state: TuiElicitationFormState,
  raw: string,
): TuiElicitationFormState {
  const field = focusedElicitationField(state)
  if (!field || !['text', 'number', 'integer'].includes(field.kind))
    return state
  const preserveEmptyString =
    field.kind === 'text' &&
    field.schema.format === undefined &&
    raw.trim() === '' &&
    state.values[field.name] !== undefined
  const validation = preserveEmptyString
    ? { value: '' as const }
    : validateText(field, raw)
  const values = { ...state.values }
  if (validation.value === undefined) delete values[field.name]
  else values[field.name] = validation.value
  return withError({ ...state, values }, field.name, validation.error)
}

export function moveElicitationFocus(
  state: TuiElicitationFormState,
  direction: -1 | 1,
): TuiElicitationFormState {
  const count = state.fields.length + 2
  return {
    ...state,
    focusIndex: (state.focusIndex + count + direction) % count,
    expandedField: undefined,
    optionIndex: 0,
    typeahead: '',
  }
}

export function unsetElicitationField(
  state: TuiElicitationFormState,
): TuiElicitationFormState {
  const field = focusedElicitationField(state)
  if (!field) return state
  const values = { ...state.values }
  const errors = { ...state.errors }
  delete values[field.name]
  delete errors[field.name]
  return { ...state, values, errors }
}

export function toggleElicitationBoolean(
  state: TuiElicitationFormState,
): TuiElicitationFormState {
  const field = focusedElicitationField(state)
  if (!field || field.kind !== 'boolean') return state
  return withError(
    {
      ...state,
      values: {
        ...state.values,
        [field.name]: state.values[field.name] !== true,
      },
    },
    field.name,
  )
}

export function expandElicitationOptions(
  state: TuiElicitationFormState,
): TuiElicitationFormState {
  const field = focusedElicitationField(state)
  if (!field || !['enum', 'multi-enum'].includes(field.kind)) return state
  const current = state.values[field.name]
  const optionIndex =
    field.kind === 'enum' && typeof current === 'string'
      ? Math.max(
          0,
          field.options.findIndex((option) => option.value === current),
        )
      : 0
  return { ...state, expandedField: field.name, optionIndex }
}

export function moveElicitationOption(
  state: TuiElicitationFormState,
  direction: -1 | 1,
): TuiElicitationFormState {
  const field = focusedElicitationField(state)
  if (
    !field ||
    state.expandedField !== field.name ||
    field.options.length === 0
  )
    return state
  const nextIndex = state.optionIndex + direction
  if (nextIndex < 0)
    return validateSelectedField({ ...state, expandedField: undefined }, field)
  if (nextIndex >= field.options.length) {
    return moveElicitationFocus(
      validateSelectedField({ ...state, expandedField: undefined }, field),
      1,
    )
  }
  return {
    ...state,
    optionIndex: nextIndex,
  }
}

export function selectElicitationOption(
  state: TuiElicitationFormState,
  collapse: boolean,
  ensureSelected = false,
): TuiElicitationFormState {
  const field = focusedElicitationField(state)
  const option = field?.options[state.optionIndex]
  if (!field || !option || state.expandedField !== field.name) return state
  if (field.kind === 'multi-enum') {
    const selected = Array.isArray(state.values[field.name])
      ? (state.values[field.name] as string[])
      : []
    const next =
      selected.includes(option.value) && !ensureSelected
        ? selected.filter((value) => value !== option.value)
        : selected.includes(option.value)
          ? selected
          : [...selected, option.value]
    const values = { ...state.values }
    if (next.length > 0) values[field.name] = next
    else delete values[field.name]
    return validateSelectedField(
      {
        ...state,
        values,
        ...(collapse ? { expandedField: undefined } : {}),
      },
      field,
    )
  }
  return withError(
    {
      ...state,
      values: { ...state.values, [field.name]: option.value },
      ...(collapse ? { expandedField: undefined } : {}),
    },
    field.name,
  )
}

function validateSelectedField(
  state: TuiElicitationFormState,
  field: TuiElicitationField,
): TuiElicitationFormState {
  if (field.kind !== 'multi-enum') return state
  const value = state.values[field.name]
  const selected = Array.isArray(value) ? value : []
  const minItems = finite(field.schema.minItems)
  const maxItems = finite(field.schema.maxItems)
  let error: string | undefined
  if (field.required && selected.length === 0) {
    error = 'This field is required'
  } else if (
    minItems !== undefined &&
    selected.length < minItems &&
    (selected.length > 0 || field.required)
  ) {
    error = `Select at least ${minItems} item${minItems === 1 ? '' : 's'}`
  } else if (maxItems !== undefined && selected.length > maxItems) {
    error = `Select at most ${maxItems} item${maxItems === 1 ? '' : 's'}`
  }
  return withError(state, field.name, error)
}

export function typeaheadElicitationOption(
  state: TuiElicitationFormState,
  input: string,
  now = Date.now(),
): TuiElicitationFormState {
  const field = focusedElicitationField(state)
  if (!field || !['enum', 'multi-enum'].includes(field.kind)) return state
  const buffer =
    `${now - state.typeaheadAt > 2_000 ? '' : state.typeahead}${input}`.toLowerCase()
  const optionIndex = field.options.findIndex((option) =>
    option.label.toLowerCase().startsWith(buffer),
  )
  return {
    ...state,
    expandedField: field.name,
    typeahead: buffer,
    typeaheadAt: now,
    ...(optionIndex < 0 ? {} : { optionIndex }),
  }
}

export function validateTuiElicitationForm(
  state: TuiElicitationFormState,
): TuiElicitationFormState {
  let next = state
  for (const field of state.fields) {
    const value = next.values[field.name]
    let error = ['text', 'number', 'integer'].includes(field.kind)
      ? next.errors[field.name]
      : undefined
    if (
      field.required &&
      (value === undefined ||
        value === '' ||
        (Array.isArray(value) && value.length === 0))
    ) {
      error = 'This field is required'
    }
    if (field.kind === 'multi-enum' && Array.isArray(value)) {
      const minItems = finite(field.schema.minItems)
      const maxItems = finite(field.schema.maxItems)
      if (minItems !== undefined && value.length < minItems)
        error = `Select at least ${minItems} item${minItems === 1 ? '' : 's'}`
      else if (maxItems !== undefined && value.length > maxItems)
        error = `Select at most ${maxItems} item${maxItems === 1 ? '' : 's'}`
    }
    next = withError(next, field.name, error)
  }
  const firstInvalid = next.fields.findIndex((field) => next.errors[field.name])
  return firstInvalid < 0 ? next : { ...next, focusIndex: firstInvalid }
}

export function elicitationFormIsValid(
  state: TuiElicitationFormState,
): boolean {
  return (
    Object.keys(state.errors).length === 0 &&
    state.fields.every((field) => {
      if (!field.required) return true
      const value = state.values[field.name]
      return (
        value !== undefined &&
        value !== '' &&
        (!Array.isArray(value) || value.length > 0)
      )
    })
  )
}

function displayValue(
  field: TuiElicitationField,
  value: TuiElicitationValue | undefined,
): string {
  if (value === undefined) return 'not set'
  if (Array.isArray(value))
    return value
      .map(
        (item) =>
          field.options.find((option) => option.value === item)?.label ?? item,
      )
      .join(', ')
  if (typeof value === 'boolean') return value ? '☒' : '☐'
  if (field.kind === 'enum')
    return (
      field.options.find((option) => option.value === value)?.label ??
      String(value)
    )
  if (field.schema.format === 'date') {
    const parts = String(value).split('-')
    if (parts.length === 3) {
      const date = new Date(
        Number(parts[0]),
        Number(parts[1]) - 1,
        Number(parts[2]),
      )
      if (!Number.isNaN(date.getTime()))
        return date.toLocaleDateString('en-US', {
          weekday: 'short',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })
    }
  }
  if (field.schema.format === 'date-time') {
    const date = new Date(String(value))
    if (!Number.isNaN(date.getTime())) return date.toLocaleString('en-US')
  }
  return String(value)
}

export function McpElicitationUrl({
  serverName,
  message,
  url,
  waiting,
  actionLabel,
  selection,
  screenReader,
}: {
  serverName: string
  message: string
  url: string
  waiting: boolean
  actionLabel: string
  selection: number
  screenReader: boolean
}) {
  const title = waiting
    ? `MCP server “${serverName}” — waiting for completion`
    : `MCP server “${serverName}” wants to open a URL`
  let beforeDomain = ''
  let domain = url
  let afterDomain = ''
  try {
    const parsed = new URL(url)
    const start = url.indexOf(parsed.hostname)
    if (start >= 0) {
      beforeDomain = url.slice(0, start)
      domain = parsed.hostname
      afterDomain = url.slice(start + parsed.hostname.length)
    }
  } catch {
    // Render malformed server input verbatim; the opener remains user-gated.
  }

  return (
    <Box
      flexDirection="column"
      borderStyle={screenReader ? undefined : 'round'}
      borderColor="yellow"
      paddingX={screenReader ? 0 : 1}
      marginTop={1}
    >
      <Text bold>{title}</Text>
      <Text>{message}</Text>
      <Text> </Text>
      <Text>
        {beforeDomain}
        <Text bold>{domain}</Text>
        {afterDomain}
      </Text>
      {waiting ? (
        <>
          <Text> </Text>
          <Text dimColor italic>
            Waiting for the server to confirm completion…
          </Text>
          <Text>
            {selection === 0 ? '›' : ' '}{' '}
            <Text bold={selection === 0}>Reopen URL</Text>
            {'  '}
            {selection === 1 ? '›' : ' '}{' '}
            <Text bold={selection === 1}>{actionLabel}</Text>
          </Text>
        </>
      ) : (
        <Text>
          {selection === 0 ? '›' : ' '}{' '}
          <Text bold={selection === 0}>Accept</Text>
          {'  '}
          {selection === 1 ? '›' : ' '}{' '}
          <Text bold={selection === 1}>Decline</Text>
        </Text>
      )}
      <Text dimColor>Esc cancel · ←→ switch</Text>
    </Box>
  )
}

export function McpElicitationForm({
  serverName,
  message,
  state,
  input,
  screenReader,
}: {
  serverName: string
  message: string
  state: TuiElicitationFormState
  input: string
  screenReader: boolean
}) {
  const field = focusedElicitationField(state)
  const maxVisibleFields = Math.max(
    2,
    Math.floor(((process.stdout.rows ?? 24) - 14) / 3),
  )
  const focusForWindow = Math.min(
    state.focusIndex,
    Math.max(0, state.fields.length - 1),
  )
  let windowStart = Math.max(
    0,
    focusForWindow - Math.floor(maxVisibleFields / 2),
  )
  const windowEnd = Math.min(
    state.fields.length,
    windowStart + maxVisibleFields,
  )
  windowStart = Math.max(0, windowEnd - maxVisibleFields)
  const visibleFields = state.fields.slice(windowStart, windowEnd)
  return (
    <Box
      flexDirection="column"
      borderStyle={screenReader ? undefined : 'round'}
      borderColor="yellow"
      paddingX={screenReader ? 0 : 1}
      marginTop={1}
    >
      <Text bold>MCP server “{serverName}” requests your input</Text>
      <Text>{message}</Text>
      <Text> </Text>
      {windowStart > 0 ? (
        <Text dimColor> ↑ {windowStart} more above</Text>
      ) : null}
      {visibleFields.map((candidate, visibleIndex) => {
        const index = windowStart + visibleIndex
        const active = index === state.focusIndex
        const value = state.values[candidate.name]
        const expanded = state.expandedField === candidate.name
        return (
          <Box key={candidate.name} flexDirection="column">
            <Text
              bold={active}
              {...(state.errors[candidate.name]
                ? { color: 'red' }
                : active
                  ? { color: 'yellow' }
                  : {})}
            >
              {active ? '›' : ' '}{' '}
              {value !== undefined ? '✓' : candidate.required ? '*' : ' '}{' '}
              {candidate.title}:{' '}
              {active && ['text', 'number', 'integer'].includes(candidate.kind)
                ? input || 'Type something…'
                : displayValue(candidate, value)}
            </Text>
            {expanded
              ? candidate.options.map((option, optionIndex) => {
                  const selected = Array.isArray(value)
                    ? value.includes(option.value)
                    : value === option.value
                  return (
                    <Text key={option.value}>
                      {'    '}
                      {optionIndex === state.optionIndex ? '›' : ' '}{' '}
                      {candidate.kind === 'multi-enum'
                        ? selected
                          ? '☒'
                          : '☐'
                        : selected
                          ? '◉'
                          : '○'}{' '}
                      {option.label}
                    </Text>
                  )
                })
              : null}
            {candidate.description ? (
              <Text dimColor> {candidate.description}</Text>
            ) : null}
            {state.errors[candidate.name] ? (
              <Text color="red"> {state.errors[candidate.name]}</Text>
            ) : null}
          </Box>
        )
      })}
      {windowEnd < state.fields.length ? (
        <Text dimColor>
          {'  '}↓ {state.fields.length - windowEnd} more below
        </Text>
      ) : null}
      <Text bold={state.focusIndex === state.fields.length}>
        {state.focusIndex === state.fields.length ? '›' : ' '} Accept
      </Text>
      <Text bold={state.focusIndex === state.fields.length + 1}>
        {state.focusIndex === state.fields.length + 1 ? '›' : ' '} Decline
      </Text>
      <Text dimColor>
        Esc cancel · ↑↓ navigate
        {field?.kind === 'boolean' ? ' · Space toggle' : ''}
        {field && ['enum', 'multi-enum'].includes(field.kind)
          ? state.expandedField
            ? ' · Space select'
            : ' · → expand'
          : ''}
      </Text>
    </Box>
  )
}

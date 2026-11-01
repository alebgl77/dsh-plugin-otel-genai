import { describe, expect, test } from 'vitest'
import {
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
  type DataPoint,
  type Histogram,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics'
import {
  createGenAiMetrics,
  METRIC_DSH_GENAI_CLIENT_TOKEN_CACHE_READ,
  METRIC_DSH_GENAI_CLIENT_TOKEN_REASONING,
  type Config,
  type SessionEventLike,
  type SessionLike,
} from '../src/index.ts'

const CONFIG: Config = { exporter: { url: 'http://unused.invalid/v1/metrics' } }

function harness(config: Partial<Config> = {}) {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })
  const { recorder, shutdown } = createGenAiMetrics({ ...CONFIG, ...config }, { metricReader: reader })

  async function collect(): Promise<Pick<ResourceMetrics, 'scopeMetrics'>> {
    await reader.forceFlush()
    const batches = exporter.getMetrics()
    // The SDK exports no batch at all when nothing was recorded.
    return batches[batches.length - 1] ?? { scopeMetrics: [] }
  }

  function points(rm: Pick<ResourceMetrics, 'scopeMetrics'>, metricName: string): DataPoint<Histogram>[] {
    for (const scope of rm.scopeMetrics) {
      for (const metric of scope.metrics) {
        if (metric.descriptor.name === metricName) return metric.dataPoints as DataPoint<Histogram>[]
      }
    }
    return []
  }

  return { recorder, shutdown, collect, points }
}

const session: SessionLike = { id: 'session-1', firstLiveSeq: 0 }

function route(seq: number, provider = 'deepseek', model = 'deepseek-chat'): SessionEventLike {
  return { type: 'request/context', seq, time: 1_000, data: { provider, model } }
}

function stepStart(seq: number, time: number, turn = 1, step = 1): SessionEventLike {
  return { type: 'step/start', seq, time, data: { turn, step } }
}

function assistant(
  seq: number,
  time: number,
  usage: Record<string, number> | undefined,
  turn = 1,
  step = 1,
): SessionEventLike {
  return { type: 'assistant/message', seq, time, data: usage === undefined ? { turn, step } : { turn, step, usage } }
}

describe('GenAiMetricsRecorder', () => {
  test('records billed input and output tokens with GenAI attributes', async () => {
    const h = harness()
    h.recorder.observe(session, route(1))
    h.recorder.observe(session, stepStart(2, 10_000))
    h.recorder.observe(session, assistant(3, 12_500, {
      inputTokens: 100, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 0, reasoningTokens: 15,
    }))

    const rm = await h.collect()
    const usage = h.points(rm, 'gen_ai.client.token.usage')
    const byType = Object.fromEntries(usage.map(p => [p.attributes['gen_ai.token.type'], p]))

    expect(byType['input']?.value.sum).toBe(1_000)
    expect(byType['output']?.value.sum).toBe(40)
    expect(byType['input']?.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'deepseek',
      'gen_ai.request.model': 'deepseek-chat',
    })
    expect(byType['input']?.attributes['gen_ai.conversation.id']).toBeUndefined()

    const duration = h.points(rm, 'gen_ai.client.operation.duration')
    expect(duration[0]?.value.sum).toBeCloseTo(2.5)

    expect(h.points(rm, METRIC_DSH_GENAI_CLIENT_TOKEN_CACHE_READ)[0]?.value.sum).toBe(900)
    expect(h.points(rm, METRIC_DSH_GENAI_CLIENT_TOKEN_REASONING)[0]?.value.sum).toBe(15)
    await h.shutdown()
  })

  test('skips seeded events so a resumed session is not billed twice', async () => {
    const h = harness()
    const resumed: SessionLike = { id: 'session-2', firstLiveSeq: 10 }
    h.recorder.observe(resumed, route(1))
    h.recorder.observe(resumed, assistant(3, 2_000, { inputTokens: 500, outputTokens: 500 }))
    h.recorder.observe(resumed, route(10))
    h.recorder.observe(resumed, assistant(12, 3_000, { inputTokens: 7, outputTokens: 3 }))

    const rm = await h.collect()
    const usage = h.points(rm, 'gen_ai.client.token.usage')
    const total = usage.reduce((sum, p) => sum + p.value.sum!, 0)
    expect(total).toBe(10)
    await h.shutdown()
  })

  test('records nothing for a message without usage and no duration without a step start', async () => {
    const h = harness()
    h.recorder.observe(session, route(1))
    h.recorder.observe(session, assistant(2, 5_000, undefined))

    const rm = await h.collect()
    expect(h.points(rm, 'gen_ai.client.token.usage')).toHaveLength(0)
    expect(h.points(rm, 'gen_ai.client.operation.duration')).toHaveLength(0)
    await h.shutdown()
  })

  test('applies providerNameMap and includeConversationId', async () => {
    const h = harness({ providerNameMap: { 'deepseek-eu': 'deepseek' }, includeConversationId: true })
    h.recorder.observe(session, route(1, 'deepseek-eu', 'deepseek-reasoner'))
    h.recorder.observe(session, assistant(2, 1_000, { inputTokens: 1, outputTokens: 1 }))

    const rm = await h.collect()
    const point = h.points(rm, 'gen_ai.client.token.usage')[0]
    expect(point?.attributes['gen_ai.provider.name']).toBe('deepseek')
    expect(point?.attributes['gen_ai.request.model']).toBe('deepseek-reasoner')
    expect(point?.attributes['gen_ai.conversation.id']).toBe('session-1')
    await h.shutdown()
  })

  test('uses unknown when no route was observed before the first message', async () => {
    const h = harness()
    h.recorder.observe(session, assistant(1, 1_000, { inputTokens: 2, outputTokens: 2 }))
    const rm = await h.collect()
    const point = h.points(rm, 'gen_ai.client.token.usage')[0]
    expect(point?.attributes['gen_ai.provider.name']).toBe('unknown')
    expect(point?.attributes['gen_ai.request.model']).toBe('unknown')
    await h.shutdown()
  })

  test('forget drops per-session state', async () => {
    const h = harness()
    h.recorder.observe(session, route(1))
    h.recorder.observe(session, stepStart(2, 1_000))
    h.recorder.forget(session.id)
    h.recorder.observe(session, assistant(3, 4_000, { inputTokens: 1, outputTokens: 1 }))

    const rm = await h.collect()
    expect(h.points(rm, 'gen_ai.client.operation.duration')).toHaveLength(0)
    expect(h.points(rm, 'gen_ai.client.token.usage')[0]?.attributes['gen_ai.request.model']).toBe('unknown')
    await h.shutdown()
  })

  test('keeps interleaved sessions, turns and steps independent', async () => {
    const h = harness({ includeConversationId: true })
    const other: SessionLike = { id: 'session-2' }
    try {
      h.recorder.observe(session, stepStart(1, 0))
      h.recorder.observe(other, stepStart(1, 1_000))
      h.recorder.observe(session, stepStart(2, 2_000, 1, 2))
      h.recorder.observe(session, stepStart(3, 3_000, 2, 1))
      h.recorder.observe(other, stepStart(2, 4_000, 2, 1))
      h.recorder.observe(session, assistant(4, 4_500, undefined, 2, 1))
      h.recorder.observe(other, assistant(3, 3_000, undefined))
      h.recorder.observe(session, assistant(5, 2_500, undefined, 1, 2))
      h.recorder.observe(session, assistant(6, 500, undefined))
      h.recorder.observe(other, assistant(4, 6_500, undefined, 2, 1))

      const durations = h.points(await h.collect(), 'gen_ai.client.operation.duration')
      const bySession = Object.fromEntries(durations.map(p => [p.attributes['gen_ai.conversation.id'], p.value]))
      expect(bySession[session.id]).toMatchObject({ count: 3, sum: 2.5 })
      expect(bySession[other.id]).toMatchObject({ count: 2, sum: 4.5 })
    } finally {
      await h.shutdown()
    }
  })

  test('forget removes only the exact session, including abandoned steps', async () => {
    const h = harness({ includeConversationId: true })
    const others: SessionLike[] = [{ id: 'session-2' }, { id: `${session.id}\u0000child` }]
    try {
      h.recorder.observe(session, route(1))
      h.recorder.observe(session, stepStart(2, 0))
      h.recorder.observe(session, stepStart(3, 1_000, 1, 2))
      h.recorder.observe(session, stepStart(4, 2_000, 2, 1))
      for (const other of others) {
        h.recorder.observe(other, route(1, 'other', 'other-model'))
        h.recorder.observe(other, stepStart(2, 1_000))
      }

      h.recorder.forget(session.id)
      h.recorder.forget(session.id)
      h.recorder.forget('missing')
      h.recorder.observe(session, assistant(5, 3_000, { inputTokens: 1, outputTokens: 1 }))
      h.recorder.observe(session, assistant(6, 3_000, undefined, 1, 2))
      h.recorder.observe(session, assistant(7, 3_000, undefined, 2, 1))
      for (const other of others) {
        h.recorder.observe(other, assistant(3, 3_000, { inputTokens: 2, outputTokens: 2 }))
      }

      const rm = await h.collect()
      const durations = h.points(rm, 'gen_ai.client.operation.duration')
      expect(durations).toHaveLength(2)
      for (const other of others) {
        expect(durations.find(p => p.attributes['gen_ai.conversation.id'] === other.id)?.value)
          .toMatchObject({ count: 1, sum: 2 })
      }
      const usage = h.points(rm, 'gen_ai.client.token.usage')
      expect(usage.find(p => p.attributes['gen_ai.conversation.id'] === session.id)?.attributes['gen_ai.request.model'])
        .toBe('unknown')
      for (const other of others) {
        expect(usage.find(p => p.attributes['gen_ai.conversation.id'] === other.id)?.attributes['gen_ai.request.model'])
          .toBe('other-model')
      }
    } finally {
      await h.shutdown()
    }
  })

  test('consumes starts without usage, including zero timestamps and negative durations', async () => {
    const h = harness()
    try {
      h.recorder.observe(session, stepStart(1, 0))
      h.recorder.observe(session, assistant(2, 500, undefined))
      h.recorder.observe(session, assistant(3, 1_000, undefined))
      h.recorder.observe(session, stepStart(4, 2_000, 1, 2))
      h.recorder.observe(session, assistant(5, 1_500, undefined, 1, 2))
      h.recorder.observe(session, assistant(6, 3_000, undefined, 1, 2))
      h.recorder.observe(session, stepStart(7, 4_000, 2, 1))
      h.recorder.observe(session, assistant(8, 4_000, undefined, 2, 1))
      h.recorder.observe(session, stepStart(9, 5_000))
      h.recorder.observe(session, assistant(10, 5_500, undefined))

      const rm = await h.collect()
      expect(h.points(rm, 'gen_ai.client.operation.duration')[0]?.value)
        .toMatchObject({ count: 3, sum: 1, min: 0, max: 0.5 })
      expect(h.points(rm, 'gen_ai.client.token.usage')).toHaveLength(0)
    } finally {
      await h.shutdown()
    }
  })

  test('restores the route from a live resume header without reading transcript or credentials', async () => {
    const h = harness({ providerNameMap: { 'deepseek-eu': 'deepseek' } })
    const resumed: SessionLike = { id: 'resumed', firstLiveSeq: 100 }
    try {
      h.recorder.observe(resumed, stepStart(100, 10_000))
      h.recorder.observe(resumed, {
        type: 'request/header', seq: 101, time: 11_000,
        data: {
          reason: 'resume',
          header: {
            config: {
              provider: 'deepseek-eu', model: 'deepseek-reasoner',
              get apiKey(): never { throw new Error('credentials must not be read') },
            },
            get messages(): never { throw new Error('transcript must not be read') },
          },
        },
      })
      h.recorder.observe(resumed, assistant(102, 12_500, { inputTokens: 7, outputTokens: 3 }))

      const rm = await h.collect()
      const usage = h.points(rm, 'gen_ai.client.token.usage')
      expect(usage).toHaveLength(2)
      for (const point of usage) {
        expect(point.attributes).toMatchObject({
          'gen_ai.provider.name': 'deepseek', 'gen_ai.request.model': 'deepseek-reasoner',
        })
        expect(point.value.count).toBe(1)
      }
      expect(usage.find(p => p.attributes['gen_ai.token.type'] === 'input')?.value.sum).toBe(7)
      expect(usage.find(p => p.attributes['gen_ai.token.type'] === 'output')?.value.sum).toBe(3)
      expect(h.points(rm, 'gen_ai.client.operation.duration')[0]?.value).toMatchObject({ count: 1, sum: 2.5 })
    } finally {
      await h.shutdown()
    }
  })

  test('ignores seeded headers before reading their data', async () => {
    const h = harness()
    const resumed: SessionLike = { id: 'resumed', firstLiveSeq: 100 }
    try {
      h.recorder.observe(resumed, {
        type: 'request/header', seq: 99, time: 0,
        get data(): never { throw new Error('seed data must not be read') },
      })
      h.recorder.observe(resumed, assistant(100, 500, { inputTokens: 1, outputTokens: 1 }))
      const usage = h.points(await h.collect(), 'gen_ai.client.token.usage')
      expect(usage[0]?.attributes).toMatchObject({
        'gen_ai.provider.name': 'unknown', 'gen_ai.request.model': 'unknown',
      })
    } finally {
      await h.shutdown()
    }
  })

  test('request context overrides header routes and malformed headers preserve the route', async () => {
    const h = harness()
    try {
      h.recorder.observe(session, {
        type: 'request/header', seq: 1, time: 0,
        data: { header: { config: { provider: 'header-provider', model: 'header-model' } } },
      })
      h.recorder.observe(session, route(2, 'context-provider', 'context-model'))
      const malformed = [
        undefined, null, {}, { header: null }, { header: {} }, { header: { config: null } },
        { header: { config: { provider: 'invalid', model: 42 } } },
        { header: { config: { provider: 42, model: 'invalid' } } },
      ]
      for (const [index, data] of malformed.entries()) {
        h.recorder.observe(session, { type: 'request/header', seq: index + 3, time: 0, data })
      }
      h.recorder.observe(session, assistant(11, 500, { inputTokens: 1, outputTokens: 1 }))
      const usage = h.points(await h.collect(), 'gen_ai.client.token.usage')
      expect(usage[0]?.attributes).toMatchObject({
        'gen_ai.provider.name': 'context-provider', 'gen_ai.request.model': 'context-model',
      })
    } finally {
      await h.shutdown()
    }
  })

  test('step end cancels only its pending start and does not record a second successful duration', async () => {
    const h = harness({ includeConversationId: true })
    const other: SessionLike = { id: 'session-2' }
    try {
      h.recorder.observe(session, stepStart(1, 0))
      h.recorder.observe(session, stepStart(2, 1_000, 1, 2))
      h.recorder.observe(other, stepStart(1, 2_000))
      h.recorder.observe(session, { type: 'step/end', seq: 3, time: 3_000, data: { turn: 1, step: 1 } })
      h.recorder.observe(session, assistant(4, 4_000, undefined))
      h.recorder.observe(session, assistant(5, 3_500, undefined, 1, 2))
      h.recorder.observe(session, { type: 'step/end', seq: 6, time: 4_000, data: { turn: 1, step: 2 } })
      h.recorder.observe(session, { type: 'step/end', seq: 7, time: 4_000, data: { turn: 9, step: 9 } })
      h.recorder.observe(other, assistant(2, 2_500, undefined))
      h.recorder.observe(other, { type: 'step/end', seq: 3, time: 3_000, data: { turn: 1, step: 1 } })

      const durations = h.points(await h.collect(), 'gen_ai.client.operation.duration')
      expect(durations).toHaveLength(2)
      expect(durations.find(p => p.attributes['gen_ai.conversation.id'] === session.id)?.value)
        .toMatchObject({ count: 1, sum: 2.5 })
      expect(durations.find(p => p.attributes['gen_ai.conversation.id'] === other.id)?.value)
        .toMatchObject({ count: 1, sum: 0.5 })
    } finally {
      await h.shutdown()
    }
  })
})

describe('histogram buckets', () => {
  test('separates subsecond and multisecond steps with GenAI duration boundaries', async () => {
    const h = harness()
    try {
      h.recorder.observe(session, stepStart(1, 0))
      h.recorder.observe(session, assistant(2, 500, undefined))
      h.recorder.observe(session, stepStart(3, 1_000))
      h.recorder.observe(session, assistant(4, 3_500, undefined))

      const duration = h.points(await h.collect(), 'gen_ai.client.operation.duration')[0]?.value
      expect(duration?.buckets.boundaries).toEqual([
        0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
      ])
      expect(duration?.buckets.counts).toEqual([0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0])
      expect(duration).toMatchObject({ count: 2, sum: 3 })
    } finally {
      await h.shutdown()
    }
  })

  test('keeps large token counts in distinct finite buckets on all token histograms', async () => {
    const h = harness()
    try {
      h.recorder.observe(session, assistant(1, 0, {
        inputTokens: 12_000, outputTokens: 12_000, cacheReadTokens: 20_000, reasoningTokens: 40_000,
      }))
      h.recorder.observe(session, assistant(2, 1_000, {
        inputTokens: 100_000, outputTokens: 200_000, cacheReadTokens: 300_000, reasoningTokens: 1_500_000,
      }))

      const rm = await h.collect()
      const usage = h.points(rm, 'gen_ai.client.token.usage')
      const histograms = [
        {
          value: usage.find(p => p.attributes['gen_ai.token.type'] === 'input')?.value,
          sum: 432_000,
          counts: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0],
        },
        {
          value: usage.find(p => p.attributes['gen_ai.token.type'] === 'output')?.value,
          sum: 212_000,
          counts: [0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0],
        },
        {
          value: h.points(rm, METRIC_DSH_GENAI_CLIENT_TOKEN_CACHE_READ)[0]?.value,
          sum: 320_000,
          counts: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0],
        },
        {
          value: h.points(rm, METRIC_DSH_GENAI_CLIENT_TOKEN_REASONING)[0]?.value,
          sum: 1_540_000,
          counts: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0],
        },
      ]
      for (const { value, sum, counts } of histograms) {
        expect(value?.buckets.boundaries).toEqual([
          1, 4, 16, 64, 256, 1_024, 4_096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216, 67_108_864,
        ])
        expect(value?.buckets.counts).toEqual(counts)
        expect(value).toMatchObject({ count: 2, sum })
      }
    } finally {
      await h.shutdown()
    }
  })
})

describe('config validation', () => {
  test('rejects a non-http exporter url before building the pipeline', () => {
    expect(() => createGenAiMetrics({ exporter: { url: 'ftp://collector' } })).toThrow(/exporter\.url/u)
  })

  test('rejects a non-positive export interval', () => {
    expect(() => createGenAiMetrics({ exporter: { url: 'http://c/v1/metrics' }, exportIntervalMillis: 0 }))
      .toThrow(/exportIntervalMillis/u)
  })

  test.each([
    ['empty', ''],
    ['http without a host', 'http://'],
    ['https without a host', 'https://'],
    ['query without a host', 'http://?x'],
    ['invalid hostname', 'http://bad host/v1/metrics'],
    ['invalid host escape', 'http://exa%mple.com/v1/metrics'],
    ['out-of-range port', 'http://collector:65536/v1/metrics'],
    ['non-numeric port', 'http://collector:invalid/v1/metrics'],
    ['invalid IPv6', 'http://[::1/v1/metrics'],
    ['ftp', 'ftp://collector/v1/metrics'],
    ['mailto', 'mailto:collector@example.com'],
    ['missing', undefined],
    ['null', null],
    ['number', 42],
    ['object', {}],
    ['credentials and query on invalid host', 'http://user:secret@bad host/v1/metrics?token=secret'],
  ])('rejects %s exporter URL with a generic error', async (_label, url) => {
    let pipeline: ReturnType<typeof createGenAiMetrics> | undefined
    let error: unknown
    try {
      pipeline = createGenAiMetrics({ exporter: { url: url as string }, exportIntervalMillis: 60_000 })
    } catch (caught) {
      error = caught
    } finally {
      await pipeline?.shutdown()
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('otel-genai: exporter.url must be an http(s) URL')
  })

  test.each([
    ['localhost', { url: 'http://localhost:4318/v1/metrics' }],
    ['IPv4 with a query', { url: 'http://127.0.0.1:4318/v1/metrics?tenant=test' }],
    ['IPv6', { url: 'http://[::1]:4318/v1/metrics' }],
    ['uppercase scheme', { url: 'HTTP://localhost:4318/v1/metrics' }],
    ['https with headers', {
      url: 'https://collector.invalid/custom/metrics?tenant=test',
      headers: { authorization: 'Bearer test-token' },
    }],
  ])('accepts a %s exporter URL in the default pipeline', async (_label, exporter) => {
    const { shutdown } = createGenAiMetrics({ exporter, exportIntervalMillis: 60_000 })
    // No measurements are recorded, so shutdown has no HTTP batch to export.
    await shutdown()
  })

  test('an injected reader continues to replace exporter configuration', async () => {
    const h = harness({ exporter: { url: '' }, exportIntervalMillis: 0 })
    try {
      h.recorder.observe(session, assistant(1, 0, { inputTokens: 2, outputTokens: 1 }))
      expect(h.points(await h.collect(), 'gen_ai.client.token.usage')).toHaveLength(2)
    } finally {
      await h.shutdown()
    }
  })
})

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
})

describe('config validation', () => {
  test('rejects a non-http exporter url before building the pipeline', () => {
    expect(() => createGenAiMetrics({ exporter: { url: 'ftp://collector' } })).toThrow(/exporter\.url/u)
  })

  test('rejects a non-positive export interval', () => {
    expect(() => createGenAiMetrics({ exporter: { url: 'http://c/v1/metrics' }, exportIntervalMillis: 0 }))
      .toThrow(/exportIntervalMillis/u)
  })
})

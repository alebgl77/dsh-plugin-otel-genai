/**
 * OpenTelemetry GenAI metrics for DeepSeek Harness.
 *
 * The plugin listens to the harness session log and records the two metrics
 * defined by the OpenTelemetry GenAI semantic conventions:
 *
 * - `gen_ai.client.token.usage`        histogram, unit `{token}`
 * - `gen_ai.client.operation.duration` histogram, unit `s`
 *
 * plus two plugin-specific histograms for accounting the conventions do not
 * carry at metric level:
 *
 * - `dsh.genai.client.token.cache_read` histogram, unit `{token}`
 * - `dsh.genai.client.token.reasoning`  histogram, unit `{token}`
 *
 * Every point is attributed with `gen_ai.operation.name`, `gen_ai.provider.name`
 * and `gen_ai.request.model`, so a Grafana or Prometheus consumer can slice
 * cost and latency per provider and model without any transcript content
 * leaving the process. The plugin exports metrics only; it never reads or
 * forwards message text, tool arguments or tool results.
 *
 * Usage is read from `assistant/message` events, which the harness appends
 * exactly once per model step with the adapter-reported `usage`. Events that
 * belong to a session seed (resume, fork, replay) are skipped so a restarted
 * process never bills the same step twice.
 *
 * @module dsh-plugin-otel-genai
 */

import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import { type Attributes, type Histogram, ValueType } from '@opentelemetry/api'
import {
  METRIC_GEN_AI_CLIENT_OPERATION_DURATION,
  METRIC_GEN_AI_CLIENT_TOKEN_USAGE,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOKEN_TYPE,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_TOKEN_TYPE_VALUE_INPUT,
  GEN_AI_TOKEN_TYPE_VALUE_OUTPUT,
} from '@opentelemetry/semantic-conventions/incubating'
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type IMetricReader,
} from '@opentelemetry/sdk-metrics'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

// Structural declaration of the two harness events this plugin consumes. The
// authoritative signatures live in @deepseek-ai/dsh-session; the shapes below
// are the subset used here, merged into the Cordis event map so `ctx.on` stays
// typed without a compile-time dependency on the harness packages.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'session/event'(session: SessionLike, event: SessionEventLike): void
    'session/disposed'(session: SessionLike): void
  }
}

export const name = 'otel-genai'

/** Plugin-specific metric names. Not part of the OTel GenAI conventions. */
export const METRIC_DSH_GENAI_CLIENT_TOKEN_CACHE_READ = 'dsh.genai.client.token.cache_read'
export const METRIC_DSH_GENAI_CLIENT_TOKEN_REASONING = 'dsh.genai.client.token.reasoning'

/**
 * Structural view of the harness types this plugin consumes. Declared locally
 * so the package compiles against any harness version that keeps these fields,
 * which the session log contract marks as append-only.
 */
export interface TokenUsageLike {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface SessionLike {
  readonly id: string
  /** Events with a smaller seq came from a seed (resume, fork, replay). */
  readonly firstLiveSeq?: number
}

export type SessionEventLike =
  | { type: 'request/context'; seq: number; time: number; data: { provider: string; model: string } }
  | { type: 'step/start'; seq: number; time: number; data: { turn: number; step: number } }
  | { type: 'assistant/message'; seq: number; time: number; data: { turn: number; step: number; usage?: TokenUsageLike } }
  | { type: string; seq: number; time: number; data: unknown }

export interface Config {
  /** OTLP/HTTP metrics endpoint, for example `http://localhost:4318/v1/metrics`. */
  exporter: {
    url: string
    headers?: Record<string, string>
    timeoutMillis?: number
  }
  /** Export period in milliseconds. Default 15000. */
  exportIntervalMillis?: number
  /** `service.name` on the OTel resource. Default `deepseek-harness`. */
  serviceName?: string
  /**
   * Map a harness provider route onto a `gen_ai.provider.name` value when the
   * two differ. Unmapped routes pass through unchanged.
   */
  providerNameMap?: Record<string, string>
  /**
   * Attach `gen_ai.conversation.id` (the harness session id) to every point.
   * Off by default: one time series per session is high cardinality.
   */
  includeConversationId?: boolean
}

/** Test seam: an injected reader replaces the OTLP exporter. */
export interface Options {
  metricReader?: IMetricReader
}

interface Route {
  provider: string
  model: string
}

interface Instruments {
  tokenUsage: Histogram
  operationDuration: Histogram
  cacheRead: Histogram
  reasoning: Histogram
}

const DEFAULT_EXPORT_INTERVAL_MILLIS = 15_000
const DEFAULT_SERVICE_NAME = 'deepseek-harness'

function validateConfig(config: Config): void {
  const url = config.exporter?.url
  if (typeof url !== 'string' || !/^https?:\/\//u.test(url)) {
    throw new Error('otel-genai: exporter.url must be an http(s) URL')
  }
  if (config.exportIntervalMillis !== undefined
    && (!Number.isInteger(config.exportIntervalMillis) || config.exportIntervalMillis <= 0)) {
    throw new Error('otel-genai: exportIntervalMillis must be a positive integer')
  }
}

function createReader(config: Config): IMetricReader {
  const exporterOptions: ConstructorParameters<typeof OTLPMetricExporter>[0] = { url: config.exporter.url }
  if (config.exporter.headers !== undefined) exporterOptions.headers = config.exporter.headers
  if (config.exporter.timeoutMillis !== undefined) exporterOptions.timeoutMillis = config.exporter.timeoutMillis
  return new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(exporterOptions),
    exportIntervalMillis: config.exportIntervalMillis ?? DEFAULT_EXPORT_INTERVAL_MILLIS,
  })
}

function createInstruments(provider: MeterProvider): Instruments {
  const meter = provider.getMeter('dsh-plugin-otel-genai', version)
  return {
    tokenUsage: meter.createHistogram(METRIC_GEN_AI_CLIENT_TOKEN_USAGE, {
      description: 'Number of input and output tokens used per model call',
      unit: '{token}',
      valueType: ValueType.INT,
    }),
    operationDuration: meter.createHistogram(METRIC_GEN_AI_CLIENT_OPERATION_DURATION, {
      description: 'Duration of one model step, from step start to the settled assistant message',
      unit: 's',
      valueType: ValueType.DOUBLE,
    }),
    cacheRead: meter.createHistogram(METRIC_DSH_GENAI_CLIENT_TOKEN_CACHE_READ, {
      description: 'Input tokens served from the provider prompt cache per model call',
      unit: '{token}',
      valueType: ValueType.INT,
    }),
    reasoning: meter.createHistogram(METRIC_DSH_GENAI_CLIENT_TOKEN_REASONING, {
      description: 'Reasoning output tokens per model call, when the adapter reports them',
      unit: '{token}',
      valueType: ValueType.INT,
    }),
  }
}

/**
 * Pure recorder: turns session events into metric points. Exported so it can
 * be unit tested without a Cordis context.
 */
export class GenAiMetricsRecorder {
  private readonly routes = new Map<string, Route>()
  private readonly stepStarts = new Map<string, number>()

  constructor(
    private readonly instruments: Instruments,
    private readonly config: Pick<Config, 'providerNameMap' | 'includeConversationId'>,
  ) {}

  observe(session: SessionLike, event: SessionEventLike): void {
    if (session.firstLiveSeq !== undefined && event.seq < session.firstLiveSeq) return

    switch (event.type) {
      case 'request/context': {
        const data = event.data as { provider: string; model: string }
        this.routes.set(session.id, { provider: data.provider, model: data.model })
        return
      }
      case 'step/start': {
        const data = event.data as { turn: number; step: number }
        this.stepStarts.set(stepKey(session.id, data.turn, data.step), event.time)
        return
      }
      case 'assistant/message': {
        const data = event.data as { turn: number; step: number; usage?: TokenUsageLike }
        const key = stepKey(session.id, data.turn, data.step)
        const startedAt = this.stepStarts.get(key)
        this.stepStarts.delete(key)
        const attributes = this.attributesFor(session)

        if (startedAt !== undefined && event.time >= startedAt) {
          this.instruments.operationDuration.record((event.time - startedAt) / 1000, attributes)
        }

        const usage = data.usage
        if (usage === undefined) return
        const billedInput = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        this.instruments.tokenUsage.record(billedInput, {
          ...attributes,
          [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_INPUT,
        })
        this.instruments.tokenUsage.record(usage.outputTokens, {
          ...attributes,
          [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_OUTPUT,
        })
        if (usage.cacheReadTokens !== undefined) {
          this.instruments.cacheRead.record(usage.cacheReadTokens, attributes)
        }
        if (usage.reasoningTokens !== undefined) {
          this.instruments.reasoning.record(usage.reasoningTokens, attributes)
        }
        return
      }
      default:
        return
    }
  }

  forget(sessionId: string): void {
    this.routes.delete(sessionId)
    for (const key of this.stepStarts.keys()) {
      if (key.startsWith(`${sessionId}\u0000`)) this.stepStarts.delete(key)
    }
  }

  private attributesFor(session: SessionLike): Attributes {
    const route = this.routes.get(session.id)
    const provider = route?.provider ?? 'unknown'
    const attributes: Attributes = {
      [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
      [ATTR_GEN_AI_PROVIDER_NAME]: this.config.providerNameMap?.[provider] ?? provider,
      [ATTR_GEN_AI_REQUEST_MODEL]: route?.model ?? 'unknown',
    }
    if (this.config.includeConversationId === true) {
      attributes[ATTR_GEN_AI_CONVERSATION_ID] = session.id
    }
    return attributes
  }
}

function stepKey(sessionId: string, turn: number, step: number): string {
  return `${sessionId}\u0000${turn}\u0000${step}`
}

/**
 * Build the SDK pipeline and the recorder. Returns a disposer that flushes and
 * shuts the provider down. Kept separate from `apply` so tests can drive it
 * with an in-memory reader.
 */
export function createGenAiMetrics(config: Config, options: Options = {}): {
  recorder: GenAiMetricsRecorder
  shutdown: () => Promise<void>
} {
  const reader = options.metricReader ?? (validateConfig(config), createReader(config))
  const provider = new MeterProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName ?? DEFAULT_SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: version,
    }),
    readers: [reader],
  })
  const recorder = new GenAiMetricsRecorder(createInstruments(provider), config)
  return {
    recorder,
    shutdown: () => provider.shutdown(),
  }
}

/** Cordis plugin entry. */
export function apply(ctx: Context, config: Config): void {
  const { recorder, shutdown } = createGenAiMetrics(config)

  // `session/event` fires for every appended session event and
  // `session/disposed` when a session leaves memory. Both are declared by
  // @deepseek-ai/dsh-session through Cordis event merging; they are addressed
  // by name here so the package does not pin a harness version at compile time.
  ctx.on('session/event', (session, event) => {
    recorder.observe(session, event)
  })
  ctx.on('session/disposed', (session) => {
    recorder.forget(session.id)
  })

  // The SDK pipeline is a resource Cordis does not manage: wrap it in an
  // effect so unloading the plugin flushes and stops the exporter.
  ctx.effect(() => () => shutdown())
}

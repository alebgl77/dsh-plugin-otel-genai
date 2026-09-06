# dsh-plugin-otel-genai

OpenTelemetry GenAI metrics for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The plugin turns the harness session log into the two metrics defined by the
[OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
and exports them over OTLP/HTTP. Point it at an OTel Collector, Grafana Alloy,
Prometheus with the OTLP receiver, or Grafana Cloud, and every model step made
by the harness shows up as token usage and latency per provider and model.

No transcript content leaves the process. The plugin reads token counts, the
provider route and timestamps; message text, tool arguments and tool results
are never touched. The built-in `@deepseek-ai/dsh-session-telemetry-otel`
package covers the opposite need (full session records as OTel logs).

## Metrics

| Metric | Type | Unit | Source |
|---|---|---|---|
| `gen_ai.client.token.usage` | histogram | `{token}` | OTel GenAI conventions |
| `gen_ai.client.operation.duration` | histogram | `s` | OTel GenAI conventions |
| `dsh.genai.client.token.cache_read` | histogram | `{token}` | plugin specific |
| `dsh.genai.client.token.reasoning` | histogram | `{token}` | plugin specific |

Attributes on every point: `gen_ai.operation.name` (`chat`),
`gen_ai.provider.name`, `gen_ai.request.model`. `gen_ai.client.token.usage`
adds `gen_ai.token.type` (`input` or `output`). `gen_ai.conversation.id` is
opt-in.

Token accounting follows the harness `TokenUsage` contract: `input` is the
billed prompt size, meaning uncached input plus cache read plus cache write;
`output` is the completion size. Cache read and reasoning tokens are also
reported on their own histograms because the conventions carry them as span
attributes only, not as metric dimensions.

Duration is measured from the `step/start` event to the settled
`assistant/message` of the same step, in the harness process clock. It covers
the whole model call including streaming, not the provider-side latency.

## Install

```sh
npm install dsh-plugin-otel-genai
```

Add the entry to your `cordis.yml` or to a `--patch` overlay:

```yaml
- name: dsh-plugin-otel-genai
  config:
    exporter:
      url: http://localhost:4318/v1/metrics
      headers:
        authorization: !!js `Bearer ${process.env.OTLP_TOKEN}`
    exportIntervalMillis: 15000        # optional, default 15000
    serviceName: deepseek-harness      # optional, OTel service.name
    includeConversationId: false       # optional, one series per session when true
    providerNameMap:                   # optional, harness route -> gen_ai.provider.name
      deepseek-eu: deepseek
```

`exporter.url` must be an `http(s)` URL to the OTLP metrics endpoint. The
plugin fails at load time on a missing or malformed URL and on a non-positive
export interval, before any exporter is constructed.

## Grafana

With an OTel Collector feeding Prometheus, the histograms land as
`gen_ai_client_token_usage_token_sum`, `_count` and `_bucket`. Three panels
cover most FinOps questions:

Tokens per model over the last hour, split by direction:

```promql
sum by (gen_ai_request_model, gen_ai_token_type)
  (increase(gen_ai_client_token_usage_token_sum[1h]))
```

p95 step latency per provider:

```promql
histogram_quantile(0.95,
  sum by (le, gen_ai_provider_name)
    (rate(gen_ai_client_operation_duration_seconds_bucket[5m])))
```

Prompt cache hit ratio per model:

```promql
sum by (gen_ai_request_model) (increase(dsh_genai_client_token_cache_read_token_sum[1h]))
/
sum by (gen_ai_request_model)
  (increase(gen_ai_client_token_usage_token_sum{gen_ai_token_type="input"}[1h]))
```

Multiply the token sums by your provider price sheet in a Grafana
transformation, or import the ready-made dashboard from
[grafana-llmops-forge](https://github.com/alebgl77/grafana-llmops-forge), which
consumes these exact metric and label names.

## Double counting

A metric consumer cannot deduplicate a histogram after the fact, so the plugin
has to record each step exactly once. Two rules make that hold:

1. Usage is read from `assistant/message`, which the harness appends once per
   model step with the adapter-reported usage. Streaming usage chunks and
   retried attempts are not counted.
2. Events with `seq < session.firstLiveSeq` belong to a session seed (resume,
   fork, replay) and are skipped, so a restarted process does not re-bill the
   steps it inherited from disk.

If you also run `dsh-session-telemetry-otel` in `FULL` mode, the same usage
appears there as log records. Aggregate from one source or the other, not both.

## Development

```sh
pnpm install
pnpm run check   # typecheck + vitest
```

The package compiles against `@deepseek-ai/cordis` only. The two harness
events it consumes (`session/event`, `session/disposed`) are declared
structurally in `src/index.ts` so the plugin does not pin a harness version.

## License

MIT

# @hippocortex/sdk

Official JavaScript/TypeScript SDK for [Hippocortex](https://hippocortex.dev) — persistent memory for AI agents that learns from experience.

[![npm](https://img.shields.io/npm/v/@hippocortex/sdk)](https://www.npmjs.com/package/@hippocortex/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Install

```bash
npm install @hippocortex/sdk
```

## Quick Start

### Auto-Instrumentation (Recommended)

One import. Every OpenAI or Anthropic call gets persistent memory automatically.

```typescript
import '@hippocortex/sdk/auto'
import OpenAI from 'openai'

const openai = new OpenAI()

// Memory context is injected, conversation is captured automatically
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Deploy payments to staging' }]
})
```

### Explicit Wrap

Wrap individual clients for more control:

```typescript
import { wrap } from '@hippocortex/sdk'
import OpenAI from 'openai'

const openai = wrap(new OpenAI())
// Only this client has memory
```

### Manual Client

Full control over capture, synthesize, learn, and vault:

```typescript
import { Hippocortex } from '@hippocortex/sdk'

const hx = new Hippocortex({ apiKey: 'hx_live_...' })

// Capture an event
await hx.capture({
  type: 'message',
  sessionId: 'session-1',
  payload: { role: 'user', content: 'Deploy the service' }
})

// Retrieve relevant context
const context = await hx.synthesize('How do I deploy?')

// Trigger knowledge compilation
const result = await hx.learn()

// Search the vault
const secrets = await hx.vaultQuery('database password')

// Reveal a specific secret
const secret = await hx.vaultReveal('item-id')
```

## Configuration

```typescript
import { Hippocortex } from '@hippocortex/sdk'

const hx = new Hippocortex({
  apiKey: 'hx_live_...',              // or set HIPPOCORTEX_API_KEY
  baseUrl: 'https://api.hippocortex.dev/v1',  // default
  sessionId: 'my-session',            // optional
})
```

## Exports

| Export | Description |
|--------|-------------|
| `@hippocortex/sdk` | Manual client (`Hippocortex`) |
| `@hippocortex/sdk/auto` | Auto-instrumentation (import once) |
| `@hippocortex/sdk/register` | Register hook for custom integrations |
| `@hippocortex/sdk/adapters` | Framework adapters (OpenClaw) |

## API Reference

### `Hippocortex`

| Method | Description |
|--------|-------------|
| `capture(event)` | Capture a single event |
| `captureBatch(events)` | Capture multiple events |
| `synthesize(query, options?)` | Retrieve relevant context |
| `learn(options?)` | Trigger knowledge compilation |
| `vaultQuery(query, options?)` | Search vault (metadata only) |
| `vaultReveal(itemId)` | Decrypt a vault secret |
| `listArtifacts(options?)` | List knowledge artifacts |
| `getMetrics()` | Get usage metrics |

## Requirements

- Node.js 18+
- TypeScript 5+ (optional)

## Links

- [Documentation](https://hippocortex.dev/docs)
- [Dashboard](https://dashboard.hippocortex.dev)
- [Gateway Guide](https://hippocortex.dev/docs/gateway/GATEWAY)
- [Python SDK](https://github.com/vmaiops-alt/hippocortex-python)
- [Examples](https://github.com/vmaiops-alt/hippocortex-examples)

## License

MIT

/**
 * Make a real x402 payment against a deployed nairarate instance.
 *
 * This is the launch gate: it proves the paywall, the facilitator and settlement
 * work end to end with real money. Defaults to Base Sepolia; mainnet requires an
 * explicit --mainnet flag, because on mainnet this spends real USDC.
 *
 *   PAYER_PRIVATE_KEY=0x… npm run test:payment                          # Sepolia
 *   PAYER_PRIVATE_KEY=0x… npm run test:payment -- --mainnet             # real money
 *   PAYER_PRIVATE_KEY=0x… npm run test:payment -- --mainnet --days=7    # tiered
 *
 * Flags:
 *   --mainnet         Base mainnet (eip155:8453). Omit for Sepolia.
 *   --exact-only      Register only ExactEvmScheme, i.e. behave like the many
 *                     clients that do not implement `upto`. Proves the default
 *                     path never hits a Permit2 412.
 *   --url=ORIGIN      Target origin (default https://nairarate.dev)
 *   --days=N          Call /v1/rates/history?days=N instead of /v1/rates.
 *                     Exercises the `upto` tiering — 1-7d $0.01 … 91-365d $0.05.
 *   --currency=USD --market=parallel   History parameters.
 *
 * The key is read from PAYER_PRIVATE_KEY only. Never pass it as an argument (it
 * lands in shell history) and never commit it.
 *
 * ## Setup notes, learned the hard way
 *
 * - `wrapFetchWithPayment(fetch, client)` takes an **x402Client with per-network
 *   schemes registered**, not a viem wallet client. Passing a wallet client fails
 *   with `this.client.getExtensions is not a function`.
 * - The signer is built from an account plus a **public** client, not a wallet
 *   client. The public client is what allows on-chain reads for EIP-2612 /
 *   approval enrichment.
 * - Both schemes are registered by default. /v1/rates/history advertises `exact`
 *   first (no setup) and `upto` second (window-based tiers, but settles via Permit2
 *   and so needs a one-time payer approval). Registering `upto` is what makes the
 *   tiering apply; `--exact-only` simulates the many clients that do not.
 * - The settlement receipt is in the **`PAYMENT-RESPONSE`** header. `X-PAYMENT-RESPONSE`
 *   exists in the SDK only on v1 compatibility paths and reads null on a v2
 *   payment that in fact succeeded.
 */

import { createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'
import { toClientEvmSigner } from '@x402/evm'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { UptoEvmScheme } from '@x402/evm/upto/client'
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from '@x402/fetch'

const USDC = {
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
} as const

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit?.split('=', 2)[1]
}

async function usdcBalance(rpc: string, token: string, holder: string): Promise<number> {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: token, data: `0x70a08231${'0'.repeat(24)}${holder.slice(2)}` }, 'latest'],
    }),
  })
  const body = (await res.json()) as { result?: string }
  return body.result && body.result !== '0x' ? Number(BigInt(body.result)) / 1e6 : 0
}

async function main(): Promise<void> {
  const key = process.env.PAYER_PRIVATE_KEY
  if (!key) throw new Error('PAYER_PRIVATE_KEY is not set')

  const mainnet = process.argv.includes('--mainnet')
  const chain = mainnet ? base : baseSepolia
  const origin = arg('url') ?? 'https://nairarate.dev'
  const days = arg('days')

  const path = days
    ? `/v1/rates/history?currency=${arg('currency') ?? 'USD'}` +
      `&market=${arg('market') ?? 'parallel'}&days=${days}`
    : '/v1/rates'

  // privateKeyToAccount requires the 0x prefix.
  const account = privateKeyToAccount(key.startsWith('0x') ? (key as `0x${string}`) : `0x${key}`)
  const publicClient = createPublicClient({ chain, transport: http() })
  const signer = toClientEvmSigner(account, publicClient)
  const network = `eip155:${chain.id}` as const

  const exactOnly = process.argv.includes('--exact-only')

  const client = new x402Client().register(network, new ExactEvmScheme(signer))
  if (!exactOnly) {
    // `upto` enables the window-based tiers on /v1/rates/history, but settles via
    // Permit2 and so needs a one-time approval from the payer. Without this
    // registration the client simply takes `exact`, which is listed first.
    client.register(network, new UptoEvmScheme(signer))
  }

  const rpc = chain.rpcUrls.default.http[0]!
  const token = USDC[chain.id as keyof typeof USDC]

  console.log(`\n  network   ${chain.name} (${network})${mainnet ? '  *** REAL MONEY ***' : ''}`)
  console.log(`  payer     ${account.address}`)
  console.log(`  schemes   ${exactOnly ? 'exact only (--exact-only)' : 'exact + upto'}`)
  console.log(`  target    ${origin}${path}`)

  const payerBefore = await usdcBalance(rpc, token, account.address)
  console.log(`  payer USDC before: ${payerBefore.toFixed(6)}`)
  if (payerBefore === 0) {
    throw new Error(`payer holds no USDC on ${chain.name} — fund ${account.address} first`)
  }

  // Show what is being asked for before paying it.
  const probe = await fetch(`${origin}${path}`)
  const required = probe.headers.get('payment-required')
  if (required) {
    const parsed = JSON.parse(Buffer.from(required, 'base64').toString()) as {
      accepts: { scheme: string; amount: string; payTo: string; network: string }[]
    }
    console.log('  quoted:')
    for (const a of parsed.accepts) {
      console.log(`    ${a.scheme.padEnd(6)} ${a.network}  up to $${(Number(a.amount) / 1e6).toFixed(3)} -> ${a.payTo}`)
    }
  }
  console.log(`  probe status ${probe.status} (402 expected)\n`)

  const fetchWithPayment = wrapFetchWithPayment(fetch, client)
  const res = await fetchWithPayment(`${origin}${path}`)

  console.log(`  paid request status ${res.status}`)

  // The v2 receipt header. NOT X-PAYMENT-RESPONSE.
  const receiptHeader = res.headers.get('payment-response')
  const settledUsd = res.headers.get('x-settlement-usd')

  if (!receiptHeader) {
    console.error('  PAYMENT-RESPONSE header absent — no settlement receipt returned')
  } else {
    const receipt = decodePaymentResponseHeader(receiptHeader) as Record<string, unknown>
    console.log(`  receipt   ${JSON.stringify(receipt)}`)
    const tx = receipt['transaction'] ?? receipt['txHash'] ?? receipt['transactionHash']
    if (typeof tx === 'string') {
      const scan = mainnet ? 'https://basescan.org' : 'https://sepolia.basescan.org'
      console.log(`  tx        ${tx}`)
      console.log(`  explorer  ${scan}/tx/${tx}`)
    }
  }
  if (settledUsd) console.log(`  settled   ${settledUsd} (x-settlement-usd)`)

  const body = (await res.json()) as Record<string, unknown>
  if (res.ok) {
    const snaps = body['snapshots']
    console.log(
      `  payload   ${Array.isArray(snaps) ? `${snaps.length} snapshot(s)` : `confidence=${String(body['confidence'])}`}`,
    )
  } else {
    console.log(`  body      ${JSON.stringify(body).slice(0, 200)}`)
  }

  const payerAfter = await usdcBalance(rpc, token, account.address)
  console.log(`\n  payer USDC after:  ${payerAfter.toFixed(6)}  (spent ${(payerBefore - payerAfter).toFixed(6)})`)
  console.log('  Settlement can lag a few seconds — re-check the payee balance if it reads 0.')
}

main().catch((err: unknown) => {
  console.error('\n  test-payment failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})

// WP-114d: why does "Summarise this" say it couldn't open a page? Asks the conversation model to open
// one address with web_fetch, exactly as a summary does, and prints only what happened: which tool
// events arrived, whether web_fetch ran and finished, the tool's own error (if any) and what the model
// said. It never prints page text or the model's summary. Uses one Copilot request.
// Run in the Codespace terminal: node scripts/source-check.js <address> [--role conversation]
import { pathToFileURL } from 'node:url';
import { createAi } from '../server/ai/index.js';
import { loadModels } from '../server/ai/models.js';
import { buildSystem, buildPrompt } from '../server/ai/prompt.js';
import {
  SUMMARY_CONTRACT, SUMMARY_TIMEOUT_MS, summaryInstruction, webOptions, fetchWatcher, parseSummaryReply, cleanUrl,
} from '../server/ai/sources.js';
import { redact } from '../server/ai/copilot.js';

export const USAGE = 'Usage: node scripts/source-check.js <address> [--role conversation]';

export function parseArgs(argv) {
  const out = { url: null, role: 'conversation', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--role') {
      out.role = argv[i + 1] ?? '';
      i += 1;
    } else if (!out.url) out.url = arg;
  }
  out.url = cleanUrl(out.url ?? '');
  return out;
}

/** One plain verdict from what happened. kind: the model's answer (or null if unusable). */
export function verdictFor(facts, kind) {
  if (!facts.ran) return 'NO FETCH: the model never called web_fetch, so a summary would say it couldn\'t open the page.';
  if (facts.result === 'failed') return 'FETCH FAILED: web_fetch ran but the site refused it or the tool failed (see the error above).';
  if (kind === 'subscription') return 'SUBSCRIPTION: the page opened but showed a paywall or login.';
  if (kind === 'unavailable') return 'MODEL SAID UNAVAILABLE after web_fetch ran: probably a login, paywall, cookie wall or a page with no readable text.';
  if (kind === 'summary' || kind === 'read-original') return `OK: the page was read (the model chose "${kind}").`;
  return 'UNCLEAR: web_fetch ran but the model gave no usable answer.';
}

export function reportLines({ url, model, seconds, facts, kind }) {
  const types = Object.entries(facts.types).map(([t, n]) => `${t} ×${n}`).join(', ') || 'none';
  return [
    `Site: ${new URL(url).hostname}`,
    `Model: ${model}`,
    `Time: ${seconds.toFixed(1)} s`,
    `Events: ${types}`,
    `web_fetch ran: ${facts.ran ? 'yes' : 'no'}`,
    `web_fetch result: ${facts.result}`,
    `Fields on the result event: ${facts.resultKeys.length ? facts.resultKeys.join(', ') : 'none seen'}`,
    `Tool error: ${facts.error ? redact(facts.error).replace(/\s+/g, ' ').slice(0, 200) : 'none'}`,
    `Model said: ${kind ?? 'nothing usable'}`,
    `Verdict: ${verdictFor(facts, kind)}`,
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 2);
  }
  const { models, errors } = await loadModels();
  const model = models?.[args.role];
  if (!model) {
    console.log(`No model for role "${args.role}" in models.json${errors?.length ? `: ${errors.join('; ')}` : ''}`);
    process.exit(1);
  }
  const { ai, error } = await createAi({});
  if (!ai) {
    console.log(`AI not available: ${error ?? 'unknown'}`);
    process.exit(1);
  }
  const watch = fetchWatcher(['web_fetch']);
  const started = Date.now();
  let kind = null;
  try {
    const system = await buildSystem({ route: 'research' });
    const prompt = buildPrompt({ instruction: summaryInstruction({ title: 'Saved source', url: args.url }), contract: SUMMARY_CONTRACT });
    const reply = await ai.ask({
      model, system, prompt, timeoutMs: SUMMARY_TIMEOUT_MS, ...webOptions(['web_fetch']),
      onPermission: watch.onPermission, onEvent: watch.onEvent,
    });
    kind = parseSummaryReply(reply.text)?.kind ?? null;
  } catch (err) {
    console.log(`The request failed: ${redact(err?.message ?? String(err)).slice(0, 300)}`);
  } finally {
    await ai.stop?.();
  }
  for (const l of reportLines({ url: args.url, model, seconds: (Date.now() - started) / 1000, facts: watch.facts(), kind })) console.log(l);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

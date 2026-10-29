// npm run alert:check — verify step 11 (blueprint §13): sends one level-3 alert, then two level-2
// alerts with a gap between them, so the second lands as a comment on the first one's issue.
// Run it in the Codespace terminal (it needs the STORAGE_REPO and STORAGE_TOKEN secrets).
// Prints no token and no repository name. The issues it creates are tests: close them afterwards.
import { pathToFileURL } from 'node:url';
import { alertSettings, sendAlert } from '../server/alerts.js';

export const USAGE = 'Usage: npm run alert:check [-- --only 3|2] [--gap <seconds>]';
// The workflow looks for today's level-2 issue when it runs, so the second level-2 alert must wait
// until the first run has opened that issue. GitHub usually runs a workflow within a minute.
export const DEFAULT_GAP_S = 90;
const MIN_GAP_S = 30;
const MAX_GAP_S = 600;

export function parseArgs(argv) {
  const out = { only: null, gapS: DEFAULT_GAP_S };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--only') {
      const value = argv[++i];
      if (value !== '2' && value !== '3') throw new Error(`--only must be 2 or 3\n${USAGE}`);
      out.only = Number(value);
    } else if (arg === '--gap') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < MIN_GAP_S || value > MAX_GAP_S) {
        throw new Error(`--gap must be a whole number of seconds from ${MIN_GAP_S} to ${MAX_GAP_S}\n${USAGE}`);
      }
      out.gapS = value;
    } else {
      throw new Error(`Unknown option: ${arg}\n${USAGE}`);
    }
  }
  return out;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quiet = { log() {}, error() {} };

/**
 * Sends the test alerts. Returns { verdict: 'SENT' | 'FAIL', lines, results }.
 * 'SENT' means GitHub accepted every dispatch; the owner then checks the issues arrived.
 */
export async function runCheck({ settings, only = null, gapS = DEFAULT_GAP_S, send = sendAlert, sleep = defaultSleep, out = console.log, now = () => new Date() }) {
  const lines = [];
  const results = [];
  const say = (line) => {
    lines.push(line);
    out(line);
  };
  let step = 0;
  const attempt = async (label) => {
    step += 1;
    const level = label === 'level-3' ? 3 : 2;
    const result = await send({ kind: 'wellbeing', level, settings, now: now(), log: quiet });
    results.push({ level, ...result });
    if (result.ok) say(`${step}. ${label} alert: sent (GitHub answered ${result.status})`);
    else say(`${step}. ${label} alert: FAIL (${result.error}${result.acceptedPermissions ? `; token needs: ${result.acceptedPermissions}` : ''})`);
    return result.ok;
  };

  let ok = true;
  if (only !== 2) ok = (await attempt('level-3')) && ok;
  if (only !== 3) {
    const first = await attempt('level-2');
    ok = first && ok;
    if (first) {
      say(`   waiting ${gapS} s so GitHub can open the level-2 issue first…`);
      await sleep(gapS * 1000);
      ok = (await attempt('second level-2')) && ok;
    }
  }

  const verdict = ok ? 'SENT' : 'FAIL';
  say(`Result: ${verdict}`);
  if (ok) {
    say('Now check, within 5 minutes:');
    if (only !== 2) say('- an issue "Check in with the learner (level 3) – <today>" in the storage repository, and an email about it;');
    if (only !== 3) say('- an issue "Check in with the learner (level 2) – <today>" with one comment, "Another level-2 moment today."');
    say('These are tests: close the issues afterwards.');
  }
  return { verdict, lines, results };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const settings = alertSettings(process.env);
  if (settings.skip) {
    console.error(`Alert check not run: ${settings.skip}.`);
    console.error('Run it in the Codespace terminal, where the STORAGE_REPO and STORAGE_TOKEN secrets are set.');
    process.exit(1);
  }
  const { verdict } = await runCheck({ settings, only: args.only, gapS: args.gapS });
  process.exitCode = verdict === 'SENT' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();

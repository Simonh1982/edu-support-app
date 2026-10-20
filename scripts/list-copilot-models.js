// npm run models: list the models this Copilot account can use, and check models.json against
// them. Prints model information only, never the token. Add --json for the raw list.
import { pathToFileURL } from 'node:url';
import { createAi } from '../server/ai/index.js';
import { loadModels } from '../server/ai/models.js';
import { errorSummary } from '../server/ai/copilot.js';

/** One readable line per model. Field names beyond id and name are VERIFY items. */
export function describeModel(model) {
  const id = model?.id ?? '(no id)';
  const parts = [id];
  if (model?.name && model.name !== id) parts.push(`(${model.name})`);
  const multiplier = model?.billing?.multiplier;
  if (multiplier !== undefined) parts.push(`multiplier ${multiplier}`);
  if (model?.capabilities?.supports?.vision === true) parts.push('images: yes');
  if (model?.policy?.state && model.policy.state !== 'enabled') parts.push(`policy: ${model.policy.state}`);
  return parts.join('  ');
}

/** For each role, whether its model ID is in the account's list. */
export function compareRoles(models, available) {
  const ids = new Set(available.map((m) => m?.id));
  return Object.entries(models).map(([role, id]) => ({ role, id, found: ids.has(id) }));
}

async function main() {
  const { ai, error } = await createAi({ env: process.env });
  if (!ai) {
    console.error(`Cannot list models: ${error}`);
    process.exitCode = 1;
    return;
  }
  try {
    const list = await ai.listModels();
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(list, null, 2));
      return;
    }
    const sorted = [...list].sort((a, b) => String(a?.id).localeCompare(String(b?.id)));
    console.log(`Models available to this account (${sorted.length}):`);
    for (const model of sorted) console.log(`  ${describeModel(model)}`);

    const { models, errors } = await loadModels();
    if (!models) {
      console.log(`\nmodels.json problems: ${errors.join('; ')}`);
      process.exitCode = 1;
      return;
    }
    console.log('\nmodels.json roles:');
    const rows = compareRoles(models, list);
    for (const row of rows) console.log(`  ${row.found ? 'OK     ' : 'MISSING'}  ${row.role.padEnd(12)} ${row.id}`);
    if (rows.some((row) => !row.found)) {
      console.log('\nAt least one model ID in models.json is not available to this account.');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Cannot list models: ${errorSummary(err)}`);
    process.exitCode = 1;
  } finally {
    await ai.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

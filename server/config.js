// Server settings. Read once at start-up from environment variables; no secrets are read here.

// The public GitHub Pages site. Not personal: it is the repository owner's public Pages address.
export const PAGES_ORIGIN = 'https://simonh1982.github.io';

const DEFAULT_PORT = 3000;
const DEFAULT_IDLE_TIMEOUT_MIN = 30; // must match the GitHub Codespaces idle-timeout setting

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env = process.env) {
  const port = env.PORT === '0' ? 0 : positiveInt(env.PORT, DEFAULT_PORT);
  const codespaceName = env.CODESPACE_NAME || '';
  const forwardingDomain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || '';
  return Object.freeze({
    port,
    host: env.HOST || '0.0.0.0',
    idleTimeoutMin: positiveInt(env.IDLE_TIMEOUT_MIN, DEFAULT_IDLE_TIMEOUT_MIN),
    // localhost origins are accepted only when DEV_ORIGINS=1 (local front-end testing)
    devOrigins: env.DEV_ORIGINS === '1',
    jsonBodyLimit: 256 * 1024,
    uploadBodyLimit: 8 * 1024 * 1024,
    codespaceName,
    publicUrl: codespaceName && forwardingDomain
      ? `https://${codespaceName}-${port || DEFAULT_PORT}.${forwardingDomain}`
      : '',
  });
}

const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/**
 * True if the browser origin may call the API.
 * @param {string | undefined} origin
 * @param {{ devOrigins: boolean }} config
 */
export function isAllowedOrigin(origin, config) {
  if (!origin) return false;
  if (origin === PAGES_ORIGIN) return true;
  return config.devOrigins && LOCALHOST.test(origin);
}

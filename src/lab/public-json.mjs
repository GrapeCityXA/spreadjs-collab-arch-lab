/** Keep management credentials in runtime state, out of API/CLI JSON output. */
export function publicJsonReplacer(key, value) {
  if (key === 'adminToken' || key === 'agentToken') return value ? 'SET' : 'MISSING';
  return value;
}

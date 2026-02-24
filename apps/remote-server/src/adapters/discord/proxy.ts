import { ProxyAgent } from 'undici';

let cachedProxyUrl: string | null = null;
let cachedProxyAgent: ProxyAgent | null = null;
let hasLoggedProxyConfig = false;

export function getDiscordProxyDispatcher(): ProxyAgent | undefined {
  const rawProxyUrl = process.env.DISCORD_PROXY_URL?.trim();
  if (!rawProxyUrl) {
    return undefined;
  }

  if (cachedProxyAgent && cachedProxyUrl === rawProxyUrl) {
    return cachedProxyAgent;
  }

  // Validate once so configuration errors fail fast and clearly.
  const parsed = new URL(rawProxyUrl);
  const normalizedProxyUrl = parsed.toString();

  cachedProxyAgent = new ProxyAgent(normalizedProxyUrl);
  cachedProxyUrl = normalizedProxyUrl;

  if (!hasLoggedProxyConfig) {
    hasLoggedProxyConfig = true;
    console.log(`[discord] Using dedicated proxy: ${maskProxyUrl(normalizedProxyUrl)}`);
  }

  return cachedProxyAgent;
}

function maskProxyUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = url.password ? '***' : '';
    }
    return url.toString();
  } catch {
    return raw;
  }
}

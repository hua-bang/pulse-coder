import z from 'zod';
import { fetch } from 'undici';
import type { Tool } from 'pulse-coder-engine';

const toolSchema = z.object({
  listUrl: z.string().min(1).describe('X/Twitter list URL, for example https://x.com/i/lists/1234567890.'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum tweets to return. Defaults to 20.'),
  nitterInstance: z.string().optional().describe('Optional Nitter-compatible instance base URL.'),
  timeoutMs: z.number().int().positive().optional().describe('Request timeout in milliseconds. Defaults to 20000.'),
});

type TwitterListTweetsInput = z.infer<typeof toolSchema>;

interface TwitterListTweet {
  id: string;
  url: string;
  text: string;
  publishedAt?: string;
  authorHandle?: string;
  authorName?: string;
  isRetweet: boolean;
  isReply: boolean;
}

interface TwitterListTweetsResult {
  ok: boolean;
  listId: string;
  sourceListUrl: string;
  rssUrl?: string;
  instanceUsed?: string;
  fetchedAt: string;
  tweets: TwitterListTweet[];
  meta: {
    requestedLimit: number;
    returnedCount: number;
    deduplicatedCount: number;
    truncated: boolean;
    attemptedInstances: string[];
  };
  error?: string;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_INSTANCES = ['https://nitter.net', 'https://xcancel.com'];

export const twitterListTweetsTool: Tool<TwitterListTweetsInput, TwitterListTweetsResult> = {
  name: 'twitter_list_tweets',
  description: 'Fetch latest tweets from an X list via Nitter-compatible RSS feeds.',
  defer_loading: true,
  inputSchema: toolSchema,
  execute: async (input): Promise<TwitterListTweetsResult> => {
    const fetchedAt = new Date().toISOString();
    const requestedLimit = input.limit ?? DEFAULT_LIMIT;
    const listId = extractListId(input.listUrl);

    if (!listId) {
      return {
        ok: false,
        listId: '',
        sourceListUrl: input.listUrl,
        fetchedAt,
        tweets: [],
        meta: {
          requestedLimit,
          returnedCount: 0,
          deduplicatedCount: 0,
          truncated: false,
          attemptedInstances: [],
        },
        error: 'Unable to parse list ID from listUrl. Expected /i/lists/<numeric-id>.',
      };
    }

    const sourceListUrl = normalizeSourceListUrl(input.listUrl, listId);
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const instances = buildInstanceCandidates(input.nitterInstance);
    const attemptedInstances: string[] = [];
    const errors: string[] = [];

    for (const instance of instances) {
      attemptedInstances.push(instance);
      const rssUrl = `${instance}/i/lists/${listId}/rss`;

      try {
        const xml = await fetchTextWithTimeout(rssUrl, timeoutMs);
        const parsed = parseListFeed(xml, requestedLimit);

        if (parsed.tweets.length === 0) {
          errors.push(`${instance}: empty feed`);
          continue;
        }

        return {
          ok: true,
          listId,
          sourceListUrl,
          rssUrl,
          instanceUsed: instance,
          fetchedAt,
          tweets: parsed.tweets,
          meta: {
            requestedLimit,
            returnedCount: parsed.tweets.length,
            deduplicatedCount: parsed.deduplicatedCount,
            truncated: parsed.truncated,
            attemptedInstances,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        errors.push(`${instance}: ${message}`);
      }
    }

    return {
      ok: false,
      listId,
      sourceListUrl,
      fetchedAt,
      tweets: [],
      meta: {
        requestedLimit,
        returnedCount: 0,
        deduplicatedCount: 0,
        truncated: false,
        attemptedInstances,
      },
      error: `Failed to fetch list feed from all instances. ${errors.join(' | ')}`,
    };
  },
};

async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'pulse-coder/remote-server',
      },
      signal: controller.signal,
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }

    return body;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseListFeed(xml: string, limit: number): { tweets: TwitterListTweet[]; deduplicatedCount: number; truncated: boolean } {
  const blocks = extractEntryBlocks(xml);
  const tweets: TwitterListTweet[] = [];
  const seenIds = new Set<string>();
  let deduplicatedCount = 0;

  for (const block of blocks) {
    const tweet = parseEntry(block);
    if (!tweet) {
      continue;
    }

    if (seenIds.has(tweet.id)) {
      deduplicatedCount += 1;
      continue;
    }

    seenIds.add(tweet.id);
    tweets.push(tweet);
  }

  const truncated = tweets.length > limit;
  return {
    tweets: truncated ? tweets.slice(0, limit) : tweets,
    deduplicatedCount,
    truncated,
  };
}

function extractEntryBlocks(xml: string): string[] {
  const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi);
  if (entries && entries.length > 0) {
    return entries;
  }

  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi);
  return items ?? [];
}

function parseEntry(block: string): TwitterListTweet | null {
  const url = extractLink(block);
  if (!url) {
    return null;
  }

  const id = extractTweetId(url) ?? `url-${hashString(url)}`;
  const authorHandle = extractAuthorHandle(url);
  const authorName = extractAuthorName(block);
  const title = firstNonEmpty(extractTagValue(block, 'title'));
  const description = firstNonEmpty(
    extractTagValue(block, 'description'),
    extractTagValue(block, 'content'),
    extractTagValue(block, 'content:encoded'),
  );

  const text = cleanText(title || description || '');
  if (!text) {
    return null;
  }

  const publishedRaw = firstNonEmpty(
    extractTagValue(block, 'published'),
    extractTagValue(block, 'updated'),
    extractTagValue(block, 'pubDate'),
  );

  return {
    id,
    url,
    text,
    publishedAt: toIsoTimestamp(publishedRaw),
    authorHandle: authorHandle ?? undefined,
    authorName: authorName ?? undefined,
    isRetweet: isRetweetText(text),
    isReply: isReplyText(text),
  };
}

function extractListId(raw: string): string | null {
  const trimmed = raw.trim();

  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  const directMatch = /\/i\/lists\/(\d+)/i.exec(trimmed);
  if (directMatch) {
    return directMatch[1];
  }

  try {
    const url = new URL(normalizeUrl(trimmed));
    const pathMatch = /\/i\/lists\/(\d+)/i.exec(url.pathname);
    return pathMatch ? pathMatch[1] : null;
  } catch {
    return null;
  }
}

function normalizeSourceListUrl(raw: string, listId: string): string {
  try {
    const parsed = new URL(normalizeUrl(raw));
    if (/\/i\/lists\//i.test(parsed.pathname)) {
      return `${parsed.origin}/i/lists/${listId}`;
    }
  } catch {
    // Ignore and use fallback.
  }

  return `https://x.com/i/lists/${listId}`;
}

function buildInstanceCandidates(preferred?: string): string[] {
  const unique = new Set<string>();
  const preferredNormalized = preferred ? normalizeInstance(preferred) : '';

  if (preferredNormalized) {
    unique.add(preferredNormalized);
  }

  for (const instance of DEFAULT_INSTANCES) {
    unique.add(normalizeInstance(instance));
  }

  return Array.from(unique);
}

function normalizeInstance(value: string): string {
  const normalized = normalizeUrl(value.trim()).replace(/\/+$/, '');
  return normalized;
}

function normalizeUrl(value: string): string {
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }

  return `https://${value}`;
}

function extractLink(block: string): string | null {
  const hrefMatch = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i.exec(block);
  if (hrefMatch) {
    return decodeXmlEntities(hrefMatch[1]).trim();
  }

  const tagMatch = extractTagValue(block, 'link');
  if (tagMatch) {
    return decodeXmlEntities(stripHtml(tagMatch)).trim();
  }

  return null;
}

function extractAuthorName(block: string): string {
  const authorBlock = extractTagValue(block, 'author');
  if (authorBlock) {
    const nestedName = extractTagValue(authorBlock, 'name');
    const candidate = cleanText(nestedName || authorBlock);
    if (candidate) {
      return candidate;
    }
  }

  const direct = firstNonEmpty(extractTagValue(block, 'dc:creator'), extractTagValue(block, 'creator'));
  return cleanText(direct || '');
}

function extractAuthorHandle(url: string): string | null {
  const match = /https?:\/\/[^/]+\/([^/?#]+)\/status\/\d+/i.exec(url);
  if (!match) {
    return null;
  }

  const handle = match[1].trim();
  return handle.length > 0 ? handle : null;
}

function extractTweetId(url: string): string | null {
  const match = /\/status\/(\d+)/i.exec(url);
  return match ? match[1] : null;
}

function extractTagValue(block: string, tag: string): string | null {
  const escapedTag = escapeRegExp(tag);
  const regex = new RegExp(`<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\/${escapedTag}>`, 'i');
  const match = regex.exec(block);
  return match ? match[1] : null;
}

function cleanText(value: string): string {
  return decodeXmlEntities(stripHtml(stripCdata(value))).replace(/\s+/g, ' ').trim();
}

function stripCdata(value: string): string {
  return value.replace(/^<!\[CDATA\[|\]\]>$/g, '');
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ');
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return '';
}

function toIsoTimestamp(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  return new Date(timestamp).toISOString();
}

function isRetweetText(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.startsWith('rt ') || normalized.startsWith('rt @') || normalized.includes('retweeted');
}

function isReplyText(text: string): boolean {
  return /^@[a-z0-9_]+/i.test(text.trim());
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

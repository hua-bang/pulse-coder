import { Hono } from 'hono';
import { dispatch } from '../core/dispatcher.js';
import { discordAdapter } from '../adapters/discord/adapter.js';

export const discordRouter = new Hono();

/**
 * POST /webhooks/discord
 * Receives Discord interactions webhooks.
 *
 * Configure in Discord Developer Portal:
 *   Interactions Endpoint URL: https://your-server/webhooks/discord
 */
discordRouter.post('/', (c) => dispatch(discordAdapter, c));

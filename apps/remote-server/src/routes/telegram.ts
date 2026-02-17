import { Hono } from 'hono';
import { dispatch } from '../core/dispatcher.js';
import { telegramAdapter } from '../adapters/telegram/adapter.js';

export const telegramRouter = new Hono();

/**
 * POST /webhooks/telegram
 * Receives Telegram bot webhook updates.
 *
 * Set up webhook: POST https://api.telegram.org/bot{token}/setWebhook
 *   with { url: "https://your-server/webhooks/telegram",
 *           secret_token: TELEGRAM_WEBHOOK_SECRET }
 */
telegramRouter.post('/', (c) => dispatch(telegramAdapter, c));

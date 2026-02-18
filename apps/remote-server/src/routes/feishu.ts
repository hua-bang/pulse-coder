import { Hono } from 'hono';
import { dispatch } from '../core/dispatcher.js';
import { feishuAdapter } from '../adapters/feishu/adapter.js';

export const feishuRouter = new Hono();

/**
 * POST /webhooks/feishu
 * Receives Feishu (Lark) event webhook calls.
 *
 * Configure in Feishu Open Platform:
 *   Event subscription URL: https://your-server/webhooks/feishu
 *   Events to subscribe: im.message.receive_v1
 */
feishuRouter.post('/', (c) => dispatch(feishuAdapter, c));

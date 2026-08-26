import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { MerchantAgent } from '../agents/merchant-agent.js';
import { routes } from './routes.js';
import { registerChatRoutes } from './chat.js';
import { registerWebSocketHandler, broadcastProtocolEvent } from './websocket.js';
import { paymentBus } from '../payment/webhook-events.js';
import { createPersistenceFromEnv } from '../persistence/persistence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicPath = path.join(__dirname, '../../public');

export async function buildServer(merchantAgent?: MerchantAgent) {
  const merchant =
    merchantAgent ??
    new MerchantAgent({ persistence: createPersistenceFromEnv() });

  const fastify = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'test' ? 'warn' : 'info',
      transport:
        process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  // Raw-body capture for webhook HMAC verification: signatures must be
  // computed over the exact bytes Razorpay sent, not a re-serialized object.
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body;
    try {
      done(null, JSON.parse(body as string));
    } catch (err: any) {
      done(err);
    }
  });

  // Plugins
  await fastify.register(cors, { origin: '*' });
  await fastify.register(fastifyWebsocket);
  await fastify.register(fastifyStatic, {
    root: publicPath,
    prefix: '/',
  });

  // Register WebSockets
  registerWebSocketHandler(fastify, merchant);

  // Register REST Routes
  await fastify.register(routes, { merchantAgent: merchant });

  // Conversational checkout (natural language → settled receipt)
  registerChatRoutes(fastify, merchant);

  // Unified settlement-confirmation pipeline: internal synthetic captures and
  // externally-signed Razorpay webhooks flow through this single subscriber.
  const unsubscribeBus = paymentBus().subscribe((evt) => {
    if (evt.kind === 'payment.captured') {
      const result = merchant.confirmCapture(evt);
      broadcastProtocolEvent({
        type: 'SETTLEMENT_CONFIRMED',
        source: evt.source,
        razorpayOrderId: evt.razorpayOrderId,
        razorpayPaymentId: evt.razorpayPaymentId,
        transactionId: result.record?.transactionId,
        confirmed: result.confirmed,
        confirmedAt: result.record?.confirmedAt,
        reason: result.reason,
        timestamp: evt.timestamp,
      });
      if (!result.confirmed && result.reason && !result.reason.startsWith('Already')) {
        fastify.log.warn({ evt }, `Capture confirmation unmatched: ${result.reason}`);
      }
    } else if (evt.kind === 'payment.failed') {
      broadcastProtocolEvent({
        type: 'SETTLEMENT_FAILED',
        source: evt.source,
        razorpayOrderId: evt.razorpayOrderId,
        reason: evt.reason,
        timestamp: evt.timestamp,
      });
    }
  });
  fastify.addHook('onClose', async () => unsubscribeBus());

  return fastify;
}

export async function startServer(port = Number(process.env.PORT) || 3000, host = process.env.HOST || '0.0.0.0') {
  const server = await buildServer();
  try {
    const address = await server.listen({ port, host });
    server.log.info(`AgentPay Protocol Server running at ${address}`);
    return server;
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

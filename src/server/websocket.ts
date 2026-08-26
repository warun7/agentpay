import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { MerchantAgent } from '../agents/merchant-agent.js';
import type { StateTransitionEvent } from '../protocol/state-machine.js';

export const connectedClients = new Set<WebSocket>();

export function broadcastProtocolEvent(event: StateTransitionEvent | object) {
  const payload = JSON.stringify(event);
  for (const client of connectedClients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      try {
        client.send(payload);
      } catch (err) {
        console.error('Error broadcasting to WS client:', err);
      }
    }
  }
}

export function registerWebSocketHandler(fastify: FastifyInstance, merchant: MerchantAgent) {
  fastify.get('/ws/feed', { websocket: true }, (socket, req) => {
    connectedClients.add(socket);
    fastify.log.info('Dashboard WebSocket client connected');

    socket.send(
      JSON.stringify({
        type: 'CONNECTION_ESTABLISHED',
        message: 'Connected to AgentPay Realtime Protocol Feed',
        merchantDID: merchant.getDID(),
        timestamp: new Date().toISOString(),
      })
    );

    socket.on('close', () => {
      connectedClients.delete(socket);
      fastify.log.info('Dashboard WebSocket client disconnected');
    });

    socket.on('error', (err) => {
      fastify.log.error(err, 'WebSocket client error');
      connectedClients.delete(socket);
    });
  });
}

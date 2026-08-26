import { startServer } from './server/index.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

startServer(port, host).then(() => {
  console.log(`\n===============================================================`);
  console.log(`🚀 AgentPay Autonomous Agent Commerce Server`);
  console.log(`📡 Realtime Dashboard: http://localhost:${port}`);
  console.log(`📋 API Health Check:   http://localhost:${port}/health`);
  console.log(`🛍️ Product Catalog:   http://localhost:${port}/api/catalog`);
  console.log(`===============================================================\n`);
});

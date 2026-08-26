import type { CatalogItem } from '../protocol/schemas.js';

export const DEFAULT_CATALOG: CatalogItem[] = [
  {
    id: 'item_gpu_h100_cluster',
    name: 'NVIDIA H100 8-GPU Cluster (100 Compute Hours)',
    category: 'cloud_services',
    basePrice: 350000, // ₹3,500.00
    currency: 'INR',
    stock: 15,
    description: 'High-throughput tensor core cluster with NVLink for LLM inference & fine-tuning.',
    metadata: { tier: 'enterprise', region: 'ap-south-1 (Mumbai)' },
  },
  {
    id: 'item_gpu_a100_node',
    name: 'NVIDIA A100 80GB Dedicated Instance (50 Hours)',
    category: 'cloud_services',
    basePrice: 120000, // ₹1,200.00
    currency: 'INR',
    stock: 40,
    description: 'Dedicated GPU acceleration node with 3.2TB/s memory bandwidth.',
    metadata: { tier: 'professional', region: 'ap-south-1 (Mumbai)' },
  },
  {
    id: 'item_api_gateway_enterprise',
    name: 'Ultra-Low Latency Edge API Gateway (5M Requests)',
    category: 'saas_subscription',
    basePrice: 45000, // ₹450.00
    currency: 'INR',
    stock: 1000,
    description: 'Global anycast routing with DDoS protection and token bucket rate limiters.',
    metadata: { sla: '99.999%', latency: '<5ms' },
  },
  {
    id: 'item_vector_db_pro',
    name: 'Managed Vector Database Instance (50M Embeddings)',
    category: 'saas_subscription',
    basePrice: 85000, // ₹850.00
    currency: 'INR',
    stock: 50,
    description: 'Distributed HNSW index vector database with sub-10ms recall.',
    metadata: { dimensions: 1536, redundancy: 'multi-az' },
  },
];

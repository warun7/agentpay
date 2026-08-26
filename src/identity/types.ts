import type { JWKKey, Ed25519JWK, X25519JWK } from '../crypto/types.js';

export interface VerificationMethod {
  id: string;
  type: 'Ed25519VerificationKey2020' | 'X25519KeyAgreementKey2020';
  controller: string;
  publicKeyJwk: JWKKey;
}

export interface KeyAgreementMethod {
  id: string;
  type: 'X25519KeyAgreementKey2020';
  controller: string;
  publicKeyJwk: X25519JWK;
}

export interface DIDDocument {
  '@context': string[];
  id: string;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  assertionMethod: string[];
  keyAgreement: KeyAgreementMethod[];
}

export interface SpendingConstraints {
  maxAmount: number; // in minor units (paise) or major units (INR)
  currency: string;  // e.g. "INR"
  allowedCategories: string[]; // e.g. ["cloud_services", "saas_subscription", "compute_gpu"]
  merchantWhitelist: string[]; // List of merchant DIDs or ["*"]
  dailyLimit?: number;
}

export interface MandateSubject {
  id: string; // Subject DID (Buyer Agent DID)
  spendingConstraints: SpendingConstraints;
  userUpiId?: string;
  uapMandateCircleRef?: string;
}

export interface VerifiableCredential {
  '@context': string[];
  id: string;
  type: string[];
  issuer: string; // Issuer DID (User Root Identity / Wallet DID)
  issuanceDate: string; // ISO 8601
  expirationDate: string; // ISO 8601
  credentialSubject: MandateSubject;
  proof: {
    type: 'Ed25519Signature2020' | 'JsonWebSignature2020';
    created: string;
    verificationMethod: string;
    jws: string;
  };
}

export interface AgentIdentity {
  name: string;
  role: 'buyer' | 'merchant';
  did: string;
  didDocument: DIDDocument;
  signingKeyPair: {
    publicKey: any;
    privateKey: any;
    jwk: { public: Ed25519JWK; private: Ed25519JWK };
  };
  encryptionKeyPair: {
    publicKey: any;
    privateKey: any;
    jwk: { public: X25519JWK; private: X25519JWK };
  };
}

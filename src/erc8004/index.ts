// ─────────────────────────────────────────────────────────────────────────────
// ERC-8004 Service Layer — Barrel Export
// ─────────────────────────────────────────────────────────────────────────────
// Single import point for all ERC-8004 on-chain interaction functions.
// Usage: import { registerAgentIdentity, submitFeedback, ... } from "../erc8004";
// ─────────────────────────────────────────────────────────────────────────────

export {
  getProvider,
  getSigner,
  getIdentityContract,
  getReputationContract,
  getValidationContract,
  isErc8004Configured,
  ERC8004_CONFIG,
} from "./config";

export {
  registerAgentIdentity,
  getAgentIdentity,
  buildAgentRegistrationJSON,
} from "./identity";

export {
  submitFeedback,
  getReputationSummary,
  getReputationHistory,
} from "./reputation";

export {
  submitValidationRequest,
  submitValidationResponse,
  getValidationStatus,
  getAgentValidations,
} from "./validation";

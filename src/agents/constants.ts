// Centralized agent metadata — single source of truth for all 7 pipeline agents.

export const AGENT_NAMES = [
  "aura",
  "flux",
  "clause",
  "oracle",
  "edge",
  "lucifer",
  "sigma",
] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

export type AgentOutputKey =
  | "aura_output"
  | "flux_output"
  | "oracle_output"
  | "edge_output"
  | "clause_output"
  | "lucifer_output"
  | "sigma_output";

export const AGENT_OUTPUT_KEYS: Record<AgentName, AgentOutputKey> = {
  aura: "aura_output",
  flux: "flux_output",
  clause: "clause_output",
  oracle: "oracle_output",
  edge: "edge_output",
  lucifer: "lucifer_output",
  sigma: "sigma_output",
};

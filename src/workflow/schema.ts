export const workflowClusters = [
  "shipping",
  "review",
  "simplification",
  "debugging",
  "capture",
  "communication",
  "delegation",
  "validation",
] as const;

export const workflowArtifactKinds = ["skill", "rule", "workflow_doc", "none"] as const;
export const workflowConfidenceLevels = ["strong", "medium", "weak", "contradicted"] as const;
export const workflowRecommendations = ["adopt", "consider", "dismiss", "ask"] as const;

export type WorkflowCluster = (typeof workflowClusters)[number];
export type WorkflowArtifactKind = (typeof workflowArtifactKinds)[number];
export type WorkflowConfidence = (typeof workflowConfidenceLevels)[number];
export type WorkflowRecommendation = (typeof workflowRecommendations)[number];

export type WorkflowEvidenceKind =
  | "explicit_preference"
  | "correction"
  | "accepted_pattern"
  | "contradiction";

export type WorkflowEvidence = {
  asd_session_id: string;
  evidence_kind: WorkflowEvidenceKind;
  excerpt: string;
  matched_rule_id: string;
  source_tool: string;
  topic: string;
  updated_at: string;
};

export type WorkflowCandidate = {
  artifact_kind: WorkflowArtifactKind;
  candidate_id: string;
  cluster: WorkflowCluster;
  rule_id: string;
  contradicting_count: number;
  encoded_in?: string;
  confidence: WorkflowConfidence;
  supporting_count: number;
  evidence_count: number;
  evidence_sessions: WorkflowEvidence[];
  guidance: string;
  recommendation: WorkflowRecommendation;
  risk: "low" | "medium" | "high";
  trigger: string;
  status?: "already_encoded";
};

export type WorkflowMineResult = {
  candidates: WorkflowCandidate[];
  days: number;
  sessions_scanned: number;
  source: string | null;
};

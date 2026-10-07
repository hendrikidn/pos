export { evaluateRules } from './engine';
export { buildIncidents, levelOf, multiplier, GROUP_WINDOW_MS } from './incidents';
export { DEFAULT_CONFIG } from './types';
export type {
  Capabilities, Incident, Modality, RiskLevel, RuleConfig, RuleHit, RuleInput,
} from './types';
export { RULE_LABELS, ruleLabel } from './labels';

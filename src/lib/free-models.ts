// free-models.json 的前端类型（由 scripts/sync-free-models.mjs 生成）
export interface FreeModel {
  id: string;
  name: string;
  context: number;
  maxOutput: number;
  toolCall: boolean;
  reasoning: boolean;
  attachment: boolean;
  openWeights: boolean;
  lastUpdated: string | null;
}

export interface FreeProvider {
  id: string;
  name: string;
  api: string | null;
  envKey: string;
  npm: string | null;
  doc: string | null;
  note: string | null;
  anthropicApi: string | null;
  models: FreeModel[];
}

export interface FreeModelsIndex {
  syncedAt: string;
  source: string;
  totalFree: number;
  providers: FreeProvider[];
}

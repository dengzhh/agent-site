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
  // 能承载该模型的网关适配器偏好序（网关 /sessions 的 agents 参数）
  agents: string[];
  // 官方模型详情页（openrouter 有确定的 per-model 页；其他 provider 为空）
  detailUrl?: string | null;
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
  // 官方模型目录页（provider 级）
  modelsUrl?: string | null;
  models: FreeModel[];
}

export interface FreeModelsIndex {
  syncedAt: string;
  source: string;
  totalFree: number;
  providers: FreeProvider[];
}

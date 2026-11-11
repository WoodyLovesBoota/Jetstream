// 평소 기억 저장소 — 인터페이스와 메모리 구현. IndexedDB 구현은 idbStore.ts(워커 전용).

export interface BaselineRecord {
  key: string;
  /** 탈계절화된 평균 점유율 (bias 보정 전 원값) */
  mu: number;
  /** 분당 점유율 분산 (bias 보정 전 원값) */
  v: number;
  /** 관측 분 수(bias 보정의 n) */
  n: number;
  /** 마지막 갱신 epoch ms */
  updatedAt: number;
}

export interface BaselineStore {
  loadAll(): Promise<BaselineRecord[]>;
  saveMany(records: BaselineRecord[]): Promise<void>;
}

export class MemoryStore implements BaselineStore {
  readonly data = new Map<string, BaselineRecord>();

  async loadAll(): Promise<BaselineRecord[]> {
    return [...this.data.values()].map((r) => ({ ...r }));
  }

  async saveMany(records: BaselineRecord[]): Promise<void> {
    for (const r of records) this.data.set(r.key, { ...r });
  }
}

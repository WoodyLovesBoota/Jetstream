// IndexedDB 저장소 — 워커(또는 메인)에서만 쓴다. 엔진 코어는 BaselineStore 인터페이스만 안다.
//
// 레코드 상한 maxRecords — 넘으면 updatedAt이 오래된 것부터 지운다(저장 때마다가 아니라
// 가끔: saveMany 10번에 한 번). IndexedDB가 없거나(사파리 프라이빗 등) 열기에 실패하면
// 빈 저장소처럼 동작한다 — 기억이 없을 뿐 엔진은 돈다.

import type { BaselineRecord, BaselineStore } from "./store.ts";

const DB_NAME = "jetstream-trend";
const STORE = "baselines";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class IdbStore implements BaselineStore {
  private db: Promise<IDBDatabase | null>;
  private saves = 0;
  private readonly maxRecords: number;

  constructor(maxRecords = 60_000) {
    this.maxRecords = maxRecords;
    this.db = new Promise((resolve) => {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        const s = open.result.createObjectStore(STORE, { keyPath: "key" });
        s.createIndex("updatedAt", "updatedAt");
      };
      open.onsuccess = () => resolve(open.result);
      // 열기 실패는 "기억 없음"으로 강등한다 — 트렌드 계산은 계속돼야 한다
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
    });
  }

  async loadAll(): Promise<BaselineRecord[]> {
    const db = await this.db;
    if (db === null) return [];
    try {
      return await req(db.transaction(STORE, "readonly").objectStore(STORE).getAll() as IDBRequest<BaselineRecord[]>);
    } catch (e) {
      console.warn("[trend] IndexedDB load failed", e);
      return [];
    }
  }

  async saveMany(records: BaselineRecord[]): Promise<void> {
    const db = await this.db;
    if (db === null || records.length === 0) return;
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const r of records) store.put(r);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        console.warn("[trend] IndexedDB save failed", tx.error);
        resolve();
      };
      tx.onabort = () => resolve();
    });
    if (++this.saves % 10 === 0) await this.prune(db);
  }

  private async prune(db: IDBDatabase): Promise<void> {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    const count = await req(store.count());
    let excess = count - this.maxRecords;
    if (excess <= 0) return;
    const cursorReq = store.index("updatedAt").openCursor();
    await new Promise<void>((resolve) => {
      cursorReq.onsuccess = () => {
        const c = cursorReq.result;
        if (c === null || excess <= 0) {
          resolve();
          return;
        }
        c.delete();
        excess--;
        c.continue();
      };
      cursorReq.onerror = () => resolve();
    });
  }
}

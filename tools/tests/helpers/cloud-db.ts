/** Optimistic transactional test double. CloudBase itself still requires deployment smoke tests. */
export function memoryDatabase() {
  let rows = new Map<string, any>();
  let versions = new Map<string, number>();
  const clone = (v: any) => v == null ? null : JSON.parse(JSON.stringify(v));
  const db: any = {
    get: async (collection: string, id: string) => clone(rows.get(`${collection}/${id}`)),
    set: async (collection: string, id: string, value: any) => {
      const key = `${collection}/${id}`;
      rows.set(key, { ...clone(value), _id: id });
      versions.set(key, (versions.get(key) || 0) + 1);
    },
    list: async (collection: string, where: any, after: string, limit: number) => Array.from(rows.entries())
      .filter(([key, value]) => key.startsWith(`${collection}/`) && value._id > after && Object.entries(where).every(([k, v]) => value[k] === v))
      .map(([, value]) => clone(value)).sort((a, b) => a._id.localeCompare(b._id)).slice(0, limit),
    async transaction(work: any) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const snapshot = new Map(Array.from(rows, ([k, v]) => [k, clone(v)]));
        const base = new Map(versions);
        const writes = new Map<string, any>();
        const result = await work({
          get: async (collection: string, id: string) => clone(writes.get(`${collection}/${id}`) || snapshot.get(`${collection}/${id}`)),
          set: async (collection: string, id: string, value: any) => { writes.set(`${collection}/${id}`, { ...clone(value), _id: id }); },
        });
        if (Array.from(writes.keys()).some((key) => (versions.get(key) || 0) !== (base.get(key) || 0))) continue;
        writes.forEach((value, key) => { rows.set(key, value); versions.set(key, (versions.get(key) || 0) + 1); });
        return result;
      }
      throw new Error('TransactionConflict');
    },
    dump: (collection: string) => Array.from(rows).filter(([key]) => key.startsWith(`${collection}/`)).map(([, v]) => clone(v)),
  };
  return db;
}

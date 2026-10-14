/** wx-server-sdk adapter. Keep missing documents distinct from outages/permission errors. */
function adapter(db, root = db) {
  return {
    async get(collection, id) {
      try {
        const result = await db.collection(collection).doc(id).get();
        return (Array.isArray(result.data) ? result.data[0] : result.data) || null;
      } catch (error) {
        if (error.errCode === -502001 && /document.*not.*exist|文档不存在/i.test(error.errMsg || error.message || '')) return null;
        throw error;
      }
    },
    async set(collection, id, value) {
      const { _id, ...data } = value;
      await db.collection(collection).doc(id).set({ data });
    },
    async list(collection, where, after = '', limit = 50) {
      const query = { ...where };
      if (after) query._id = root.command.gt(after);
      return (await db.collection(collection).where(query).orderBy('_id', 'asc').limit(limit).get()).data;
    },
    /** 确保集合存在：云开发里写入不存在的集合会失败，这里在冷启动时补建一次 */
    async ensure(collection) {
      try {
        await db.createCollection(collection);
      } catch (error) {
        if (!/-501001|already.*exist|已存在/i.test(`${error.errCode || ''} ${error.errMsg || error.message || ''}`)) throw error;
      }
    },
    async transaction(work) {
      // Explicit commits preserve business errors and return values, and limit retries
      // to platform transaction conflicts. Storage side effects stay outside this block.
      for (let attempt = 0; attempt < 3; attempt++) {
        const tx = await root.startTransaction();
        try {
          const result = await work(adapter(tx, root));
          await tx.commit();
          return result;
        } catch (error) {
          try { await tx.rollback(); } catch (_) { /* Preserve the original error. */ }
          const conflict = /TransactionConflict|transaction.*conflict/i.test(`${error.code || ''} ${error.errMsg || error.message || ''}`);
          if (!error.public && conflict && attempt < 2) continue;
          throw error;
        }
      }
    },
  };
}
module.exports = { adapter };

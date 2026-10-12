/** Exercise the pinned SDK's real document/transaction wrappers; replace only its network transport. */
const cloud = require('../../cloudfunctions/diaryApi/node_modules/wx-server-sdk');
const { Db } = require('../../cloudfunctions/diaryApi/node_modules/@cloudbase/database');
const { EJSON } = require('../../cloudfunctions/diaryApi/node_modules/bson');
const { adapter } = require('../../cloudfunctions/diaryApi/database');

test('真实 SDK 适配：空文档、事务写入和返回值遵循部署版本的协议', async () => {
  cloud.init({ env: 'adapter-contract-test' });
  const database = cloud.database({ throwOnNotFound: false });
  const previous = Db.reqClass;
  const rows = new Map<string, any>();
  const actions: string[] = [];
  Db.reqClass = class {
    async send(action: string, p: any) {
      actions.push(action);
      if (action === 'database.startTransaction') return { transactionId: 'test-tx' };
      if (action === 'database.commitTransaction' || action === 'database.abortTransaction') return {};
      const id = EJSON.parse(p.query)._id;
      const key = `${p.collectionName}/${id}`;
      if (action === 'database.getDocument') return { data: { list: rows.has(key) ? [EJSON.stringify(rows.get(key))] : [] } };
      if (action === 'database.modifyDocument') {
        rows.set(key, { _id: id, ...EJSON.parse(p.data) });
        return { data: { updated: 1, upsert_id: id } };
      }
      throw new Error(`Unexpected network operation: ${action}`);
    }
  };
  try {
    const db = adapter(database);
    expect(await db.get('users', 'new-user')).toBeNull();
    const result = await db.transaction(async (tx: any) => {
      expect(await tx.get('users', 'new-user')).toBeNull();
      await tx.set('users', 'new-user', { _id: 'new-user', nickname: '点点' });
      return { id: 'new-user' };
    });
    expect(result).toEqual({ id: 'new-user' });
    expect(await db.get('users', result.id)).toEqual({ _id: 'new-user', nickname: '点点' });
    expect(actions).toContain('database.commitTransaction');
  } finally { Db.reqClass = previous; }
});

export {};

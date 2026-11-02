/**
 * agint-rules: agint_rules 域「加表不升版本」兼容性守卫（提案 09ae2017）
 *
 * Run: node --test plugins/agint-rules/test/domain-version-compat.test.mjs
 *
 * 为什么单独存在：`agint_rules` 的 spec 里有两张表现在（rule + rule_audit），
 * 而**磁盘上的存量文件是 version 1**。dsh-storage-json 的 parse() 对
 * `version !== descriptor.version` 直接抛 `version-mismatch`，整次 domain.open
 * 失败 ⇒ agint-rules 挂不上 ⇒ 全部规则门禁消失，而且界面不报错。
 *
 * 所以「只加表、不升 version」不是风格选择，是**不能碰的兼容边界**。本文件用
 * **真实 json 后端**（不是内存替身）把四条方向都跑一遍：
 *   A. 老文件（只有 rule 表）+ 新代码 ⇒ 能开，rule 数据在，rule_audit 空表
 *   B. 新代码写审计行 ⇒ 落盘
 *   C. 重开 ⇒ 审计行还在（这就是「重启不清零」在文件层面的证据）
 *   D. 老代码读新文件 ⇒ 能开（降级安全，多余表被忽略）
 *   E. 对照：把 version 改成 2 再去开同一个文件 ⇒ **必须** version-mismatch
 *      （证明"升版本"确实会打挂存量，不是纸面担心）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';

/** 老口径：只有 rule 表（= 存量 agint_rules.json 的形状） */
const DESCRIPTOR_OLD = { name: 'agint_rules', version: 1, tables: ['rule'] };
/** 新口径：加 rule_audit 表，**version 不动** */
const DESCRIPTOR_NEW = { name: 'agint_rules', version: 1, tables: ['rule', 'rule_audit'] };
/** 反例：顺手把 version 升到 2（这就是会打挂存量的那条路） */
const DESCRIPTOR_V2 = { name: 'agint_rules', version: 2, tables: ['rule', 'rule_audit'] };

const RULE_ROW = {
  id: 'bash-rm-rf-root',
  tool: 'bash',
  pattern: '\\brm\\s+-[a-zA-Z]*[rfRF][a-zA-Z]*\\s+/',
  flags: 'i',
  action: 'deny',
  level: 'L1',
  reason: '测试行',
  enabled: true,
  createdAt: '2026-09-03T15:06:42.369Z',
  updatedAt: '2026-09-03T15:06:42.369Z',
};
const AUDIT_ROW = {
  hits: 3, denies: 2, asks: 1, advisories: 0, epistemics: 0,
  firstHitAt: '2026-11-02T10:00:00.000Z',
  lastHitAt: '2026-11-02T11:30:00.000Z',
};

/** 开一次、做点事、关掉；backend 每个 unit 只允许一个活句柄，所以必须成对 */
async function withUnit(root, descriptor, fn) {
  const backend = new JsonStorageBackend(root);
  const unit = await backend.kv.open(descriptor);
  try {
    return await fn(unit);
  } finally {
    await unit.close();
    await backend.close();
  }
}

test('A/B/C/D：老文件 → 新代码可开、审计行落盘、重开仍在、老代码也能读回', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agint-rules-domain-'));
  try {
    // A. 先用**老口径**造一份存量文件（模拟升级前的 agint_rules.json）
    await withUnit(root, DESCRIPTOR_OLD, async (unit) => {
      await unit.putRecord('rule', RULE_ROW.id, RULE_ROW);
    });

    // A. 新代码打开：不能 version-mismatch；rule 数据在；rule_audit 是空表
    await withUnit(root, DESCRIPTOR_NEW, async (unit) => {
      const snapshot = await unit.loadAll();
      assert.ok(snapshot.tables.rule?.[RULE_ROW.id], '升级后读不到既有规则 —— 存量被丢了');
      assert.deepEqual(snapshot.tables.rule_audit ?? {}, {}, '新表在老文件上应为空');

      // B. 写一行审计
      await unit.putRecord('rule_audit', RULE_ROW.id, AUDIT_ROW);
    });

    // C. 重开：审计行还在 —— 这就是「重启不清零」的文件层证据
    await withUnit(root, DESCRIPTOR_NEW, async (unit) => {
      const snapshot = await unit.loadAll();
      const row = snapshot.tables.rule_audit?.[RULE_ROW.id];
      assert.ok(row, '重开后审计行丢了（重启不清零没生效）');
      assert.equal(row.hits, 3);
      assert.equal(row.denies, 2);
      assert.equal(row.lastHitAt, AUDIT_ROW.lastHitAt);
    });

    // D. 降级安全：老口径读新文件不该炸（多余表按 descriptor 遍历被忽略）
    await withUnit(root, DESCRIPTOR_OLD, async (unit) => {
      const snapshot = await unit.loadAll();
      assert.ok(snapshot.tables.rule?.[RULE_ROW.id], '降级后读不到规则');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E 对照：升 version 到 2 ⇒ 打开存量文件必然 version-mismatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agint-rules-domain-v2-'));
  try {
    // 用 version 1 造文件
    await withUnit(root, DESCRIPTOR_NEW, async (unit) => {
      await unit.putRecord('rule', RULE_ROW.id, RULE_ROW);
    });

    // 再用 version 2 打开 —— 必须炸，且错因是版本
    const backend = new JsonStorageBackend(root);
    await assert.rejects(
      () => backend.kv.open(DESCRIPTOR_V2),
      (err) => {
        assert.match(String(err?.message ?? err), /version/i,
          `期望 version-mismatch，实际：${err?.message ?? err}`);
        return true;
      },
      'version 被升到 2 竟然能打开 version 1 的文件 —— 那说明本测试的前提判断错了',
    );
    await backend.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * agint-trajectory: lib/storage.js — 独立域声明（§3.2，不变量 #1 域独占）。
 *
 * 三张表：
 *   trajectories — 轨迹本体（元数据 + 内联 payload）
 *   counters     — 丢弃/降级计数（单条 key='current'）
 *   calibration  — 标定期状态（单条 key='current'）
 *
 * schemaVersion 1 一次定够字段：dsh-storage-json 版本不匹配会**拒绝打开且无
 * 自动迁移**（curator v0.2.0 挂载事故），升级必须走手动迁移脚本位。
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import {
  DOMAIN_NAME, SCHEMA_VERSION, TrajectorySchema, CountersSchema, CalibrationStateSchema,
} from './schema.js';

export const COUNTERS_KEY = 'current';
export const CALIBRATION_KEY = 'current';

export const spec = defineDomain({
  name: DOMAIN_NAME,
  version: SCHEMA_VERSION,
  tables: {
    trajectories: { valueSchema: TrajectorySchema },
    counters: { valueSchema: CountersSchema },
    calibration: { valueSchema: CalibrationStateSchema },
  },
});

export { TrajectorySchema, CountersSchema, CalibrationStateSchema };

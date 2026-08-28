/**
 * agint-mount — 类型定义（MountContext 抽象）
 *
 * MountContext 是 orchestrator / health-probe / rollback 共同依赖的运行时抽象。
 * 生产环境由 dsh host Cordis ctx 适配；测试环境由 smoke.mjs 构造 in-memory 实现。
 *
 * 设计原则：
 *   - getService(name)         软依赖（如 agint.qualitySandbox / agint.evolution）
 *   - tables.{tickets,probe_history,rollback_log}  由 storageDomain.open(spec) 提供
 *   - readFile(path)           仅在 ACTIVATE 阶段读 patch.yml（patch.ts 备用）
 *   - runShell(cmd, args)      仅 4 态路径调 pnpm install
 *   - requestRestart / waitSentinelLease  4 态路径 sentinel hook
 *   - awaitHmrSettle(id, timeout)  ACTIVATE 后等 dsh 加载
 *   - registerEffect(disposer) 探针循环 + setInterval 的 disposer
 *   - emitEvent(channel, payload)  mount.requested / mount.succeeded / mount.failed
 *
 * mount.request 不直接 import dsh 官方 preset；MountContext 是边界。
 */
import type { ContractCheckSchema, PhaseSchema } from './schemas.js';

export type ContractCheck = {
  signatureDiff: boolean;
  domainIsolation: boolean;
  dependencyWhitelist: boolean;
};

export type Phase = 'PREPARED' | 'INSTALLED' | 'RESTART_REQUESTED' | 'ACTIVATED' | 'HEALTHY' | 'DISABLED' | 'ROLLED_BACK';

export type MountTicket = {
  ticketId: string;
  proposalId: string;
  artifactName: string;
  phase: Phase;
  contractCheck: ContractCheck;
  activatedAt: string | null;
  decision: 'AUTO_DEPLOY' | 'PENDING_REVIEW';
  createdAt: string;
  updatedAt: string;
  probeStats: {
    consecutiveSuccess: number;
    consecutiveFailure: number;
    lastProbeAt: string | null;
    lastReason?: string;
  };
};

export type MountResult = {
  ticketId: string;
  proposalId: string;
  phase: Phase;
  contractCheck: ContractCheck;
  activatedAt: string | null;
};

export type RollbackResult = {
  ticketId: string;
  fromPhase: string;
  actions: string[];
  reason: string;
  executedAt: string;
  logWritten?: boolean;
  evolutionWritten?: boolean;
  note?: string;
};

/** in-memory table 接口（与 storageDomain.handle.table 一致） */
export interface TableLike {
  get(id: string): Promise<any | null>;
  put(id: string, entry: any): Promise<void>;
  delete(id: string): Promise<void>;
  entries(): IterableIterator<[string, any]>;
}

/** 真实 dsh host ctx 适配；测试时由 mock 实现 */
export interface MountContext {
  dshHome?: string;

  // 存储（注入由 storageDomain.open(spec) 提供）
  tables?: {
    tickets?: TableLike;
    probe_history?: TableLike;
    rollback_log?: TableLike;
  };

  // 软依赖
  getService?: (name: string) => any;

  // 4 态路径 hooks
  runShell?: (cmd: string, args: string[], opts: { cwd: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  requestRestart?: (leasePath: string) => Promise<void>;
  awaitHmrSettle?: (id: string, timeoutMs: number) => Promise<boolean>;

  // 探针注册（disposer）
  registerEffect?: (disposer: () => void) => void;

  // 事件通道（Sprint 11 直连 evolution；Sprint 12 Event Bus 替换 transport）
  emitEvent?: (channel: 'mount.requested' | 'mount.succeeded' | 'mount.failed', payload: any) => void | Promise<void>;

  // 文件 IO（仅 ACTIVATE 阶段）
  readFile?: (path: string) => Promise<string>;

  // rollback 专用：路径上下文（由 orchestrator 在 ACTIVATE 时填充）
  patchPath?: string;
  backupPath?: string;
  stagingDir?: string;
  sentinelLease?: string;
}

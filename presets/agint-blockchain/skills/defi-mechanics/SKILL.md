---
name: defi-mechanics
description: DeFi 协议机制速查：AMM（Uniswap V2/V3 Curve 恒积 / 恒和 / 集中流动性）、借贷（Aave V3 Compound Morpho 抵押 / 清算 / 利率模型）、Staking / LST（Lido / Rocket Pool / 流动性质押）、流动性挖矿、桥 / Rollup（Optimism / Arbitrum / zkSync / StarkNet 工作原理）、Order Book / Perp（dYdX GMX Hyperliquid）、稳定币（USDC DAI USDT FRAX 算法稳定币）。任务涉及 DeFi 协议集成、机制设计、流动性分析、跨链、收益策略时自动加载。
---

# DeFi Mechanics — 协议机制速查

> 智进·区块链 专属 skill。任务涉及 DeFi 协议集成、机制设计、流动性分析、跨链、收益策略时自动加载。

## 边界

- **适用**：解释协议如何工作、选型机制、画架构、写集成代码。
- **不适用**：合约漏洞排查（→ web3-debug）、ERC 标准（→ evm-patterns）、钱包/签名（→ wallet-security）、RPC 调用模式（→ chain-rpc-toolkit）。

## 一、AMM（自动做市商）

### 1.1 Uniswap V2（恒积）

- 公式：`x * y = k`（x, y 是两种 token 储备）
- 0.3% 手续费 → 加 LP（流动性提供者）按比例分
- 滑点 = swap 越大，价格偏离越多

```solidity
// 定价（不含手续费）
function getAmountOut(uint amountIn, uint reserveIn, uint reserveOut) pure returns (uint) {
    return (amountIn * reserveOut) / (reserveIn + amountIn);
}

// 含 0.3% 手续费
function getAmountOutWithFee(uint amountIn, uint reserveIn, uint reserveOut) pure returns (uint) {
    uint amountInWithFee = amountIn * 997;
    return (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee);
}
```

**已知坑**：
- **无常损失（Impermanent Loss）**：LP 价格波动时，HODL 比 LP 划算。举例：ETH 涨 2x，LP 池只涨 1.43x（少 16%）
- 单 token 流动性易被夹（sandwich）：大单 swap 前先夹单 → 用户滑点更大
- 薄池易被闪电贷操纵（oracle 不能用 V2 spot price）

### 1.2 Uniswap V3（集中流动性）

- LP 选择价格区间 [Pa, Pb]，资本效率提升 4000x
- 不同区间的 LP 形成"ticks"
- 手续费多档：0.05% / 0.3% / 1%

```solidity
// 用 tick 算 sqrtPriceX96
function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160) {
    uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
    // ... 见 Uniswap V3 TickMath 库
}

// 给定金额 X 算出能买多少 Y（考虑价格区间）
function getAmountOut(uint160 sqrtPriceX96, uint160 sqrtPriceTargetX96, uint128 liquidity) pure returns (uint) {
    // ... 见 Uniswap V3 SqrtPriceMath 库
}
```

**已知坑**：
- 区间选错 = 资金空转（价格走出区间就没手续费）
- LP 多头仓要主动 rebalance
- 价格突破区间后 IL 比 V2 更剧烈

### 1.3 Curve（恒和 / StableSwap）

- 公式：`An^n * sum(x_i) + D = An^n * D + (4AD - 1) * (D/(4A))^(n-1) * sum(x_i)`
- 适用于稳定币 / 同类资产（USDC/USDT/DAI）—— 滑点极小
- 包含放大系数 A：曲线越接近恒和 → 滑点越小 → 但偏离价格时损耗越大

**已知坑**：
- 用 Curve 做 oracle 时要小心（Vyper 编译器 bug 历史）
- 3pool / FRAX pool 不同 A 值对滑点影响大
- Curve 用 LP token（CRV 3CRV）做组合（convex / yearn）

### 1.4 Balancer（多资产加权池）

- 任意数量 token 任意权重（80/20、60/20/20 等）
- 公式：通用恒积加权版本
- Boosted pools（与 AAVE 集成）

### 1.5 选型速查

| 场景 | 推荐 |
|---|---|
| 主流币对（ETH/USDC）、价格发现 | Uniswap V2 或 V3 |
| 稳定币（低滑点） | Curve |
| 多资产指数（如 80/20） | Balancer |
| 大额 swap（深度好） | CowSwap（batch auction） |
| 长尾币 | 首选有激励的流动性池 |

## 二、借贷协议

### 2.1 AAVE V3

**核心概念**：
- **抵押品（Collateral）**：存款 aToken，可继续累积利息，1 aToken = 1 底层 + 累计利息
- **债务（Debt）**：borrow stableCoin / other，利率浮动
- **健康因子（Health Factor）**：HF = (抵押品 USD × LTV 阈值) / 债务 USD；HF < 1 → 可被清算
- **清算阈值（Liquidation Threshold, LT）**：抵押品价值跌到 LT 以下可清算（扣 5-15% 罚金）
- **LTV（Loan-to-Value）**：最大借款比例（borrow limit）

```solidity
import "@aave/v3-core/contracts/interfaces/IPool.sol";

// 存款
IPool(pool).supply(asset, amount, onBehalfOf, referralCode);

// 借款
IPool(pool).borrow(asset, amount, interestRateMode, referralCode, onBehalfOf);

// 查询健康因子（per user）
DataTypes.UserConfigurationMap memory config = IPool(pool).getUserConfiguration(user);
uint256 hf = IPool(pool).getUserAccountData(user);  // 返回 totalCollateralBase, totalDebtBase, availableBorrowsBase, ltv, lt, healthFactor
```

**利率模型**：
- 资金利用率 U = totalBorrows / (totalBorrows + availableLiquidity)
- 当 U < Uoptimal（如 80%）：borrowRate = baseRate + (U / Uoptimal) * slope1
- 当 U ≥ Uoptimal：borrowRate = baseRate + slope1 + ((U - Uoptimal) / (1 - Uoptimal)) * slope2
- aToken 利率 = borrowRate * U（剩余给存款人）

**已知坑**：
- 利率跳跃函数：利用率突破 80% 后利率暴涨（清算诱因）
- 抵押品 + 债务组合波动时 HF 变化非线性
- eMode：相关性强的资产可放大 0.93 LTV（如 ETH/stETH）
- 清算奖励 / closeFactor：单次清算最多还 50% 债务
- 新版 V3 引入 GHO 稳定币 + Portal 跨链

### 2.2 Compound V2 / V3

**V2**：
- cToken（CToken）= cETH / cUSDC，每个 cToken 汇率不断上升
- 借款利率模型与 AAVE 类似
- 治理代币 COMP

**V3**：
- Comet（单一资产）：每个池只支持一种 borrowAsset，多种 collateral
- 简化操作、提高资本效率
- abs(token.balanceOf(account) - borrowBalance) > dustThreshold → 没收 dust 到 reserve

### 2.3 Morpho Blue

- 优化 AAVE/Compound 上的 P2P 匹配
- 无治理、无 oracle 操纵面（用 AAVE oracle）
- 当 P2P 匹配失败时 fall back 到 underlying AAVE pool

### 2.4 MakerDAO / Sky（Spark）

- CDP（Collateralized Debt Position）：抵押 ETH 等生成 DAI
- DSR（Dai Savings Rate）：DAI 存款利率
- PSM（Peg Stability Module）：1:1 兑换 USDC 等稳定币
- Vault 清算：collateral 拍卖 → 还债 → 剩余给 owner

### 2.5 速查

| 场景 | 推荐 |
|---|---|
| 主流抵押 / 借款 | AAVE V3（最大流动性） |
| 单一抵押品池（ETH only） | Compound V3（更便宜） |
| P2P 优化（小额） | Morpho Blue |
| 稳定币存款 | MakerDAO DSR / Sky Savings |
| 杠杆 / 循环借贷 | AAVE eMode + flash loan |

## 三、Staking / LST（流动性质押）

### 3.1 Lido（stETH）

- 1 ETH → 1 stETH（rebase 版本） 或 wstETH（wrap 版本）
- stETH 余额每天 rebase 增加（按 epoch）
- wstETH 余额不变，价值累积
- 节点运营商质押 → 获得 ETH 奖励 → 扣除 10% 给 Lido DAO

**已知坑**：
- stETH 在 Curve stETH/ETH 池有段时间 -3% 偏离（Terra 崩盘时）
- 现在大多用 wstETH 跨协议集成（不会 rebase）
- Lido 通过 Snapshot 投票选 validator，目前 30+ 个运营商

### 3.2 Rocket Pool（rETH）

- 1 rETH 不是 1 ETH，价格随时间上涨
- 8 ETH 最低门槛（4 来自 operator、4 来自 pool）
- rETH 是 ERC20，直接 DeFi 集成

### 3.3 流动性质押代币（LST）对比

| 项目 | 代币 | 1:1 锚定 | 提取期 | DeFi 集成度 |
|---|---|---|---|---|
| Lido | stETH / wstETH | 否（汇率累积） | 1-5 天 | ⭐⭐⭐⭐⭐ |
| Rocket Pool | rETH | 否 | 很快 | ⭐⭐⭐⭐ |
| Frax | sfrxETH | 否 | 7-21 天 | ⭐⭐⭐ |
| Mantle | mETH / cmETH | 否 | 7 天 | ⭐⭐⭐ |
| Binance | WBETH | 否 | 立即（中心化） | ⭐⭐⭐ |

### 3.4 EigenLayer（再质押）

- 把 ETH 或 LST 重新质押给 EigenLayer operator
- operator 提供 AVS（Actively Validated Services）服务
- 用户获得额外收益 + 额外 slashing 风险

**已知坑**：
- 重叠 slashing 风险（同一笔 ETH 多次 slashing）
- AVS 收益不稳定
- 退出期可能长

## 四、流动性挖矿

### 4.1 MasterChef / StakingRewards 模式

```solidity
contract StakingRewards is IERC20 {
    uint public rewardRate;       // 每秒发放 token 数
    uint public rewardPerTokenStored;
    mapping(address => uint) public userRewardPerTokenPaid;
    mapping(address => uint) public rewards;

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    function stake(uint amount) external updateReward(msg.sender) { /* ... */ }
    function withdraw(uint amount) external updateReward(msg.sender) { /* ... */ }
    function getReward() external updateReward(msg.sender) { /* ... */ }
}
```

### 4.2 经典模式

- **MasterChef**（PancakeSwap）：每区块固定发放，按 LP 比例分配
- **StakingRewards**（Synthetix）：基于 staking 时长
- **veToken**（Curve）：锁仓得 veToken，按权重投票拿激励（永久 + 不可转让）

### 4.3 已知坑

- **APY ≠ APR**：APY 含复利，会随 token 价格波动剧烈
- **激励 = 抛压**：挖到的 token 多砸盘
- **ve 模型**锁仓期长（最长 4 年），流动性差
- **bootstrap 阶段**APY 虚高（很快跌到实际值）

## 五、桥 / Rollup

### 5.1 Optimistic Rollup（Optimism, Arbitrum）

- 假设交易有效（optimistic）
- 7 天挑战期（Fraud Proof）
- Sequencer 排序交易 → 把 batch 提交到 L1
- 用户从 L2 → L1 提款需 7 天（fast withdrawal 服务商提供即时）

### 5.2 ZK Rollup（zkSync, StarkNet, Polygon zkEVM, Scroll, Linea）

- 每个 batch 生成 ZK 证明，提交到 L1 验证
- 提款几分钟到几小时
- 复杂度高，证明系统（Plonk / STARK）

### 5.3 Validium（StarkEx）

- 数据不上 L1（off-chain data availability）
- 提款期长（依赖 DA 层）
- dYdX / Sorare / Immutable 用过

### 5.4 跨链桥

| 类型 | 项目 | 速度 | 安全 |
|---|---|---|---|
| Native Rollup | Arbitrum / Optimism | L1 最终性 7 天 | ⭐⭐⭐⭐⭐（继承 L1） |
| ZK Rollup | zkSync / StarkNet | 几分钟 | ⭐⭐⭐⭐⭐ |
| Canonical | Wormhole / LayerZero | 看实现 | 看实现 |
| Liquidity | Synapse / Stargate | 立即 | ⭐⭐⭐（依赖 AMM） |
| Hash Time-Lock | Connext | 看实现 | ⭐⭐⭐ |

**已知坑**：
- 跨链消息不安全（multisig 桥被攻击历史：Ronin、Wormhole、Harmony）
- 优先使用 native rollup 或 canonical 桥
- 流动性桥（如 Stargate）有池子深度风险

## 六、Order Book / Perp DEX

### 6.1 dYdX

- Layer 2 StarkEx validium（已迁移到 dYdX Chain，基于 Cosmos SDK）
- Order book + 永续合约
- 部分抵押

### 6.2 GMX（GLP 模型）

- GLP 是"LP token"，对手方是 trader
- trader 盈亏 → GLP 持有人分摊
- 资金费率模型

### 6.3 Hyperliquid

- 自定义 L1（HyperBFT 共识）
- Order book + 永续
- 交易延迟 < 1s

### 6.4 选型

| 需求 | 推荐 |
|---|---|
| 大杠杆、专业交易 | dYdX / Hyperliquid |
| 长尾资产、被动做市 | GMX |
| 现货 + 简单永续 | Vertex / Drift |

## 七、稳定币

### 7.1 法币抵押（USDC, USDT, PYUSD）

- 中心化机构 1:1 储备 USD
- 可被冻结（OFAC 制裁）
- 风险：储备金透明度、监管

### 7.2 超额加密抵押（DAI, RAI）

- MakerDAO 等用 ETH 等超额抵押生成
- DAI 通过 PSM 与 USDC 1:1 兑换
- RAI 不锚定 1 USD，自由浮动

### 7.3 算法稳定币（FRAX, UST）

- 部分抵押 + 算法调节
- 历史多次崩盘（Terra UST）
- FRAX 现已转向完全抵押

### 7.4 速查

| 稳定币 | 类型 | 风险 |
|---|---|---|
| USDC | 中心化抵押 | 监管 |
| USDT | 中心化抵押 | 监管 / 储备金透明度 |
| DAI | 超额抵押 | 抵押品波动 |
| FRAX | 现已混合 | 历史 |
| sUSD | Synthetix | 抵押品 |

---

## 关联阅读

- [[web3-debug]] — 漏洞排查
- [[evm-patterns]] — ERC 标准、Proxy
- [[wallet-security]] — 钱包/签名
- [[chain-rpc-toolkit]] — 链交互工具
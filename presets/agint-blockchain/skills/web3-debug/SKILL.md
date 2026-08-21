---
name: web3-debug
description: 区块链/Web3 调试速查手册：Solidity / Rust 合约 revert 与自定义错误解码、RPC 节点排查与交易追踪、Gas 优化、合约漏洞模式（重入 / 抢跑 / MEV / oracle 操纵 / 签名重放 / 整数溢出 / 访问控制缺失）的快速识别与定位。Foundry / Hardhat / Anchor 调试栈使用规范。当任务涉及合约报错、链上交易失败、Gas 异常、漏洞排查、链上异常行为分析时自动加载。
---

# Web3 Debug — 区块链/Web3 调试速查

> 智进·区块链 专属 skill。任务匹配"合约报错 / revert / 链上交易失败 / Gas 异常 / 漏洞 / 抢跑 / MEV / RPC 异常"等 trigger 时自动加载。

## 边界

- **适用**：合约 revert 解码、交易追踪、Gas 分析、漏洞模式识别、RPC 节点排查、链上异常行为归因。
- **不适用**：合约业务逻辑设计（→ evm-patterns）、协议机制讲解（→ defi-mechanics）、RPC 客户端选型（→ chain-rpc-toolkit）、钱包/签名实现（→ wallet-security）。
- **永远不要在 mainnet 真实资产上做未经验证的实验**——用测试网、tenderly 模拟、anvil 本地节点先跑。

## 一、Solidity revert 与自定义错误解码

### 1.1 拿到 revert 原因

| 调试栈 | 命令/调用 |
|---|---|
| Foundry / forge | `forge test -vvvv`（4 个 v 拿 trace） |
| Foundry trace | `cast run <txHash> --rpc-url <rpc>` |
| Hardhat | `hardhat console.log` / `hardhat test --logs` |
| Tenderly | 浏览器 trace + 自动 revert 原因 |
| 浏览器 / 钱包 | Etherscan / Blockscout "Click to see Revert Reason" |

### 1.2 自定义错误解码

```solidity
// 合约定义
error InsufficientBalance(uint256 available, uint256 required);
error Unauthorized(address caller);

// 用 cast 解码
cast 4byte-decode 0xcf4791810000000000000000000000000000000000000000000000000000000000000064
# 0x...64 = 100（自定义错误的参数）

# 完整流程：拿到 revert data → 找到 selector → 查 ABI → 解码
cast call <addr> "balanceOf(address)(uint256)" 0xYour --rpc-url <rpc>
```

### 1.3 常见 revert 模式速查

| Revert 字符串 | 含义 | 排查方向 |
|---|---|---|
| `insufficient balance` | ERC20 余额不足 | approve 额度 / 实际余额 / 小数位 |
| `transfer amount exceeds allowance` | ERC20 allowance 不够 | approve 事件是否成功 / allowance view |
| `execution reverted: revert` | 无 message 的 revert | 上源码看 require / error / assert |
| `Panic(0x11)` | 算术溢出（Sol ≥0.8 自动） | 检查 unchecked 块、强制 0.8 之前代码 |
| `Panic(0x12)` | 除以 0 | 除法前 divisor ≠ 0 校验 |
| `Panic(0x21)` | 数组越界 | 索引变量来源 |
| `Panic(0x31)` | 空数组 pop | array.pop() 前 length > 0 |
| `out of gas` | Gas limit 不够 | 复杂循环 / 存储写 / 外部调用多 |
| `invalid opcode` | assert 失败 / 编译器版本不一致 | assert 条件 / 编译器版本 lock |
| `Address: call to non-contract` | extcodesize == 0 | 目标地址是 EOA / 未部署 / selfdestruct 后 |
| `SafeERC20: low-level call failed` | transfer 返回 false | 代币有 fee / blacklist / hooks（USDT/SAITAMA） |

### 1.4 多调用场景

```solidity
// multicall / try-catch 包裹的 revert
try IERC20(token).transfer(to, amount) {
    // success
} catch (bytes memory reason) {
    if (reason.length == 0) revert("no reason");
    // 4-byte selector 起步解
    bytes4 selector;
    assembly { selector := mload(add(reason, 0x20)) }
}
```

## 二、RPC 节点排查

### 2.1 节点类型

| 类型 | 用途 | 延迟 | 信任假设 |
|---|---|---|---|
| 自建节点 (geth / reth / nethermind / besu) | 隐私 / 抗审查 / archive | 低 | 自己 |
| 公共 RPC (Infura / Alchemy / QuickNode) | 开发 / dApp 后端 | 中 | 第三方 |
| Tenderly Fork / Virtual TestNet | mainnet 状态 + 测试网操作 | 低 | Tenderly |
| Anvil (本地) | 本地开发 / fuzz | 极低 | 本地 |

### 2.2 常见 RPC 错误排查

| 错误 | 排查方向 |
|---|---|
| `connection refused` | 节点未启动 / 端口错 / 防火墙 |
| `timeout` | 节点同步落后 / 网络分区 / 提高 timeout |
| `insufficient funds for gas*price` | sender 余额 < gasLimit × gasPrice |
| `nonce too low` | 已有同 nonce 交易 pending / 已被打包 / 重置 nonce |
| `replacement transaction underpriced` | 替换 pending 交易时新 gasPrice 至少 +10% |
| `max fee per gas less than block base fee` | EIP-1559 maxFeePerGas 不够 / 用 eth_gasPrice 估算 |
| `execution reverted` | → 一、revert 解码 |
| `unknown transaction` | txHash 不存在 / 节点未同步 / 换正确 chain id |
| `eth_call reverted without reason string` | 不带 message 的 revert，源码查 require |

### 2.3 关键调用

```js
// ethers.js v6
const tx = await provider.getTransaction(txHash);
const receipt = await provider.getTransactionReceipt(txHash);
const trace = await provider.send('debug_traceTransaction', [txHash, { tracer: 'callTracer' }]);
const stateOverride = await provider.send('eth_call', [{to, data, from}, 'latest', {stateOverride: {...}}]);

// 重放某笔交易的完整 trace
const replay = await provider.send('eth_call', [
  {from: tx.from, to: tx.to, data: tx.data, value: tx.value},
  tx.blockNumber
]);
```

### 2.4 链分叉 / Reorg 检测

```js
// ethers v6
provider.on('block', async (blockNumber) => {
  const block = await provider.getBlock(blockNumber);
  if (block && block.parentHash !== lastParentHash) {
    // 出现 reorg
    console.warn(`reorg at ${blockNumber}, parentHash changed`);
  }
  lastParentHash = block.parentHash;
});
```

## 三、交易追踪 / Trace

### 3.1 Foundry cast trace

```bash
# 单笔交易 trace
cast run 0xTxHash --rpc-url $ETH_RPC

# 用 tenderly fork 重放（mainnet 状态 + 测试操作）
forge test --fork-url $ETH_RPC --fork-block-number 19000000

# 4 个 v 看完整 trace + 日志
forge test -vvvv
```

### 3.2 Tenderly

- 上传合约源码 → 自动 trace + 解码 revert
- `https://dashboard.tenderly.co/tx/<chain>/<txHash>`
- 模拟（Simulator）：fork 任意 blockNumber，改状态后模拟交易

### 3.3 Etherscan / Blockscout

- "Logs" 看事件
- "State Changes" 看存储读写
- "Internal Transactions" 看合约间 call
- "Click to see Revert Reason"（部分链）

## 四、Gas 优化

### 4.1 EIP-1559 gas 设置

```js
// ethers v6
const feeData = await provider.getFeeData();
const maxFeePerGas = feeData.maxFeePerGas * 12n / 10n;  // +20% buffer
const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;

// 紧急加速
const replacement = await signer.sendTransaction({
  ...originalTx,
  maxFeePerGas: maxFeePerGas * 15n / 10n,  // +50%
  maxPriorityFeePerGas: maxPriorityFeePerGas * 2n,
});
```

### 4.2 合约层 Gas 优化速查

| 优化项 | 节省 | 风险 |
|---|---|---|
| `uint256` → `uint128` / `uint96`（pack 进 slot） | ~20k gas/次 SLOAD | 溢出风险 |
| `mapping` 替代 `array`（无序查找） | ~20k gas/次 | 删除成本上升 |
| `calldata` 替代 `memory`（外部函数参数） | ~3-6 gas/byte | 不可修改 |
| 内部函数 `private` / `internal` | 函数选择器 + JUMP 成本 | 不可外部调用 |
| `unchecked` 块（已知不会溢出） | ~30-50 gas/次 | 安全审计必须 |
| `constant` / `immutable` | SLOAD → PUSH | 必须编译时定 |
| `assembly` 内联 storage 写 | ~100 gas/次 | 可读性 / 安全 |
| 短地址字符串 / `bytes32` 替代 `string` | ~20k gas/byte | 编码限制 |
| 用事件替代链下可读的存储 | 375 gas/log + 8 gas/topic | 不能链上读 |
| 批量转账 / Merkle tree airdrop | O(N) → O(1) | 离线签名复杂度 |
| 复用已有合约（OpenZeppelin） | 标准化 + 审计 | 依赖 |

### 4.3 Storage 布局

```solidity
// ❌ 3 个 slot
uint256 a;
uint128 b;  // slot 1
uint128 c;  // slot 1
uint256 d;  // slot 2

// ✅ 2 个 slot（pack b+c 到同一 slot）
uint256 a;
uint256 d;  // 重排
uint128 b;
uint128 c;
```

升级合约时 storage layout 不能改 → 用 `@custom:storage-location` 或 `ERC-7201`（Namespaced Storage）。

## 五、合约漏洞模式识别

### 5.1 重入（Reentrancy）

**症状**：单笔交易中余额/状态被读取多次，调用方在状态更新前回调合约。

```solidity
// ❌ 经典重入
function withdraw() external {
    uint256 bal = balances[msg.sender];
    require(bal > 0);
    (bool ok,) = msg.sender.call{value: bal}("");
    balances[msg.sender] = 0;  // ← 状态更新在 call 之后
}

// ✅ Checks-Effects-Interactions
function withdraw() external {
    uint256 bal = balances[msg.sender];
    require(bal > 0);
    balances[msg.sender] = 0;  // ← 先改状态
    (bool ok,) = msg.sender.call{value: bal}("");
    require(ok);
}
```

**排查清单**：
- 任何 `address.call{value: ...}("")` 后还有状态写
- `nonReentrant` modifier 是否覆盖所有外部函数
- 跨函数重入（不同函数间通过共享状态触发）
- 跨合约重入（两个合约互调，第三方回调）
- read-only reentrancy（view 函数被回调读到中间状态）

### 5.2 抢跑 / MEV

**症状**：mempool 公开交易被 bot 监视、sandwich attack、三明治攻击。

```solidity
// ❌ 大单 swap 在 mempool 公开
function swap(uint amountIn, uint minOut) external {
    // ...
}

// ✅ 提交-揭示（commit-reveal）或 use 私有 mempool（Flashbots）
// 或 use slippage protection: minOut 必须合理
```

**排查清单**：
- 大额 swap 是否走 Flashbots / private mempool
- slippage tolerance 是否过宽（> 1% 可能被 sandwich）
- `block.timestamp` / `block.number` 依赖是否被操纵
- 链上 oracle（Uniswap TWAP）是否被闪电贷操纵
- 抢跑拍卖（mev-blocker / cow.protocol）

### 5.3 Oracle 操纵

**症状**：单一交易所价格被大单瞬间砸盘 → 借贷协议 / 衍生品以错误价格结算。

```solidity
// ❌ 用 Uniswap spot price（单 slot TWAP 不可信）
uint price = IUniswapV2Pair(pair).getReserves().reserve0 / IUniswapV2Pair(pair).getReserves().reserve1;

// ✅ Chainlink Price Feed（多源聚合，难操纵）
uint price = IChainlinkAggregator(feed).latestRoundData().answer;

// ✅ Uniswap V3 TWAP（≥30 分钟窗口）
uint price0Cumulative = IUniswapV3Pool(pool).observe(secondsAgo)[0];
```

### 5.4 签名重放

**症状**：用户签名一次，被攻击者在另一链 / 另一合约重复使用。

```solidity
// EIP-712 domain separator 包含 chainId
bytes32 DOMAIN_SEPARATOR = keccak256(abi.encode(
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    keccak256(bytes(name)),
    keccak256(bytes("1")),
    block.chainid,        // ← 防跨链重放
    address(this)         // ← 防跨合约重放
));

// nonce 递增
mapping(address => uint) public nonces;
```

### 5.5 整数溢出

- Solidity ≥ 0.8 默认 SafeMath，溢出自动 revert
- `unchecked` 块必须人工审计
- 0.8 之前代码（legacy / forked）必须显式 SafeMath

### 5.6 访问控制缺失

```solidity
// ❌ mint 函数无权限检查
function mint(address to, uint amount) external {
    _mint(to, amount);
}

// ✅ onlyOwner / AccessControl / Role-Based
function mint(address to, uint amount) external onlyOwner {
    _mint(to, amount);
}
```

**排查清单**：
- `public` / `external` 函数是否需要 `onlyOwner`
- initializer / constructor 是否设置 admin
- 升级合约是否锁定 implementation
- proxy admin 是否多签
- 是否依赖 tx.origin（应改为 msg.sender）

### 5.7 拒绝服务（DoS）

```solidity
// ❌ 循环遍历 unbounded array
function distribute() external {
    for (uint i = 0; i < holders.length; i++) {
        payable(holders[i]).transfer(amounts[i]);
    }
    // 某 holder revert → 全部 revert → DoS
}

// ✅ pull payment（让用户自己 claim）
mapping(address => uint) public claimable;
function claim() external {
    uint amt = claimable[msg.sender];
    claimable[msg.sender] = 0;
    payable(msg.sender).transfer(amt);
}
```

### 5.8 Front-running / 抢跑特定函数

**症状**：用户提交交易 → bot 监视 mempool → 复制/修改后抢跑打包。

- 用 commit-reveal 协议（提交 hash，揭示明文）
- 用私有 mempool（Flashbots Protect / MEV Blocker）
- 用 batch auction（CoW Protocol）

## 六、调试栈使用规范

### 6.1 Foundry（推荐现代 EVM 项目）

```bash
# 初始化
forge init myproject --no-commit
cd myproject

# 编译
forge build

# 测试（-vvvv 看完整 trace）
forge test -vvvv

# 覆盖率
forge coverage

# Gas 报告
forge test --gas-report

# 模糊测试（fuzz）
forge test --fuzz

# 不变量测试（invariant）
forge test --invariant

# 形式化验证（certora / mythril 集成）
forge certora-run contracts/MyContract.sol:MyContract --verify MyContract.spec
```

### 6.2 Hardhat（JS/TS 项目）

```bash
# 初始化
npx hardhat init

# 测试
npx hardhat test

# 控制台（本地节点 REPL）
npx hardhat console

# fork mainnet
npx hardhat node --fork https://eth-mainnet.g.alchemy.com/v2/KEY

# 调试单笔交易
npx hardhat test --grep "test name" (加 console.log 看)
```

### 6.3 Anchor（Solana）

```bash
# 初始化
anchor init myproject

# 构建 + 测试
anchor build
anchor test

# 本地 validator
anchor test --skip-local-validator  # 用现成 validator

# 部署到 devnet/testnet/mainnet
anchor deploy --provider.cluster devnet
```

## 七、紧急事故应对

| 现象 | 第一步 |
|---|---|
| 合约被攻击 / 资产被盗 | 立即 pause（如果有）、紧急公告、联系白帽 / 项目方 |
| 用户资金卡在合约 | 评估 rescue 函数、proxy 升级、多签 vote |
| 关键私钥泄露 | 立即转移所有控制权到新地址，旧地址作废 |
| 上线后发现漏洞 | emergency shutdown → 发公告 → 修复 → 复盘写 memory |
| Chain ID 不一致 | 检查 `block.chainid`、RPC 配置、钱包网络 |

---

## 关联阅读

- [[evm-patterns]] — EVM 合约模式库
- [[defi-mechanics]] — DeFi 协议机制速查
- [[wallet-security]] — 钱包/签名安全模式
- [[chain-rpc-toolkit]] — 链交互工具链

> 教训 → `memory_write type=lesson`，附证据：链名/区块/交易哈希或文档链接。
---
name: wallet-security
description: 钱包与签名安全模式库：EOA / 合约钱包（智能合约钱包 / 账户抽象 / EIP-4337）、EIP-712 类型化结构签名（Permit / MetaTx / Order）、EIP-2612 permit（gasless approve）、multisig（Gnosis Safe）、签名重放防护（domain separator + chainId + nonce + deadline）、钱包集成（wagmi / RainbowKit / WalletConnect / Solana Wallet Adapter）、私钥管理与硬件钱包（Ledger / Trezor）、签名钓鱼与 scam 识别。任务涉及钱包实现、签名流程、链下签名验证、账户抽象集成、私钥管理时自动加载。
---

# Wallet Security — 钱包与签名安全

> 智进·区块链 专属 skill。任务涉及钱包实现、EIP-712 签名、链下签名验证、账户抽象集成、私钥管理、签名安全审计时自动加载。

## 边界

- **适用**：钱包选型、签名流程实现、安全审计、scam 识别。
- **不适用**：RPC 客户端（→ chain-rpc-toolkit）、合约漏洞（→ web3-debug）、协议机制（→ defi-mechanics）。

## 永远不要做的事（红线）

1. **永远不要** 把私钥 / 助记词写进任何代码、配置文件、聊天记录、wiki、memory
2. **永远不要** 在 mainnet 真实资产上做未经验证的实验
3. **永远不要** 让合约的 admin 私钥是 hot wallet（用多签 / timelock）
4. **永远不要** 在 approve 时给无限授权（除非必要，且定期清理）
5. **永远不要** 信任 EIP-712 域检查之外的方式做签名验证

## 一、账户模型

### 1.1 EOA（Externally Owned Account）

- 公钥 → 地址（20 字节 = `keccak256(pubkey)[-20:]`）
- 私钥 32 字节，签名算法 ECDSA（secp256k1）
- 唯一能"主动发起交易"的账户类型
- 无代码逻辑、无恢复机制

### 1.2 合约账户（Contract Account）

- 由 EOA 或另一合约部署
- 代码 + storage（无独立私钥）
- 只能通过 EOA / 其它合约调用来执行
- EIP-4337 之前，需 EOA 帮"付 gas"（meta-transaction）

### 1.3 智能合约钱包（Smart Contract Wallet）

**经典例子**：
- Gnosis Safe：多签合约钱包
- Argent：社交恢复 + Guardian
- InstaDApp / Authio / Dapper

**优势**：
- 可编程（每日限额、白名单、冻结、批量交易）
- 社交恢复（不用记助记词）
- 多签
- Gas 代付（relayer）

### 1.4 账户抽象（Account Abstraction, EIP-4337）

```
UserOperation (intention) → Bundler → EntryPoint合约 → Account合约执行
                        ↑
                  Paymaster可选（代付 gas）
```

**关键概念**：

| 角色 | 作用 |
|---|---|
| UserOperation | 用户意图的封装（sender, to, data, gas, signature, ...） |
| Bundler | 收集 UserOp 打包成 transaction |
| EntryPoint | 单一合约 0x0000000071727De22E5E9d8BAf0edAc6f37da032 |
| Account | 用户的合约钱包，必须实现 validateUserOp |
| Paymaster | 可选，代付 gas（用 paymasterAndData 字段） |

**EIP-4337 v0.7 关键接口**：

```solidity
interface IAccount {
    function validateUserOp(UserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external returns (uint256 validationData);
}

interface IPaymaster {
    function validatePaymasterUserOp(UserOperation calldata userOp, bytes32 userOpHash, uint256 maxCost)
        external returns (bytes memory context, uint256 validationData);
}
```

**优势**：
- 任何合约都能成为钱包
- 社交恢复、批量调用、gas 代付、子账户、自动支付
- 不需要 EIP-3074（"AA 半步"）

**实现栈**：
- **基础设施**：Infinitism (EntryPoint)、Alchemy (AA SDK)、Stackup、Biconomy、Pimlico、Etherspot
- **钱包 SDK**：Safe{Core}、ZeroDev Kernel、Biconomy Smart Account
- **前端**：wagmi + permissionless.js / Biconomy SDK

### 1.5 EOA vs AA 选型

| 场景 | 推荐 |
|---|---|
| 普通用户钱包（dApp 集成） | EOA（MetaMask）+ 未来切 AA |
| 高价值资产 / 团队 treasury | 多签（Safe） |
| 复杂业务逻辑（限额、白名单） | AA（Kernel, Biconomy） |
| 想要 gasless（项目代付） | AA + Paymaster |
| 链上游戏 / NFT mint 用户 | AA（防 bot + 代付 gas） |

## 二、EIP-712 类型化结构签名

### 2.1 为什么需要 EIP-712

**纯文本签名（`personal_sign`）**：
- 只能看到一串十六进制
- 用户被骗签恶意数据（钓鱼攻击：用户以为签的是某个事务，实际签的是无限 approve）
- Phishing.com 2018 年攻击中被滥用

**EIP-712 改进**：
- 签名前，wallet 显示**结构化的数据**（订单详情、Permit 信息等）
- 用户能在 wallet UI 看到「我到底签了什么」
- 包含 domain、chainId、verifyingContract 防重放

### 2.2 EIP-712 Domain

```solidity
bytes32 constant EIP712DOMAIN_TYPEHASH = keccak256(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
);

bytes32 public DOMAIN_SEPARATOR;

constructor(string memory name_, string memory version_) {
    DOMAIN_SEPARATOR = keccak256(abi.encode(
        EIP712DOMAIN_TYPEHASH,
        keccak256(bytes(name_)),
        keccak256(bytes(version_)),
        block.chainid,
        address(this)
    ));
}
```

**关键字段**：
- `name`：协议名
- `version`：协议版本（升级时递增）
- `chainId`：防跨链重放
- `verifyingContract`：防跨合约重放
- 可选：salt、extensions（forkId for cross-chain replay protection）

### 2.3 结构化 hash

```solidity
// 定义结构
bytes32 constant PERMIT_TYPEHASH = keccak256(
    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
);

// 链下签名
bytes32 structHash = keccak256(abi.encode(
    PERMIT_TYPEHASH,
    owner, spender, value, nonces[owner]++, deadline
));

// EIP-712 digest
bytes32 digest = keccak256(abi.encodePacked(
    "\x19\x01",
    DOMAIN_SEPARATOR,
    structHash
));

// 签名
(uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);

// 链上验证
function permit(address owner, address spender, uint value, uint deadline, uint8 v, bytes32 r, bytes32 s) external {
    require(block.timestamp <= deadline, "expired");
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))));
    address recovered = ecrecover(digest, v, r, s);
    require(recovered == owner, "invalid sig");
    _approve(owner, spender, value);
}
```

### 2.4 已知坑

- **签名重放**：必须包含 `chainId`、`verifyingContract`、`nonce`、`deadline`
- **死循环签名**：链下签名不带 nonce 时可被无限重放 → 必须每次递增 nonce
- **ecrecover malleability**：签名 `(v, r, s)` 和 `(v', r, s)`（v 翻转）在某些链上等效 → OpenZeppelin ECDSA 库帮你处理
- **跨链 fork**：同一合约在不同链有相同地址 → 必须 chainId
- **deadline 太长**：签 1 年有效期的 permit → 用户风险
- **deadline 太短**：签 5 分钟有效 → 用户 UX 差

### 2.5 速查

| 场景 | EIP-712 + ... |
|---|---|
| Permit（gasless approve） | + nonce + deadline |
| Meta-Transaction（gas 代付） | + relayer + fee |
| Order / Limit Order（0x, CoW） | + salt（订单 ID） |
| Vote | + snapshotId |
| EIP-712 NFT Order（OpenSea Seaport） | + 全字段 |

## 三、Permit（EIP-2612）

### 3.1 链下流程

1. 用户在 dApp 看到 token X 需要 approve 给 router
2. dApp 让用户签名 `Permit(owner, spender, value, nonce, deadline)`
3. 用户在 wallet UI 看到 "Approve 100 USDC to Router until 2024-12-31"
4. 用户签名（不付 gas）
5. dApp 提交 `permit()` 交易 + `transferFrom()` 到 router（一笔交易搞定）

### 3.2 与传统 approve 对比

| | 传统 approve | Permit |
|---|---|---|
| 交易数 | 2（approve + transferFrom） | 1（permit + transferFrom） |
| 用户付 gas | approve 时 | 0（relayer 付） |
| UX | 多步 | 一步 |
| 风险 | 无限 approve 被钓鱼 | 签名就是交易，注意死循环 |

### 3.3 库

- OpenZeppelin：`ERC20Permit`
- Uniswap V2 Router：支持 permit（`swapExactTokensForTokens` + `??WithPermit`）

## 四、Meta-Transaction（链下签名 + relayer 付 gas）

### 4.1 流程

```
用户 → 签 data + nonce + relayer + fee → relayer 收单 → 提交链上 → 合约用 ecrecover 验证 → 执行
```

### 4.2 实现（OpenZeppelin ECDSA + ERC2771）

```solidity
import "@openzeppelin/contracts/metatx/ERC2771Context.sol";

contract MyContract is ERC2771Context {
    constructor(address trustedForwarder) ERC2771Context(trustedForwarder) {}

    function _msgSender() internal view override(ERC2771Context, Context) returns (address) {
        return ERC2771Context._msgSender();
    }
}
```

relayer 用 OpenZeppelin Defender / Biconomy 等。

## 五、多签（Multi-Signature）

### 5.1 Gnosis Safe（现 Safe{Wallet}）

**核心**：
- N 个 owners，M/N 阈值（例 3/5）
- 通过 `execTransaction` 执行，触发事件让其他 owners 确认
- 阈值满足后 transaction hash 上链
- 支持：硬件钱包 owner、模块化扩展（Safe Modules）、Chainlink Defender 集成

**适用**：
- 项目 treasury
- 合约 admin / upgrade
- 任何资产 ≥ 100k USD 的关键操作

### 5.2 多签 vs 单签对比

| | 单签 | 多签（Safe） |
|---|---|---|
| 风险 | 1 个密钥泄露 = 全失 | 需 M 个密钥同时泄露 |
| 操作 | 1 步 | M 步（多 owner 协调） |
| 适用 | 个人项目 | 团队 / 资产 |

### 5.3 Safe 集成代码

```ts
import SafeApiKit from '@safe-global/api-kit';
import Safe from '@safe-global/safe-protocol-kit';
import { ethers } from 'ethers';

const safeService = new SafeApiKit({ txServiceUrl: 'https://safe-transaction-mainnet.safe.global' });
const safeSdk = await Safe.init({
  provider: window.ethereum,
  safeAddress: '0xSafeAddr',
});

const safeTransaction = await safeSdk.createTransaction({
  transactions: [{
    to: '0xTokenAddr',
    data: erc20Interface.encodeFunctionData('transfer', ['0xRecipient', '100000000']),
    value: '0',
  }],
});

const safeTxHash = await safeSdk.getTransactionHash(safeTransaction);
const senderSignature = await safeSdk.signHash(safeTxHash);

// 其他 owner 通过 API 收集签名
await safeService.proposeTransaction({
  safeAddress: safeSdk.getAddress(),
  safeTransactionData: safeTransaction.data,
  safeTxHash,
  senderAddress: await signer.getAddress(),
  senderSignature: senderSignature.data,
});

// 阈值满足后任一 owner 执行
await safeSdk.executeTransaction(safeTransaction);
```

## 六、签名钓鱼 / Scam 识别

### 6.1 常见模式

| Scam | 识别 |
|---|---|
| 假装 wallet update | 让你签 setApprovalForAll（无限授权 NFT） |
| 假装 refund | 让你签 setOwner（把 Safe 所有权转给 attacker） |
| 钓鱼空投 | "claim" 按钮实际上是 permit（无价值 → 无价值，但给了签名权） |
| 假 website | URL 错位（uniswop.com / mewtopia.com） |
| Discord 私信 | "官方人员" 让你签某笔交易 |
| Permit2 通用授权 | 一旦签了，attacker 可用任意 token 调用你的签名 |

### 6.2 防钓鱼清单

- **永远检查 URL**（HTTPS + 拼写）
- **看 wallet 显示的 EIP-712 数据**（不要盲签）
- **用专用钓鱼检测工具**：Scam Sniffer、Wallet Guard
- **冷钱包存大钱**（Ledger / Trezor + 热钱包日常用）
- **定期撤销授权**：revoke.cash、Etherscan Token Approval
- **不要在 Twitter / Discord 私聊中处理交易**

### 6.3 撤销授权

- **revoke.cash**：列出所有 approve，可一键 revoke
- **Etherscan Token Approval**：同功能
- **批准有限额度 + 短有效期**

## 七、私钥管理

### 7.1 私钥生命周期

```
生成 → 备份（纸 / 硬件 / 分片） → 使用（签 / 解锁） → 退役（销毁 + 转资产）
```

### 7.2 推荐方案

| 场景 | 存储 | 备注 |
|---|---|---|
| 日常 dApp | MetaMask / Rabby | 热钱包，小额 |
| 项目方 treasury | Safe 多签 | 至少 3/5 |
| 个人大额 | 硬件钱包（Ledger / Trezor） | 冷存储 |
| 自动化脚本 | KMS（AWS / GCP）+ relayer | 工业级 |
| 团队 bot | 多签 + 单独 signer | 不要单签 bot |

### 7.3 私钥安全守则

1. **永不联网**：硬件钱包离线签名
2. **永不写在代码 / .env**：用 vault（HashiCorp Vault / AWS Secrets Manager）
3. **永不截图**：截图可能被云同步泄漏
4. **永不告诉任何人**：客服不会问
5. **多地备份**：3-2-1 规则（3 份副本、2 种介质、1 份异地）
6. **定期演练**：每季度演练恢复流程

### 7.4 .env + secrets 目录

```sh
# AGINT 工作流：私密走 ~/.dsh/secrets/
# 不要把私钥 / API key 写进 git 仓库
PRIVATE_KEY=0x...                # ❌ 千万不要写在 .env 然后 commit
ALCHEMY_API_KEY=...              # ✅ .env 加入 .gitignore
SAFE_OWNER_KEY=...               # ❌ 永远不要
```

> AGINT 守则：**secrets 走 `$DSH_HOME/secrets/`**，永远不要写进任何代码 / wiki / memory。

## 八、签名相关高级模式

### 8.1 EIP-1271（合约钱包签名验证）

```solidity
interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4 magicValue);
}

// 链上验证合约钱包签名
function recoverSigner(bytes32 hash, bytes memory sig) internal view returns (address) {
    if (sig.length >= 65) {
        // EOA
        address signer = ECDSA.recover(hash, sig);
        if (signer != address(0)) return signer;
    }
    // 合约钱包 EIP-1271
    return ECDSA.recover(hash, sig);  // 返回地址，isContract(addr) 时调 isValidSignature
}
```

### 8.2 EIP-6492（链下签名 + 预部署合约钱包）

- 链下签名时合约钱包未部署
- 把 deploy bytecode + signature 一起传，部署后验证

### 8.3 ERC-721 / ERC-1155 签名铸造（Lazy Mint）

- 项目方链下签名 NFT 元数据 + 接收地址
- 用户在 marketplace 提交签名
- marketplace 调用 mint(to, tokenId, uri, sig)
- 合约验证签名是否由项目方签发

---

## 关联阅读

- [[web3-debug]] — 签名相关漏洞
- [[evm-patterns]] — Permit / Multicall 实现
- [[chain-rpc-toolkit]] — wallet / signer 用法
- [[defi-mechanics]] — DeFi 协议中的钱包集成
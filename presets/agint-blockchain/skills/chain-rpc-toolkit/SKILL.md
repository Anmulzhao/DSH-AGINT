---
name: chain-rpc-toolkit
description: 区块链 RPC 客户端与 SDK 用法模式库：ethers.js v6 / viem（以太坊与 EVM 链）、@solana/web3.js（Solana）、@cosmjs/stargate（Cosmos）、near-api-js（Near）、starknet.js / starknet-react（StarkNet）、@polkadot/api（Polkadot）。Chain ID 与 RPC 端点速查、provider / signer / wallet 模式、事件订阅、合约读写、交易签名与发送、Multicall / Batch、indexer（The Graph / Covalent / Alchemy / Moralis）。任务涉及链交互代码、dApp 前端集成、链下数据查询、合约读写时自动加载。
---

# Chain RPC Toolkit — 链交互工具速查

> 智进·区块链 专属 skill。任务涉及 ethers.js / viem / @solana/web3.js 等链客户端、dApp 前端、链下数据查询、合约读写时自动加载。

## 边界

- **适用**：选型 RPC 客户端、写链交互代码、查 chain ID/RPC 端点、Multicall、indexer 集成。
- **不适用**：合约漏洞（→ web3-debug）、协议机制（→ defi-mechanics）、钱包/签名流程（→ wallet-security）、ERC 标准（→ evm-patterns）。

## 一、Chain ID 与 RPC 端点速查

### 1.1 主流 EVM 链

| Chain | Chain ID | 主网 RPC | 测试网 | 测试网 Chain ID | 浏览器 |
|---|---|---|---|---|---|
| Ethereum | 1 | https://eth.llamarpc.com | Sepolia | 11155111 | etherscan.io |
|  |  | https://rpc.ankr.com/eth | Holesky | 17000 |  |
| BSC | 56 | https://bsc-dataseed.binance.org | BSC Testnet | 97 | bscscan.com |
| Polygon PoS | 137 | https://polygon-rpc.com | Mumbai | 80001 | polygonscan.com |
| Arbitrum One | 42161 | https://arb1.arbitrum.io/rpc | Sepolia | 421614 | arbiscan.io |
| Optimism | 10 | https://mainnet.optimism.io | Sepolia | 11155420 | optimism.io |
| Base | 8453 | https://mainnet.base.org | Sepolia | 84532 | basescan.org |
| Avalanche C-Chain | 43114 | https://api.avax.network/ext/bc/C/rpc | Fuji | 43113 | snowtrace.io |
| zkSync Era | 324 | https://mainnet.era.zksync.io | Sepolia | 300 | explorer.zksync.io |
| Linea | 59144 | https://rpc.linea.build | Sepolia | 59141 | lineascan.build |

### 1.2 公共 RPC（推荐列表）

- **Alchemy** / **Infura** / **QuickNode** / **Ankr**：商业节点（rate limit + archive 支持）
- **LlamaNodes** / **PublicNode**：免费公共 RPC
- **Cloudflare**：`https://cloudflare-eth.com`
- 本地开发：**Anvil**（Foundry, `127.0.0.1:8545`）、**Hardhat Node**、**Ganache**

### 1.3 Solana / Cosmos / 非 EVM

| Chain | Cluster / 网络 | RPC 端口 | 浏览器 |
|---|---|---|---|
| Solana | Mainnet Beta | https://api.mainnet-beta.solana.com | explorer.solana.com |
| Solana | Devnet / Testnet | https://api.devnet.solana.com | explorer.solana.com |
| Cosmos Hub | cosmoshub-4 | https://cosmoshub-rpc.publicnode.com | mintscan.io |
| Osmosis | osmosis-1 | https://osmosis-rpc.publicnode.com | mintscan.io |
| Near | mainnet | https://rpc.mainnet.near.org | explorer.near.org |
| StarkNet | mainnet | https://starknet-mainnet.public.blastapi.io | starknet.io |

## 二、ethers.js v6 用法模式

### 2.1 Provider / Signer / Wallet

```js
import { ethers } from 'ethers';

// 只读 provider
const provider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');

// 带私钥的 signer
const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// 浏览器钱包（MetaMask）
const browserProvider = new ethers.BrowserProvider(window.ethereum);
const signer = await browserProvider.getSigner();

// 读 chainId / network
const network = await provider.getNetwork();
console.log(network.chainId, network.name);

// 读 block
const block = await provider.getBlock('latest');
console.log(block.number, block.timestamp, block.baseFeePerGas);
```

### 2.2 合约读

```js
// ABI（人类可读）
const abi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];

// 实例化
const usdc = new ethers.Contract('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', abi, provider);

// 读
const bal = await usdc.balanceOf('0xYourAddress');
const dec = await usdc.decimals();
console.log('USDC balance:', ethers.formatUnits(bal, dec));

// 多读（Multicall）
const multicallAddr = '0xcA11bde05977b3631167028862bE2a173976CA11';  // Multicall3
const multicall = new ethers.Contract(multicallAddr, multicall3Abi, provider);

const calls = [
  { target: usdcAddr, allowFailure: false, callData: usdc.interface.encodeFunctionData('balanceOf', [addr]) },
  { target: daiAddr,  allowFailure: false, callData: dai.interface.encodeFunctionData('balanceOf', [addr]) },
];
const results = await multicall.aggregate3(calls);
```

### 2.3 合约写（交易）

```js
const usdcWithSigner = usdc.connect(signer);

// 估算 gas
const gasEst = await usdcWithSigner.transfer.estimateGas(to, amount);

// 发送交易
const tx = await usdcWithSigner.transfer(to, amount, {
  gasLimit: gasEst * 12n / 10n,  // +20% buffer
  maxFeePerGas: feeData.maxFeePerGas * 13n / 10n,
  maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
});
console.log('txHash:', tx.hash);

// 等确认
const receipt = await tx.wait();
console.log('block:', receipt.blockNumber, 'gasUsed:', receipt.gasUsed, 'status:', receipt.status);
```

### 2.4 事件监听

```js
// 监听 Transfer 事件
const filter = usdc.filters.Transfer(fromBlock = 'latest', toBlock = 'latest');
usdc.on(filter, (from, to, amount, event) => {
  console.log('Transfer', from, to, ethers.formatUnits(amount, 6), event.log.transactionHash);
});

// 历史查询
const events = await usdc.queryFilter(filter, fromBlock, toBlock);

// WebSocket 订阅新块
const wsProvider = new ethers.WebSocketProvider('wss://...');
wsProvider.on('block', (blockNum) => { /* ... */ });
```

### 2.5 错误处理

```js
try {
  const tx = await usdc.transfer(to, amount);
  await tx.wait();
} catch (e) {
  if (e.code === 'ACTION_REJECTED') console.log('用户拒绝');
  if (e.code === 'INSUFFICIENT_FUNDS') console.log('余额不足');
  if (e.code === 'CALL_EXCEPTION') {
    // 合约 revert — 解码自定义错误
    if (e.data) {
      const decoded = usdc.interface.parseError(e.data);
      console.log('revert:', decoded);
    }
  }
}
```

## 三、viem（现代化、TypeScript 优先）

### 3.1 基础

```ts
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http('https://eth.llamarpc.com'),
});

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({
  chain: mainnet,
  transport: http('https://eth.llamarpc.com'),
  account,
});
```

### 3.2 读

```ts
const block = await publicClient.getBlockNumber();
const balance = await publicClient.getBalance({ address: '0x...' });
console.log('ETH:', formatEther(balance));

// 合约读
const data = await publicClient.readContract({
  address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: ['0x...'],
});
```

### 3.3 写

```ts
const hash = await walletClient.writeContract({
  address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  abi: erc20Abi,
  functionName: 'transfer',
  args: ['0x...', 1000000n],  // 注意 BigInt
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
```

### 3.4 viem 优势

- 类型安全（TypeScript 原生支持）
- 更小的 bundle（tree-shakable）
- 现代化 API（基于 spec 风格）
- wagmi（React 集成）建立在 viem 之上

## 四、wagmi + RainbowKit（React dApp 前端）

### 4.1 安装

```bash
npm install wagmi viem @tanstack/react-query @rainbow-me/rainbowkit
```

### 4.2 配置

```tsx
import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { mainnet, sepolia } from 'wagmi/chains';
import { injected, walletConnect } from 'wagmi/connectors';

const config = getDefaultConfig({
  appName: 'My dApp',
  projectId: 'YOUR_WALLETCONNECT_PROJECT_ID',
  chains: [mainnet, sepolia],
  connectors: [injected(), walletConnect({ projectId: '...' })],
  ssr: false,
});
```

### 4.3 使用

```tsx
import { useAccount, useConnect, useDisconnect, useReadContract, useWriteContract } from 'wagmi';

function WalletStatus() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected) return <button onClick={() => disconnect()}>Disconnect {address}</button>;
  return connectors.map(c => <button key={c.id} onClick={() => connect({ connector: c })}>{c.name}</button>);
}

function Balance({ token, account }) {
  const { data: balance } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account],
  });
  return <div>{balance ? formatUnits(balance, 6) : '0'}</div>;
}
```

## 五、Solana：@solana/web3.js

### 5.1 Connection / Keypair

```js
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const keypair = Keypair.fromSecretKey(secretKey);  // Uint8Array

const balance = await connection.getBalance(keypair.publicKey);
console.log('SOL:', balance / LAMPORTS_PER_SOL);
```

### 5.2 交易

```js
import { Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';

const tx = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey: new PublicKey('...'),
    lamports: LAMPORTS_PER_SOL,
  })
);

const sig = await sendAndConfirmTransaction(connection, tx, [keypair]);
console.log('sig:', sig);
```

### 5.3 SPL Token

```js
import { getOrCreateAssociatedTokenAccount, createTransferInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const fromTokenAccount = await getOrCreateAssociatedTokenAccount(connection, keypair, mint, keypair.publicKey);
const toTokenAccount   = await getOrCreateAssociatedTokenAccount(connection, keypair, mint, toPublicKey);

const tx = new Transaction().add(
  createTransferInstruction(fromTokenAccount.address, toTokenAccount.address, keypair.publicKey, amount)
);
const sig = await sendAndConfirmTransaction(connection, tx, [keypair]);
```

### 5.4 Anchor（Solana 合约开发）

```bash
anchor init myproject
anchor build
anchor test
anchor deploy --provider.cluster devnet
```

## 六、The Graph（subgraph indexer）

### 6.1 适用

- 大规模事件查询（链上 query 慢）
- 子图定义在 GraphQL schema（按 protocol 自定义）

### 6.2 步骤

1. subgraph init（克隆模板）
2. 定义 schema.graphql
3. 写 mapping.ts（事件 handler）
4. 本地 node 测试
5. 部署到 The Graph hosted service / decentralized network

### 6.3 替代 indexer

| 服务 | 特点 |
|---|---|
| The Graph | 自定义 subgraph，最灵活 |
| Covalent | 单一 API 跨 100+ 链 |
| Alchemy | 全 API + enhanced webhooks |
| Moralis | 全 API + 实时推送 |
| Bitquery | 链上复杂查询 |

## 七、Webhook / 实时通知

- **Alchemy Notify**：URL push（交易确认 / 链事件）
- **Moralis Streams**：实时 webhook
- **Tenderly Web3 Actions**：合约事件触发 webhook
- **环境搭建**：ngrok / Cloudflare Tunnel 暴露本地 webhook

```js
// 接收 webhook（Express.js）
app.post('/webhook/alchemy', (req, res) => {
  const event = req.body.event;  // { network, activity: [{hash, fromAddress, ...}] }
  console.log('Transfer detected:', event.activity[0]);
  res.status(200).send('OK');
});
```

---

## 关联阅读

- [[web3-debug]] — 链上异常排查
- [[evm-patterns]] — 合约 ABI 模式
- [[wallet-security]] — wallet / signer 模式
- [[defi-mechanics]] — DeFi 协议查询场景
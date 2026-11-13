import type { Metadata } from 'next';
import Link from 'next/link';
import { DEPLOYMENTS } from '../../../../shared/deployments';

export const metadata: Metadata = { title: 'Guardian and MOVE' };

const CHAINS = [
  { chain: 'base', label: 'Base', id: 8453 },
  { chain: 'monad', label: 'Monad', id: 143 },
] as const;

const SNIPPET = `import { createWalletClient, custom, parseAbi, parseUnits } from 'viem';
import { monad } from 'viem/chains';

const erc20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const vaultAbi = parseAbi([
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);
const guardianAbi = parseAbi(['function enable(address vault, uint16 minConfidenceBps, uint32 maxAge)']);

// USDC, VAULT and GUARDIAN come from the table above and the menu; publicClient reads the same chain.
// Wait for each transaction's receipt before sending the next.
const wallet = createWalletClient({ chain: monad, transport: custom(window.ethereum) });
const [owner] = await wallet.requestAddresses();
const amount = parseUnits('0.25', 6);

await wallet.writeContract({ account: owner, address: USDC, abi: erc20, functionName: 'approve', args: [VAULT, amount] });
await wallet.writeContract({ account: owner, address: VAULT, abi: vaultAbi, functionName: 'deposit', args: [amount, owner] });
// After the deposit mines, read the shares you now hold.
const shares = await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: 'balanceOf', args: [owner] });
await wallet.writeContract({ account: owner, address: VAULT, abi: erc20, functionName: 'approve', args: [GUARDIAN, shares] });
await wallet.writeContract({ account: owner, address: GUARDIAN, abi: guardianAbi, functionName: 'enable', args: [VAULT, 8000, 600] });`;

export default function GuardianDocs() {
  return (
    <>
      <h1>Guardian and MOVE</h1>
      <p>
        Guardian is a separate, opt-in exit rule for an ERC-4626 position. Buying a judgement does not arm it. Rein
        never holds your vault shares or exit proceeds: Guardian redeems from the owner and pays the underlying assets
        directly to that same owner.
      </p>
      <h2>Opt in deliberately</h2>
      <p>
        GuardianV2 is deployed on Base and Monad mainnet, one contract per chain, and every vault on that chain’s menu
        is approved on it. The website’s <Link href="/guardian">Guardian page</Link> switches between the two. From it
        you can deposit USDC into a menu vault and arm Guardian with your own EVM wallet; each step is a transaction
        your wallet signs. A visible rule or component is not proof that an exit will happen. Arming requires an
        approved vault, share approval and an enabled onchain rule. You choose the minimum confidence and maximum
        verdict age within the contract’s accepted range.
      </p>
      <p>
        Share approval authorizes redemption up to your allowance; it does not transfer custody to Rein. Disable the
        rule to stop future authorized exits, and review or revoke the share allowance independently if you no longer
        want it.
      </p>
      <h2>What authorizes an exit</h2>
      <ul>
        <li>The vault must remain approved and the owner’s rule enabled.</li>
        <li>
          The oracle’s <em>latest</em> verdict must be EXIT and meet the owner’s minimum confidence.
        </li>
        <li>The verdict must be no older than the owner’s maximum age and must not predate enabling the rule.</li>
        <li>
          Its ID must exceed the verdict floor captured at enable time, excluding an older verdict even if it was posted
          in the same second.
        </li>
        <li>
          The owner must have shares and sufficient Guardian allowance. A completed exit advances the floor so the same
          verdict cannot exit a later re-deposit.
        </li>
      </ul>
      <p>
        Anyone can call an authorized exit. The configured Worker indexes opted-in owners and attempts exits after its
        grading/order work; it is not required by the contract. Automatic execution also needs live indexing, RPC access
        and a funded executor. A newer verdict before mining can change what authorizes the transaction.
      </p>
      <h2>Use Guardian from code</h2>
      <table>
        <thead>
          <tr>
            <th>Chain</th>
            <th>Guardian</th>
            <th>USDC</th>
            <th>Chain id</th>
          </tr>
        </thead>
        <tbody>
          {CHAINS.map((c) => (
            <tr key={c.chain}>
              <td>{c.label}</td>
              <td>
                <code>{DEPLOYMENTS.mainnet.guardians[c.chain]}</code>
              </td>
              <td>
                <code>{DEPLOYMENTS.mainnet.usdc[c.chain]}</code>
              </td>
              <td>{c.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        The vault must be on that chain’s menu (see <code>list_vaults</code>). Send four calls in order from the owner’s
        wallet, waiting for each to mine:
      </p>
      <ol>
        <li>
          <code>USDC.approve(vault, amount)</code>: exactly the deposit amount, in USDC base units (6 decimals).
        </li>
        <li>
          <code>vault.deposit(amount, owner)</code>: the ERC-4626 deposit; shares go to the owner.
        </li>
        <li>
          <code>vault.approve(guardian, shares)</code>: exactly the shares the owner holds after the deposit mined.
        </li>
        <li>
          <code>guardian.enable(vault, minConfidenceBps, maxAgeS)</code>: <code>minConfidenceBps</code> from 8000 to
          9900, <code>maxAgeS</code> from 60 to 3600 seconds. <code>guardian.disable(vault)</code> turns it off.
        </li>
      </ol>
      <p>A sketch with viem, on Monad:</p>
      <pre>{SNIPPET}</pre>
      <p>
        The MCP tool <code>guardian_transactions</code> returns the same steps unsigned, as{' '}
        <code>{'{chainId, to, data, value}'}</code> in order, for <code>action</code> <code>deposit</code>,{' '}
        <code>arm</code> or <code>disarm</code> on <code>base</code> or <code>monad</code>. Your agent’s wallet signs
        and sends them; Rein never signs, holds funds or holds keys. For <code>arm</code>, pass the shares you hold
        after the deposit mines. See <Link href="/docs/mcp">MCP server</Link>.
      </p>
      <p>
        Rein’s Worker discovers owners from Guardian’s <code>Enabled</code> event. Anyone may call{' '}
        <code>exit(vault, owner)</code> once the rule matches, and the funds always go to the owner.
      </p>
      <h2>Partial exits and alerts</h2>
      <p>
        Guardian tries the approved position first. If the vault cannot redeem it all, it can fall back to a smaller
        currently liquid amount. Remaining shares can stay locked. Follow-up attempts recheck the same authorization and
        stop if the verdict is stale or superseded; no mechanism guarantees liquidity or timely inclusion.
      </p>
      <p>
        Browser EXIT alerts are notifications about a signal, not confirmations that Guardian exited your position.
        Check the exit transaction and remaining shares.
      </p>
      <h2>MOVE after an exit</h2>
      <p>
        MOVE in the Guardian interface is a user-requested cross-chain quote, not an automatic reinvestment or a custody
        account. It becomes available when the connected owner’s rule is still enabled and the vault share balance is
        zero, including after reconnecting. A partial exit with remaining shares does not qualify.
      </p>
      <p>
        The amount shown is the owner’s current USDC balance on the vault’s chain, which can include money unrelated to
        the exit. Choose Base or Monad as the destination, check the recipient and refund address, then request a
        deposit address. Rein does not sign, approve or send those funds. Send the quoted amount yourself before expiry;
        changing the inputs discards the quote.
      </p>
      <p>
        The model’s MOVE verdict is also a public judgement label. It does not itself execute a swap, select a
        guaranteed safe destination or give Guardian permission to exit; Guardian acts only on EXIT.
      </p>
      <p>
        See <Link href="/docs/api">HTTP quote routes</Link> for the wire contract and{' '}
        <Link href="/docs/trust">Trust and limits</Link> for execution risks.
      </p>
    </>
  );
}

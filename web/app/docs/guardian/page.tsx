import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Guardian and MOVE' };

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
        The website’s <Link href="/guardian">Guardian page</Link> targets Base mainnet. Mainnet is not deployed yet; a
        visible rule or component is not proof of live automatic protection. Arming requires a configured Guardian
        contract, an approved vault, your EVM wallet, share approval and an enabled onchain rule. You choose the minimum
        confidence and maximum verdict age within the contract’s accepted range.
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
        The amount shown is the owner’s current Base USDC balance, which can include money unrelated to the exit. Choose
        Base or Monad as the destination, check the recipient and refund address, then request a deposit address. Rein
        does not sign, approve or send those funds. Send the quoted amount yourself before expiry; changing the inputs
        discards the quote.
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

import { keccak256, parseTransaction, type Hex } from 'viem';
import type { DeskChain } from '../../shared/desk';
import type { DeskClient, DeskOrder } from './deskTypes';
import type { NearNetwork } from './env';

const FINAL: Record<string, true> = { delivered: true, rejected: true, refunded: true, post_failed: true };

export interface BroadcastAttempt {
  hash: Hex;
  raw_tx: Hex;
  nonce: number;
  posted: number;
}

/** Broadcast intent survives a crash between sending a transaction and receiving its response. */
export class BroadcastJournal {
  constructor(private readonly db: D1Database, private readonly network: NearNetwork) {}

  async record(order: DeskOrder, raw: Hex, now: number, desk: Pick<DeskClient, 'get_order'>): Promise<boolean> {
    const nonce = parseTransaction(raw).nonce ?? 0;
    await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO broadcast_attempts
        (network, chain, order_id, nonce, hash, raw_tx, attempted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(this.network, order.chain, order.id, nonce, keccak256(raw), raw, now),
      this.db.prepare('INSERT OR IGNORE INTO pending_nonces (network, chain, nonce, order_id) VALUES (?, ?, ?, ?)')
        .bind(this.network, order.chain, nonce, order.id),
    ]);
    const owner = await this.db.prepare('SELECT order_id FROM pending_nonces WHERE network = ? AND chain = ? AND nonce = ?')
      .bind(this.network, order.chain, nonce).first<number>('order_id');
    if (owner !== null && owner !== order.id) {
      const current = await desk.get_order(owner);
      if (!current || FINAL[current.status]) {
        const claimed = await this.db.prepare(`UPDATE pending_nonces SET order_id = ?
          WHERE network = ? AND chain = ? AND nonce = ? AND order_id = ?`)
          .bind(order.id, this.network, order.chain, nonce, owner).run();
        return claimed.meta.changes === 1;
      }
    }
    return owner === order.id;
  }

  async attempts(order: DeskOrder): Promise<BroadcastAttempt[]> {
    const rows = await this.db.prepare(`SELECT hash, raw_tx, nonce, posted FROM broadcast_attempts
      WHERE network = ? AND chain = ? AND order_id = ? ORDER BY attempted_at, hash`)
      .bind(this.network, order.chain, order.id).all<BroadcastAttempt>();
    return rows.results;
  }

  async markPosted(order: DeskOrder): Promise<void> {
    await this.db.prepare('UPDATE broadcast_attempts SET posted = 1 WHERE network = ? AND chain = ? AND order_id = ?')
      .bind(this.network, order.chain, order.id).run();
  }

  async receipt(order: DeskOrder, hash: Hex, status: string, gas: bigint): Promise<void> {
    await this.db.prepare(`UPDATE broadcast_attempts SET receipt_status = ?, gas_wei = ?
      WHERE network = ? AND chain = ? AND order_id = ? AND hash = ?`)
      .bind(status, String(gas), this.network, order.chain, order.id, hash).run();
  }

  async gas(order: DeskOrder): Promise<bigint> {
    const { results } = await this.db.prepare(`SELECT gas_wei FROM broadcast_attempts
      WHERE network = ? AND chain = ? AND order_id = ? AND gas_wei IS NOT NULL`)
      .bind(this.network, order.chain, order.id).all<{ gas_wei: string }>();
    return results.reduce((sum, r) => sum + BigInt(r.gas_wei), 0n);
  }

  async nextNonce(chain: DeskChain, proposed: number, desk: Pick<DeskClient, 'get_order'>): Promise<number> {
    const held = await this.db.prepare(`SELECT nonce, order_id FROM pending_nonces
      WHERE network = ? AND chain = ? AND nonce >= ? ORDER BY nonce`)
      .bind(this.network, chain, proposed).all<{ nonce: number; order_id: number }>();
    let next = proposed;
    for (const row of held.results) {
      if (row.nonce > next) break;
      const order = await desk.get_order(row.order_id);
      if (!order || FINAL[order.status]) {
        // Settlement can land before its D1 cleanup. Only finished orders can be pruned from the desk.
        await this.db.prepare('DELETE FROM pending_nonces WHERE network = ? AND chain = ? AND order_id = ?')
          .bind(this.network, chain, row.order_id).run();
      } else {
        next = row.nonce + 1;
      }
    }
    return next;
  }

  async release(order: DeskOrder): Promise<void> {
    await this.db.prepare('DELETE FROM pending_nonces WHERE network = ? AND chain = ? AND order_id = ?')
      .bind(this.network, order.chain, order.id).run();
  }
}

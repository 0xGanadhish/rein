use near_sdk::json_types::U128;
use near_sdk::near;

use crate::types::{vault_hex, Chain, OrderView, Policy, Stats};
use crate::verify::{parse_signature, verify_reading, Prompt};
use crate::{now_s, Desk, DeskExt};

#[near]
impl Desk {
    pub fn get_order(&self, order_id: u64) -> Option<OrderView> {
        self.orders.get(&order_id).map(OrderView::from)
    }

    /// Orders with ids in `[from, from + limit)`; pruned ids are skipped.
    pub fn list_orders(&self, from: u64, limit: u32) -> Vec<OrderView> {
        let end = from.saturating_add(limit as u64).min(self.next_id);
        (from..end)
            .filter_map(|id| self.orders.get(&id).map(OrderView::from))
            .collect()
    }

    /// Unfinished orders, at most `limit`.
    pub fn open_orders(&self, limit: u32) -> Vec<OrderView> {
        self.active
            .values()
            .take(limit as usize)
            .filter_map(|id| self.orders.get(id).map(OrderView::from))
            .collect()
    }

    pub fn policy(&self) -> Policy {
        self.policy.clone()
    }

    /// Vaults on the menu for `chain`, as 0x-lowercase hex.
    pub fn menu(&self, chain: Chain) -> Vec<String> {
        self.menu
            .iter()
            .filter(|k| k.chain == chain)
            .map(|k| vault_hex(&k.vault))
            .collect()
    }

    pub fn stats(&self) -> Stats {
        let t = &self.totals;
        Stats {
            sales_near: U128(t.sales_near),
            sales_usdc: U128(t.sales_usdc),
            sales_x402_usdc: U128(t.sales_x402_usdc),
            refunds: t.refunds,
            open_paid: t.open_paid,
        }
    }

    pub fn prompt(&self) -> Prompt {
        self.prompt.clone()
    }

    /// Accepted model signing addresses, as 0x-lowercase hex.
    pub fn signers(&self) -> Vec<String> {
        self.signers.iter().map(vault_hex).collect()
    }

    /// Checks a reading for `order_id` as delivery would, now. Returns `ok` or the reason.
    /// `signature` is 65 bytes `r || s || v` in hex, 0x optional.
    pub fn check_reading(
        &self,
        order_id: u64,
        doc: String,
        response: String,
        signature: String,
    ) -> String {
        let Some(order) = self.orders.get(&order_id) else {
            return "no such order".into();
        };
        let Some(sig) = parse_signature(&signature) else {
            return "bad signature".into();
        };
        let r = verify_reading(
            &self.prompt,
            &self.signers,
            order,
            &doc,
            &response,
            &sig,
            now_s(),
            self.policy.doc_max_age_s,
        );
        match r {
            Ok(_) => "ok".into(),
            Err(e) => e.into(),
        }
    }
}

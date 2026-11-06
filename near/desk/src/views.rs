use near_sdk::json_types::U128;
use near_sdk::near;

use crate::types::{vault_hex, Amounts, Chain, Order, OrderView, PerChain, Policy, Stats};
use crate::verify::{hex, parse_signature, verify_reading, Prompt};
use crate::{now_s, Desk, DeskExt};

#[near]
impl Desk {
    pub fn get_order(&self, order_id: u64) -> Option<OrderView> {
        self.orders.get(&order_id).map(|o| self.view(o))
    }

    /// Orders with ids in `[from, from + limit)`; pruned ids are skipped.
    pub fn list_orders(&self, from: u64, limit: u32) -> Vec<OrderView> {
        let end = from.saturating_add(limit as u64).min(self.next_id);
        (from..end)
            .filter_map(|id| self.orders.get(&id).map(|o| self.view(o)))
            .collect()
    }

    /// Unfinished orders, at most `limit`.
    pub fn open_orders(&self, limit: u32) -> Vec<OrderView> {
        self.active
            .values()
            .take(limit as usize)
            .filter_map(|id| self.orders.get(id).map(|o| self.view(o)))
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
            inference_tokens_in: t.tokens_in,
            inference_tokens_out: t.tokens_out,
            gas_wei: PerChain {
                monad_testnet: U128(t.gas_wei.monad_testnet),
                monad: U128(t.gas_wei.monad),
                base: U128(t.gas_wei.base),
                base_sepolia: U128(t.gas_wei.base_sepolia),
            },
            paid_treasury: Amounts {
                near: U128(t.treasury_near),
                usdc: U128(t.treasury_usdc),
            },
            paid_agent: Amounts {
                near: U128(t.agent_near),
                usdc: U128(t.agent_usdc),
            },
            owed: U128(t.owed),
            owed_near: U128(t.owed_near),
            watch_orders: t.watch_orders,
        }
    }

    /// The signed post of a `signed` order, 0x hex, until delivery.
    pub fn get_signed_tx(&self, order_id: u64) -> Option<String> {
        let tx = self
            .orders
            .get(&order_id)?
            .reading
            .as_ref()?
            .signed_tx
            .as_ref()?;
        Some(format!("0x{}", hex(tx)))
    }

    /// The desk's EVM attester address, 0x-lowercase hex.
    pub fn derived_address(&self) -> String {
        vault_hex(&self.derived_address)
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

impl Desk {
    fn view(&self, o: &Order) -> OrderView {
        let mut o = o.clone();
        self.lapse(&mut o, now_s());
        OrderView::from(&o)
    }
}

use near_sdk::json_types::U128;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, Promise, PromiseOrValue,
};

use crate::policy::check_post;
use crate::types::{parse_vault, Chain, Order, OrderStatus, Source, VaultKey};
use crate::{now_s, Desk, DeskExt};

/// Finished orders become prunable this long after creation.
pub const PRUNE_AFTER_S: u32 = 7 * 86_400;
pub(crate) const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(10);

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

/// `msg` of an `ft_transfer_call` that pays for an order.
#[near(serializers = [json])]
struct FtOrderMsg {
    chain: Chain,
    vault: String,
}

#[near]
impl Desk {
    /// Opens an order paid in NEAR. Attach at least `price_near`; any excess is sent back.
    #[payable]
    pub fn request_judgement(&mut self, chain: Chain, vault: String) -> u64 {
        let payer = env::predecessor_account_id();
        let price = self.policy.price_near.0;
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= price, "deposit below price_near");
        let id = self
            .open_order(Source::Near, Some(payer.clone()), chain, &vault, price)
            .unwrap_or_else(|e| env::panic_str(e));
        if deposit > price {
            Promise::new(payer)
                .transfer(NearToken::from_yoctonear(deposit - price))
                .detach();
        }
        id
    }

    /// NEP-141 receiver for USDC orders. `msg` is `{"chain","vault"}`; `amount` must equal
    /// `price_usdc`. A refused order returns the whole amount as unused.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        match self.usdc_order(sender_id, amount.0, &msg) {
            Ok(id) => {
                env::log_str(&format!("order {id} opened"));
                PromiseOrValue::Value(U128(0))
            }
            Err(e) => {
                env::log_str(&format!("refused: {e}"));
                PromiseOrValue::Value(amount)
            }
        }
    }

    /// Opens an unpaid order for the desk's own watch list. Agent only.
    pub fn submit_watch_request(&mut self, chain: Chain, vault: String) -> u64 {
        self.assert_agent();
        self.open_order(Source::Watch, None, chain, &vault, 0)
            .unwrap_or_else(|e| env::panic_str(e))
    }

    /// Records an order the agent was paid for offchain over x402. Agent only.
    pub fn submit_x402_request(
        &mut self,
        chain: Chain,
        vault: String,
        payment_ref: String,
        amount: U128,
    ) -> u64 {
        self.assert_agent();
        require!(
            amount.0 >= self.policy.price_usdc.0,
            "amount below price_usdc"
        );
        let id = self
            .open_order(Source::X402, None, chain, &vault, amount.0)
            .unwrap_or_else(|e| env::panic_str(e));
        env::log_str(&format!("order {id} x402 {payment_ref}"));
        id
    }

    /// Agent only: closes an unfinished order and refunds it in full.
    pub fn reject(&mut self, order_id: u64, reason: String) {
        self.assert_agent();
        let order = self.close(order_id, OrderStatus::Rejected);
        env::log_str(&format!("order {order_id} rejected: {reason}"));
        self.pay_back(&order);
    }

    /// Anyone: refunds open orders after the deadline (or under kill), signed orders only past expiry and grace.
    pub fn refund(&mut self, order_id: u64) {
        let order = self
            .orders
            .get(&order_id)
            .unwrap_or_else(|| env::panic_str("no such order"));
        if order.status == OrderStatus::Signed {
            let valid_until = order
                .reading
                .as_deref()
                .expect("signed has a reading")
                .valid_until;
            require!(
                now_s() > valid_until.saturating_add(self.policy.deadline_s),
                "refund before post expiry and grace"
            );
        } else {
            require!(order.status.is_refundable(), "order is not refundable");
            require!(
                self.policy.kill
                    || now_s() >= order.created_s.saturating_add(self.policy.deadline_s),
                "refund before deadline"
            );
        }
        let order = self.close(order_id, OrderStatus::Refunded);
        self.pay_back(&order);
    }

    /// Agent only: a signed post reverted or expired. Counts its fee once and refunds all escrow.
    pub fn fail_post(
        &mut self,
        order_id: u64,
        tx_hash: Option<String>,
        gas_wei: U128,
        reason: String,
    ) {
        self.assert_agent();
        let order = self.order(order_id);
        require!(order.status == OrderStatus::Signed, "order is not signed");
        *self.totals.gas_wei.get_mut(order.chain) += gas_wei.0;
        let order = self.close(order_id, OrderStatus::PostFailed);
        env::log_str(&format!(
            "order {order_id} post failed: {tx_hash:?}: {reason}"
        ));
        self.pay_back(&order);
    }

    /// Anyone: deletes finished orders older than 7 days. Other ids are skipped.
    /// Returns how many were deleted.
    pub fn prune(&mut self, order_ids: Vec<u64>) -> u32 {
        let now = now_s();
        let mut n = 0;
        for id in order_ids {
            let due = self.orders.get(&id).is_some_and(|o| {
                o.status.is_finished() && now >= o.created_s.saturating_add(PRUNE_AFTER_S)
            });
            if due {
                self.orders.remove(&id);
                n += 1;
            }
        }
        n
    }
}

impl Desk {
    fn usdc_order(
        &mut self,
        sender_id: AccountId,
        amount: u128,
        msg: &str,
    ) -> Result<u64, &'static str> {
        if self.policy.usdc_token.as_ref() != Some(&env::predecessor_account_id()) {
            return Err("not the usdc token");
        }
        let m: FtOrderMsg =
            near_sdk::serde_json::from_slice(msg.as_bytes()).map_err(|_| "bad msg")?;
        if amount != self.policy.price_usdc.0 {
            return Err("amount is not price_usdc");
        }
        self.open_order(Source::Usdc, Some(sender_id), m.chain, &m.vault, amount)
    }

    /// Checks every rule, then stores the order. Nothing changes on `Err`.
    fn open_order(
        &mut self,
        source: Source,
        payer: Option<AccountId>,
        chain: Chain,
        vault: &str,
        amount: u128,
    ) -> Result<u64, &'static str> {
        let p = &self.policy;
        if p.kill {
            return Err("kill switch on");
        }
        let key = VaultKey {
            chain,
            vault: parse_vault(vault)?,
        };
        if !self.menu.contains(&key) {
            return Err("vault not on menu");
        }
        if self.active.contains_key(&key) {
            return Err("vault has an open order");
        }
        if source.is_paid() && self.totals.open_paid >= p.max_open_paid {
            return Err("too many open orders");
        }
        let now = now_s();
        let history = self.posts.get(&key).map(Vec::as_slice).unwrap_or(&[]);
        check_post(history, &self.global_posts, now, p)?;
        let mut watch = self.watch;
        if source == Source::Watch {
            watch.bump(now, p)?;
        }

        let id = self.next_id;
        self.next_id += 1;
        self.watch = watch;
        self.active.insert(key, id);
        let t = &mut self.totals;
        match source {
            Source::Near => t.sales_near += amount,
            Source::Usdc => t.sales_usdc += amount,
            Source::X402 => t.sales_x402_usdc += amount,
            Source::Watch => t.watch_orders += 1,
        }
        if source.is_paid() {
            t.open_paid += 1;
        }
        let order = Order {
            id,
            source,
            payer,
            chain,
            vault: key.vault,
            amount,
            created_s: now,
            status: OrderStatus::Open,
            reading: None,
        };
        self.orders.insert(id, order);
        Ok(id)
    }

    /// Moves an unfinished order to `status` and frees its vault.
    fn close(&mut self, order_id: u64, status: OrderStatus) -> Order {
        let order = self
            .orders
            .get_mut(&order_id)
            .unwrap_or_else(|| env::panic_str("no such order"));
        require!(
            order.status.is_refundable()
                || (order.status == OrderStatus::Signed
                    && matches!(status, OrderStatus::Refunded | OrderStatus::PostFailed)),
            "order is not refundable"
        );
        order.status = status;
        if let Some(reading) = order.reading.as_deref_mut() {
            reading.signed_tx = None;
        }
        let order = order.clone();
        self.active.remove(&VaultKey {
            chain: order.chain,
            vault: order.vault,
        });
        if order.source.is_paid() {
            self.totals.open_paid -= 1;
        }
        self.totals.refunds += 1;
        order
    }

    /// Returns escrow to the payer. Watch and x402 orders hold none onchain.
    fn pay_back(&mut self, order: &Order) {
        let Some(payer) = order.payer.clone() else {
            return;
        };
        match order.source {
            Source::Near => self.pay_near(payer, order.amount).detach(),
            Source::Usdc => self.pay_usdc(payer, order.amount).detach(),
            Source::X402 | Source::Watch => {}
        }
    }
}

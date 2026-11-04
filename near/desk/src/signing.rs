//! Turns verified readings into signed oracle posts through Chain Signatures, and pays the split.

use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, Gas, GasWeight, NearToken, Promise, PromiseOrValue};

use crate::orders::{ext_ft, GAS_FOR_FT_TRANSFER};
use crate::policy::{check_post, prune_history};
use crate::types::{parse_vault, Order, OrderStatus, Reading, Source, TxParams, VaultKey, Verdict};
use crate::verify::{hex, parse_signature, verify_reading, Answer};
use crate::{evm, now_s, Desk, DeskExt};

/// Key derivation path of the attester key.
pub const PATH: &str = "rein-attester-v1";
/// The signer's config asks for at least 15 Tgas; the rest of the call's gas is shared out too.
const GAS_FOR_SIGN: Gas = Gas::from_tgas(50);
const GAS_FOR_ON_SIGNED: Gas = Gas::from_tgas(60);
const GAS_FOR_ON_USDC_PAID: Gas = Gas::from_tgas(5);

#[near]
impl Desk {
    /// Agent only. Verifies a reading for an open order. HOLD and MOVE are signed at once;
    /// EXIT is stored and waits for `confirm_exit`.
    pub fn fulfil(
        &mut self,
        order_id: u64,
        doc: String,
        response: String,
        signature: String,
        tx: TxParams,
    ) -> PromiseOrValue<()> {
        self.assert_agent();
        require!(!self.policy.kill, "kill switch on");
        let now = now_s();
        let mut order = self.order_now(order_id, now);
        require!(order.status == OrderStatus::Open, "order is not open");
        let (answer, state_hash) = self.accept(&order, &doc, &response, &signature, now);
        let reading = Reading {
            verdict: answer.verdict,
            confidence_bps: answer.confidence_bps,
            risk_bps: answer.risk_bps,
            state_hash,
            first_at: now,
            payload_hash: [0; 32],
            signed_tx: None,
            delivered_tx: None,
        };
        let prev = order.clone();
        order.reading = Some(Box::new(reading));
        if answer.verdict == Verdict::Exit {
            order.status = OrderStatus::ExitPending;
            self.orders.insert(order_id, order);
            return PromiseOrValue::Value(());
        }
        PromiseOrValue::Promise(self.sign_post(prev, order, tx, true))
    }

    /// Agent only. A second reading for an `exit_pending` order, 30 s to 5 min after the first,
    /// on a different state. The post carries this reading's verdict, whatever it is.
    pub fn confirm_exit(
        &mut self,
        order_id: u64,
        doc: String,
        response: String,
        signature: String,
        tx: TxParams,
    ) -> Promise {
        self.assert_agent();
        require!(!self.policy.kill, "kill switch on");
        let now = now_s();
        let mut order = self.order_now(order_id, now);
        require!(
            order.status == OrderStatus::ExitPending,
            "order is not exit_pending"
        );
        let first = order
            .reading
            .as_deref()
            .expect("exit_pending has a reading");
        require!(
            now >= first
                .first_at
                .saturating_add(self.policy.exit_confirm_min_s),
            "exit confirmed too early"
        );
        let first_hash = first.state_hash;
        let (answer, state_hash) = self.accept(&order, &doc, &response, &signature, now);
        require!(state_hash != first_hash, "same state_hash");
        let prev = order.clone();
        let r = order
            .reading
            .as_deref_mut()
            .expect("exit_pending has a reading");
        r.verdict = answer.verdict;
        r.confidence_bps = answer.confidence_bps;
        r.risk_bps = answer.risk_bps;
        r.state_hash = state_hash;
        self.sign_post(prev, order, tx, true)
    }

    /// Agent only. Signs a signed order's post again with a new nonce or fees.
    /// The verdict stays; the post is not counted again.
    pub fn resign(&mut self, order_id: u64, tx: TxParams) -> Promise {
        self.assert_agent();
        let order = self.order(order_id);
        require!(order.status == OrderStatus::Signed, "order is not signed");
        self.sign_post(order.clone(), order, tx, false)
    }

    /// Agent only. The post landed in EVM transaction `tx_hash` (0x, 32 bytes).
    pub fn report_delivery(&mut self, order_id: u64, tx_hash: String) {
        self.assert_agent();
        require!(
            tx_hash.len() == 66 && tx_hash.starts_with("0x"),
            "bad tx_hash"
        );
        let mut order = self.order(order_id);
        require!(order.status == OrderStatus::Signed, "order is not signed");
        order.status = OrderStatus::Delivered;
        let r = order.reading.as_deref_mut().expect("signed has a reading");
        r.signed_tx = None;
        r.delivered_tx = Some(tx_hash);
        self.active.remove(&VaultKey {
            chain: order.chain,
            vault: order.vault,
        });
        if order.source.is_paid() {
            self.totals.open_paid -= 1;
        }
        self.orders.insert(order_id, order);
    }

    /// Agent only. Adds EVM gas spent on an order's post to the chain's total.
    pub fn record_gas(&mut self, order_id: u64, gas_wei: U128) {
        self.assert_agent();
        let order = self.order(order_id);
        require!(
            matches!(order.status, OrderStatus::Signed | OrderStatus::Delivered),
            "order is not signed"
        );
        *self.totals.gas_wei.get_mut(order.chain) += gas_wei.0;
    }

    /// Anyone: sends `account` the USDC it is owed from a failed split transfer.
    pub fn claim_owed(&mut self, account: AccountId) -> Promise {
        let amount = self.owed.remove(&account).unwrap_or(0);
        require!(amount > 0, "nothing owed");
        self.totals.owed -= amount;
        self.pay_usdc(account, amount)
    }

    #[private]
    pub fn on_signed(
        &mut self,
        #[serializer(borsh)] prev: Order,
        #[serializer(borsh)] tx: TxParams,
        #[serializer(borsh)] posted_at: Option<u32>,
    ) {
        let mut order = self.order(prev.id);
        let signed = env::promise_result_checked(0, 1024)
            .ok()
            .and_then(|body| parse_mpc_response(&body))
            .and_then(|sig| self.signed_post(&order, &tx, &sig));
        let Some(signed) = signed else {
            env::log_str(&format!("order {} signing failed", prev.id));
            if let Some(t) = posted_at {
                self.unrecord_post(&prev, t);
            }
            self.orders.insert(prev.id, prev);
            return;
        };
        let first = prev.status != OrderStatus::Signed;
        order.status = OrderStatus::Signed;
        order
            .reading
            .as_deref_mut()
            .expect("signing has a reading")
            .signed_tx = Some(signed);
        if first {
            self.pay_split(&order);
        }
        self.orders.insert(order.id, order);
    }

    /// A USDC transfer's outcome; a failed one stays owed to `account`.
    #[private]
    pub fn on_usdc_paid(&mut self, account: AccountId, amount: U128) {
        if env::promise_result_checked(0, 64).is_err() {
            let owed = self.owed.get(&account).copied().unwrap_or(0);
            self.owed.insert(account, owed + amount.0);
            self.totals.owed += amount.0;
        }
    }
}

impl Desk {
    pub(crate) fn order(&self, order_id: u64) -> Order {
        self.orders
            .get(&order_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no such order"))
    }

    /// The order as of `now`: an `exit_pending` order whose window passed is open again.
    pub(crate) fn order_now(&self, order_id: u64, now: u32) -> Order {
        let mut o = self.order(order_id);
        self.lapse(&mut o, now);
        o
    }

    pub(crate) fn lapse(&self, o: &mut Order, now: u32) {
        let lapsed = o.status == OrderStatus::ExitPending
            && o.reading
                .as_deref()
                .is_some_and(|r| now > r.first_at.saturating_add(self.policy.exit_confirm_max_s));
        if lapsed {
            o.status = OrderStatus::Open;
            o.reading = None;
        }
    }

    /// Verifies a reading or panics with the reason. Counts its tokens.
    fn accept(
        &mut self,
        order: &Order,
        doc: &str,
        response: &str,
        signature: &str,
        now: u32,
    ) -> (Answer, [u8; 32]) {
        let sig = parse_signature(signature).unwrap_or_else(|| env::panic_str("bad signature"));
        let r = verify_reading(
            &self.prompt,
            &self.signers,
            order,
            doc,
            response,
            &sig,
            now,
            self.policy.doc_max_age_s,
        )
        .unwrap_or_else(|e| env::panic_str(e));
        self.totals.tokens_in += r.0.prompt_tokens as u64;
        self.totals.tokens_out += r.0.completion_tokens as u64;
        r
    }

    /// Checks fees and caps, stores `order` as `signing`, and asks the signer.
    /// `prev` is restored if signing fails.
    fn sign_post(&mut self, prev: Order, mut order: Order, tx: TxParams, count: bool) -> Promise {
        let p = &self.policy;
        require!(
            tx.max_fee_per_gas.0 <= p.max_fee_cap.get(order.chain).0,
            "fee above cap"
        );
        require!(
            tx.max_priority_fee_per_gas.0 <= tx.max_fee_per_gas.0,
            "priority fee above max fee"
        );
        let posted_at = if count {
            let now = now_s();
            let key = VaultKey {
                chain: order.chain,
                vault: order.vault,
            };
            let mut h = self.posts.get(&key).cloned().unwrap_or_default();
            check_post(&h, &self.global_posts, now, p).unwrap_or_else(|e| env::panic_str(e));
            prune_history(&mut h, now);
            h.push(now);
            self.posts.insert(key, h);
            prune_history(&mut self.global_posts, now);
            self.global_posts.push(now);
            Some(now)
        } else {
            None
        };
        let hash = evm::payload_hash(&self.post(&order, &tx, None));
        order
            .reading
            .as_deref_mut()
            .expect("signing has a reading")
            .payload_hash = hash;
        order.status = OrderStatus::Signing;
        self.orders.insert(order.id, order);

        let args = format!(
            r#"{{"request":{{"path":"{PATH}","payload_v2":{{"Ecdsa":"{}"}},"domain_id":0}}}}"#,
            hex(&hash)
        );
        Promise::new(self.policy.signer.clone())
            .function_call_weight(
                "sign",
                args.into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FOR_SIGN,
                GasWeight(1),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_SIGNED)
                    .on_signed(prev, tx, posted_at),
            )
    }

    /// The order's post, unsigned, or signed with `sig`.
    fn post(&self, order: &Order, tx: &TxParams, sig: Option<&[u8; 65]>) -> Vec<u8> {
        let p = &self.policy;
        let r = order.reading.as_deref().expect("post needs a reading");
        let oracle = p
            .oracle
            .get(order.chain)
            .as_deref()
            .and_then(|o| parse_vault(o).ok())
            .unwrap_or_else(|| env::panic_str("no oracle for chain"));
        let data = evm::post_calldata(
            &order.vault,
            r.verdict as u8,
            r.confidence_bps,
            r.risk_bps,
            &r.state_hash,
        );
        let (id, gas) = (evm::chain_id(order.chain), *p.gas_limit.get(order.chain));
        let (prio, fee) = (tx.max_priority_fee_per_gas.0, tx.max_fee_per_gas.0);
        match sig {
            None => evm::unsigned_1559(id, tx.nonce, prio, fee, gas, &oracle, &data),
            Some(s) => evm::assemble_signed(id, tx.nonce, prio, fee, gas, &oracle, &data, s),
        }
    }

    /// The signed post, if `sig` is the desk's signature over the post it asked for.
    fn signed_post(&self, order: &Order, tx: &TxParams, sig: &[u8; 65]) -> Option<Vec<u8>> {
        let r = order.reading.as_deref()?;
        let hash = evm::payload_hash(&self.post(order, tx, None));
        if hash != r.payload_hash {
            return None;
        }
        let key = env::ecrecover(&hash, &sig[..64], sig[64], true)?;
        if env::keccak256_array(key)[12..] != self.derived_address {
            return None;
        }
        Some(self.post(order, tx, Some(sig)))
    }

    fn unrecord_post(&mut self, order: &Order, t: u32) {
        let key = VaultKey {
            chain: order.chain,
            vault: order.vault,
        };
        if let Some(h) = self.posts.get_mut(&key) {
            if let Some(i) = h.iter().rposition(|x| *x == t) {
                h.remove(i);
            }
        }
        if let Some(i) = self.global_posts.iter().rposition(|x| *x == t) {
            self.global_posts.remove(i);
        }
    }

    /// Splits a NEAR-paid order's escrow between treasury and agent.
    fn pay_split(&mut self, order: &Order) {
        let p = &self.policy;
        let to_treasury = order.amount * p.split_treasury_bps as u128 / 10_000;
        let to_agent = order.amount - to_treasury;
        let (treasury, agent) = (p.treasury.clone(), p.agent.clone());
        let t = &mut self.totals;
        match order.source {
            Source::Near => {
                t.treasury_near += to_treasury;
                t.agent_near += to_agent;
                for (who, amount) in [(treasury, to_treasury), (agent, to_agent)] {
                    if amount > 0 {
                        Promise::new(who)
                            .transfer(NearToken::from_yoctonear(amount))
                            .detach();
                    }
                }
            }
            Source::Usdc => {
                t.treasury_usdc += to_treasury;
                t.agent_usdc += to_agent;
                for (who, amount) in [(treasury, to_treasury), (agent, to_agent)] {
                    if amount > 0 {
                        self.pay_usdc(who, amount).detach();
                    }
                }
            }
            Source::X402 | Source::Watch => {}
        }
    }

    fn pay_usdc(&self, to: AccountId, amount: u128) -> Promise {
        let token = self
            .policy
            .usdc_token
            .clone()
            .unwrap_or_else(|| env::panic_str("usdc_token unset"));
        ext_ft::ext(token)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(to.clone(), U128(amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_USDC_PAID)
                    .on_usdc_paid(to, U128(amount)),
            )
    }
}

/// Reads a Chain Signatures `sign` response into `r || s || recovery_id`.
/// `{"scheme":"Secp256k1","big_r":{"affine_point":"02|03 + x"},"s":{"scalar":"…"},"recovery_id":0|1}`.
pub fn parse_mpc_response(body: &[u8]) -> Option<[u8; 65]> {
    #[near(serializers = [json])]
    struct Point {
        affine_point: String,
    }
    #[near(serializers = [json])]
    struct Scalar {
        scalar: String,
    }
    #[near(serializers = [json])]
    struct Response {
        scheme: String,
        big_r: Point,
        s: Scalar,
        recovery_id: u8,
    }
    let r: Response = near_sdk::serde_json::from_slice(body).ok()?;
    if r.scheme != "Secp256k1" || r.recovery_id > 1 {
        return None;
    }
    let x = r
        .big_r
        .affine_point
        .strip_prefix("02")
        .or_else(|| r.big_r.affine_point.strip_prefix("03"))?;
    let mut out = [0u8; 65];
    unhex(x, &mut out[..32])?;
    unhex(&r.s.scalar, &mut out[32..64])?;
    out[64] = r.recovery_id;
    Some(out)
}

fn unhex(s: &str, out: &mut [u8]) -> Option<()> {
    let h = s.as_bytes();
    if h.len() != out.len() * 2 {
        return None;
    }
    let nib = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    for (i, b) in out.iter_mut().enumerate() {
        *b = (nib(h[2 * i])? << 4) | nib(h[2 * i + 1])?;
    }
    Some(())
}

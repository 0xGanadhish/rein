use near_sdk::json_types::U128;
use near_sdk::{near, AccountId, NearToken};

#[near(serializers = [borsh, json])]
#[serde(rename_all = "kebab-case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Chain {
    MonadTestnet,
    Monad,
    Base,
    BaseSepolia,
}

#[near(serializers = [borsh, json])]
#[borsh(use_discriminant = true)]
#[serde(rename_all = "UPPERCASE")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Verdict {
    Hold = 0,
    Exit = 1,
    Move = 2,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Near,
    Usdc,
    X402,
    Watch,
}

impl Source {
    /// Paid orders count against `max_open_paid`; watch orders are the desk's own.
    pub fn is_paid(self) -> bool {
        !matches!(self, Source::Watch)
    }
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderStatus {
    Open,
    ExitPending,
    Signing,
    Signed,
    Delivered,
    Rejected,
    Refunded,
    PostFailed,
}

impl OrderStatus {
    pub fn is_finished(self) -> bool {
        matches!(
            self,
            OrderStatus::Delivered
                | OrderStatus::Rejected
                | OrderStatus::Refunded
                | OrderStatus::PostFailed
        )
    }

    /// Pre-sign statuses refundable without post-expiry checks.
    pub fn is_refundable(self) -> bool {
        matches!(self, OrderStatus::Open | OrderStatus::ExitPending)
    }
}

/// Stored order. Fixed, compact fields only.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub id: u64,
    pub source: Source,
    /// Who gets a refund. `None` for watch and x402 orders, which hold no onchain escrow.
    pub payer: Option<AccountId>,
    pub chain: Chain,
    pub vault: [u8; 20],
    /// yoctoNEAR for `Near`, USDC base units for `Usdc` and `X402`, 0 for `Watch`.
    pub amount: u128,
    pub created_s: u32,
    pub status: OrderStatus,
    /// The reading being confirmed or posted. `None` until `fulfil`.
    pub reading: Option<Box<Reading>>,
}

/// A verified reading and the post built from it.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reading {
    pub verdict: Verdict,
    pub confidence_bps: u16,
    pub risk_bps: u16,
    /// `keccak256(doc)`.
    pub state_hash: [u8; 32],
    /// When `fulfil` accepted the first reading.
    pub first_at: u32,
    /// Last second the oracle accepts this reading's post. Set once per reading; a re-sign keeps it.
    pub valid_until: u32,
    /// Target and gas fixed when the first signing attempt starts.
    pub oracle: [u8; 20],
    pub gas_limit: u64,
    /// Hash of the unsigned post last sent to the signer.
    pub payload_hash: [u8; 32],
    /// Signed type-2 transaction, until delivery.
    pub signed_tx: Option<Vec<u8>>,
    /// EVM transaction hash reported at delivery.
    pub delivered_tx: Option<String>,
}

/// What the agent chooses for a post. Everything else comes from the reading and the policy.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TxParams {
    pub nonce: u64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
}

/// One value per chain. JSON keys are the chain names.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PerChain<T> {
    #[serde(rename = "monad-testnet")]
    pub monad_testnet: T,
    pub monad: T,
    pub base: T,
    #[serde(rename = "base-sepolia")]
    pub base_sepolia: T,
}

impl<T> PerChain<T> {
    pub fn get(&self, c: Chain) -> &T {
        match c {
            Chain::MonadTestnet => &self.monad_testnet,
            Chain::Monad => &self.monad,
            Chain::Base => &self.base,
            Chain::BaseSepolia => &self.base_sepolia,
        }
    }

    pub fn get_mut(&mut self, c: Chain) -> &mut T {
        match c {
            Chain::MonadTestnet => &mut self.monad_testnet,
            Chain::Monad => &mut self.monad,
            Chain::Base => &mut self.base,
            Chain::BaseSepolia => &mut self.base_sepolia,
        }
    }
}

/// JSON view of an [`Order`].
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderView {
    pub id: u64,
    pub source: Source,
    pub payer: Option<AccountId>,
    pub chain: Chain,
    /// 0x-prefixed lowercase hex.
    pub vault: String,
    pub amount: U128,
    pub created_s: u32,
    pub status: OrderStatus,
    /// Last second the oracle accepts the reading's post. `None` before a reading.
    pub valid_until: Option<u32>,
    /// First reading time only while `exit_pending`; `None` in every other state.
    pub exit_pending_s: Option<u32>,
}

impl From<&Order> for OrderView {
    fn from(o: &Order) -> Self {
        Self {
            id: o.id,
            source: o.source,
            payer: o.payer.clone(),
            chain: o.chain,
            vault: vault_hex(&o.vault),
            amount: U128(o.amount),
            created_s: o.created_s,
            status: o.status,
            valid_until: o.reading.as_deref().map(|r| r.valid_until),
            exit_pending_s: o
                .reading
                .as_deref()
                .filter(|_| o.status == OrderStatus::ExitPending)
                .map(|r| r.first_at),
        }
    }
}

/// Menu, active-order and post-history key.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct VaultKey {
    pub chain: Chain,
    pub vault: [u8; 20],
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    /// Minimum seconds between two posts for the same vault.
    pub spacing_s: u32,
    /// Posts per vault per 3600 s.
    pub per_vault_max: u32,
    /// Posts across all vaults per 3600 s.
    pub global_max: u32,
    /// Watch requests per UTC day.
    pub watch_daily_max: u32,
    /// Seconds after creation when anyone may refund an unfinished order.
    pub deadline_s: u32,
    pub doc_max_age_s: u32,
    pub exit_confirm_min_s: u32,
    pub exit_confirm_max_s: u32,
    /// Unfinished paid orders across all vaults.
    pub max_open_paid: u32,
    /// USDC base units (6 decimals).
    pub price_usdc: U128,
    /// yoctoNEAR.
    pub price_near: U128,
    pub split_treasury_bps: u16,
    pub split_agent_bps: u16,
    pub kill: bool,
    /// NEP-141 USDC contract. `None` disables USDC orders (testnet).
    pub usdc_token: Option<AccountId>,
    pub agent: AccountId,
    pub treasury: AccountId,
    /// Rein oracle per chain, 0x hex. `None` refuses posts to that chain.
    pub oracle: PerChain<Option<String>>,
    /// Gas limit of a post, per chain.
    pub gas_limit: PerChain<u64>,
    /// Highest `max_fee_per_gas` the desk signs, wei, per chain.
    pub max_fee_cap: PerChain<U128>,
    /// Chain Signatures contract.
    pub signer: AccountId,
}

const GWEI: u128 = 1_000_000_000;

impl Policy {
    pub fn mainnet(agent: AccountId, treasury: AccountId, usdc_token: AccountId) -> Self {
        Self {
            spacing_s: 600,
            per_vault_max: 4,
            global_max: 40,
            watch_daily_max: 4,
            deadline_s: 1800,
            doc_max_age_s: 300,
            exit_confirm_min_s: 30,
            exit_confirm_max_s: 300,
            max_open_paid: 500,
            price_usdc: U128(1_000_000),
            price_near: U128(NearToken::from_millinear(300).as_yoctonear()),
            split_treasury_bps: 7000,
            split_agent_bps: 3000,
            kill: false,
            usdc_token: Some(usdc_token),
            agent,
            treasury,
            oracle: PerChain::default(),
            gas_limit: PerChain {
                // Monad charges the whole limit, so its testnet stays near the mirror vaults' 254,331.
                // Real vaults use up to 850,163 on Base; re-measure Monad's before going live there.
                monad_testnet: 400_000,
                monad: 1_000_000,
                base: 1_000_000,
                base_sepolia: 400_000,
            },
            max_fee_cap: PerChain {
                monad_testnet: U128(500 * GWEI),
                monad: U128(500 * GWEI),
                base: U128(5 * GWEI),
                base_sepolia: U128(5 * GWEI),
            },
            signer: "v1.signer".parse().unwrap(),
        }
    }

    pub fn testnet(agent: AccountId, treasury: AccountId) -> Self {
        Self {
            spacing_s: 60,
            per_vault_max: 30,
            global_max: 200,
            watch_daily_max: 200,
            price_near: U128(NearToken::from_millinear(100).as_yoctonear()),
            usdc_token: None,
            signer: "v1.signer-prod.testnet".parse().unwrap(),
            ..Self::mainnet(agent, treasury.clone(), treasury)
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Stats {
    /// yoctoNEAR accepted into escrow, gross of refunds.
    pub sales_near: U128,
    /// USDC accepted into escrow via `ft_transfer_call`, gross of refunds.
    pub sales_usdc: U128,
    /// USDC paid offchain over x402, as reported by the agent.
    pub sales_x402_usdc: U128,
    /// Orders refunded or rejected.
    pub refunds: u64,
    /// Unfinished paid orders.
    pub open_paid: u32,
    /// Model tokens across accepted readings.
    pub inference_tokens_in: u64,
    pub inference_tokens_out: u64,
    /// EVM gas spent on posts, wei, as reported by the agent.
    pub gas_wei: PerChain<U128>,
    /// Split credited to the treasury and the agent when orders are delivered.
    pub paid_treasury: Amounts,
    pub paid_agent: Amounts,
    /// USDC awaiting transfer success; failed transfers are claimable with `claim_owed`.
    pub owed: U128,
    /// yoctoNEAR awaiting transfer success; failed transfers are claimable with `claim_owed`.
    pub owed_near: U128,
    /// Watch orders opened.
    pub watch_orders: u64,
}

/// yoctoNEAR and USDC base units.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Amounts {
    pub near: U128,
    pub usdc: U128,
}

pub fn vault_hex(v: &[u8; 20]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(42);
    s.push_str("0x");
    for b in v {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

/// Parses a 0x-prefixed, 40-digit hex address in any case.
pub fn parse_vault(s: &str) -> Result<[u8; 20], &'static str> {
    let h = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .ok_or("vault must be 0x-prefixed hex")?
        .as_bytes();
    if h.len() != 40 {
        return Err("vault must be 20 bytes");
    }
    let nib = |c: u8| match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        _ => Err("vault must be hex"),
    };
    let mut out = [0u8; 20];
    for (i, b) in out.iter_mut().enumerate() {
        *b = (nib(h[2 * i])? << 4) | nib(h[2 * i + 1])?;
    }
    Ok(out)
}

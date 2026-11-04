use near_sdk::json_types::U128;
use near_sdk::{near, AccountId, NearToken};

#[near(serializers = [borsh, json])]
#[serde(rename_all = "kebab-case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Chain {
    MonadTestnet,
    Monad,
    Base,
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
}

impl OrderStatus {
    pub fn is_finished(self) -> bool {
        matches!(
            self,
            OrderStatus::Delivered | OrderStatus::Rejected | OrderStatus::Refunded
        )
    }

    /// Statuses from which escrow can still go back to the payer.
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
}

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

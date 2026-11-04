//! Rein desk: paid orders to judge a yield vault, held in escrow until delivered or refunded.

pub mod orders;
pub mod policy;
pub mod types;
pub mod views;

use near_sdk::store::key::Identity;
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

use policy::WatchDay;
use types::{parse_vault, Chain, Order, Policy, VaultKey};

/// Running totals behind the `stats` view.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Totals {
    pub sales_near: u128,
    pub sales_usdc: u128,
    pub sales_x402_usdc: u128,
    pub refunds: u64,
    pub open_paid: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Desk {
    owner: AccountId,
    policy: Policy,
    next_id: u64,
    orders: LookupMap<u64, Order>,
    /// Unfinished order per vault (one at a time).
    active: IterableMap<VaultKey, u64, Identity>,
    menu: IterableSet<VaultKey, Identity>,
    /// Post times per vault, last 3600 s.
    posts: LookupMap<VaultKey, Vec<u32>>,
    /// Post times across all vaults, last 3600 s.
    global_posts: Vec<u32>,
    watch: WatchDay,
    totals: Totals,
}

#[near]
impl Desk {
    #[init]
    pub fn new(owner: AccountId, policy: Policy) -> Self {
        validate(&policy);
        Self {
            owner,
            policy,
            next_id: 0,
            orders: LookupMap::new(b"o"),
            active: IterableMap::with_hasher(b"a"),
            menu: IterableSet::with_hasher(b"m"),
            posts: LookupMap::new(b"p"),
            global_posts: Vec::new(),
            watch: WatchDay::default(),
            totals: Totals::default(),
        }
    }

    pub fn set_policy(&mut self, policy: Policy) {
        self.assert_owner();
        validate(&policy);
        // Open USDC escrow is refunded through `usdc_token`; swapping it would strand refunds.
        require!(
            policy.usdc_token == self.policy.usdc_token || self.totals.open_paid == 0,
            "usdc_token is locked while paid orders are open"
        );
        self.policy = policy;
    }

    pub fn set_menu(&mut self, chain: Chain, vault: String, on: bool) {
        self.assert_owner();
        let key = VaultKey {
            chain,
            vault: parse_vault(&vault).unwrap_or_else(|e| env::panic_str(e)),
        };
        if on {
            self.menu.insert(key);
        } else {
            self.menu.remove(&key);
        }
    }

    pub fn kill_switch(&mut self, on: bool) {
        self.assert_owner();
        self.policy.kill = on;
    }
}

impl Desk {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn assert_agent(&self) {
        require!(
            env::predecessor_account_id() == self.policy.agent,
            "agent only"
        );
    }
}

fn validate(p: &Policy) {
    require!(
        p.split_treasury_bps as u32 + p.split_agent_bps as u32 == 10_000,
        "splits must sum to 10000 bps"
    );
    require!(
        p.exit_confirm_min_s <= p.exit_confirm_max_s,
        "exit_confirm_min_s above exit_confirm_max_s"
    );
}

pub(crate) fn now_s() -> u32 {
    (env::block_timestamp() / 1_000_000_000) as u32
}

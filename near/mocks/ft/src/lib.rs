//! Minimal NEP-141 token for sandbox tests. Accounts need no storage registration.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, PromiseOrValue,
};

const GAS_FOR_ON_TRANSFER: Gas = Gas::from_tgas(30);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(10);

#[ext_contract(ext_receiver)]
pub trait Receiver {
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128>;
}

#[ext_contract(ext_self)]
pub trait SelfCallbacks {
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    balances: LookupMap<AccountId, u128>,
    total_supply: u128,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128) -> Self {
        let mut balances = LookupMap::new(b"b");
        balances.insert(owner_id, total_supply.0);
        Self {
            balances,
            total_supply: total_supply.0,
        }
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "Requires attached deposit of exactly 1 yoctoNEAR"
        );
        let _ = memo;
        self.move_balance(&env::predecessor_account_id(), &receiver_id, amount.0);
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "Requires attached deposit of exactly 1 yoctoNEAR"
        );
        let _ = memo;
        let sender_id = env::predecessor_account_id();
        self.move_balance(&sender_id, &receiver_id, amount.0);
        ext_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_FOR_ON_TRANSFER)
            .ft_on_transfer(sender_id.clone(), amount, msg)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE)
                    .ft_resolve_transfer(sender_id, receiver_id, amount),
            )
            .into()
    }

    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let unused = env::promise_result_checked(0, 64)
            .ok()
            .and_then(|v| near_sdk::serde_json::from_slice::<U128>(&v).ok())
            .map_or(amount.0, |u| u.0.min(amount.0));
        let refund = unused.min(self.balances.get(&receiver_id).copied().unwrap_or(0));
        if refund > 0 {
            self.move_balance(&receiver_id, &sender_id, refund);
        }
        U128(amount.0 - refund)
    }
}

impl Contract {
    fn move_balance(&mut self, from: &AccountId, to: &AccountId, amount: u128) {
        require!(amount > 0, "amount must be positive");
        let from_bal = self.balances.get(from).copied().unwrap_or(0);
        require!(from_bal >= amount, "insufficient balance");
        self.balances.insert(from.clone(), from_bal - amount);
        let to_bal = self.balances.get(to).copied().unwrap_or(0);
        self.balances.insert(to.clone(), to_bal + amount);
    }
}

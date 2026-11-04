//! Sandbox tests against the release wasm. Build it first:
//! `cargo near build non-reproducible-wasm` in `near/desk` and `near/mocks/ft`.

use desk::types::{Chain, OrderStatus, OrderView, Policy, Source, Stats, VaultKey};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};

const V1: &str = "0x1111111111111111111111111111111111111111";
const V2: &str = "0x2222222222222222222222222222222222222222";
const V3: &str = "0x3333333333333333333333333333333333333333";
const V4: &str = "0x4444444444444444444444444444444444444444";
const V5: &str = "0x5555555555555555555555555555555555555555";
const PRICE_USDC: u128 = 1_000_000;
const DAY_S: u64 = 86_400;

fn price_near() -> NearToken {
    NearToken::from_millinear(300)
}

fn wasm(crate_name: &str) -> Vec<u8> {
    let path = format!(
        "{}/../target/near/{crate_name}/{crate_name}.wasm",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|_| {
        panic!("{path} missing: run `cargo near build non-reproducible-wasm` first")
    })
}

struct Env {
    worker: Worker<Sandbox>,
    _node: near_sandbox::Sandbox,
    owner: Account,
    agent: Account,
    alice: Account,
    bob: Account,
    desk: Contract,
    ft: Contract,
}

async fn setup() -> anyhow::Result<Env> {
    setup_with(|_| {}).await
}

/// Deploys the desk with mainnet defaults (USDC = mock token), V1..V5 on the Base menu,
/// and gives alice and bob 10 USDC each.
async fn setup_with(tweak: impl FnOnce(&mut Policy)) -> anyhow::Result<Env> {
    // A long epoch keeps `fast_forward` cheap: each epoch it crosses costs seconds.
    let node = near_sandbox::Sandbox::start_sandbox_with_config(near_sandbox::SandboxConfig {
        additional_genesis: Some(json!({ "epoch_length": 10_000_000 })),
        additional_accounts: vec![near_sandbox::GenesisAccount::default_with_name(
            "registrar".parse()?,
        )],
        ..Default::default()
    })
    .await?;
    let worker = near_workspaces::sandbox()
        .rpc_addr(&node.rpc_addr)
        .validator_key(near_workspaces::network::ValidatorKey::HomeDir(
            node.home_dir.path().to_path_buf(),
        ))
        .await?;
    let root = worker.root_account()?;
    let make = |name: &'static str| {
        let root = root.clone();
        async move {
            anyhow::Ok(
                root.create_subaccount(name)
                    .initial_balance(NearToken::from_near(50))
                    .transact()
                    .await?
                    .into_result()?,
            )
        }
    };
    let owner = make("owner").await?;
    let agent = make("agent").await?;
    let treasury = make("treasury").await?;
    let alice = make("alice").await?;
    let bob = make("bob").await?;

    let ft = worker.dev_deploy(&wasm("mock_ft")).await?;
    ft.call("new")
        .args_json(json!({ "owner_id": owner.id(), "total_supply": U128(1_000_000_000) }))
        .transact()
        .await?
        .into_result()?;
    for who in [&alice, &bob] {
        owner
            .call(ft.id(), "ft_transfer")
            .args_json(json!({ "receiver_id": who.id(), "amount": U128(10 * PRICE_USDC) }))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .into_result()?;
    }

    let mut policy = Policy::mainnet(agent.id().clone(), treasury.id().clone(), ft.id().clone());
    tweak(&mut policy);
    let desk = worker.dev_deploy(&wasm("desk")).await?;
    desk.call("new")
        .args_json(json!({ "owner": owner.id(), "policy": policy }))
        .transact()
        .await?
        .into_result()?;
    for v in [V1, V2, V3, V4, V5] {
        owner
            .call(desk.id(), "set_menu")
            .args_json(json!({ "chain": "base", "vault": v, "on": true }))
            .transact()
            .await?
            .into_result()?;
    }
    Ok(Env {
        worker,
        _node: node,
        owner,
        agent,
        alice,
        bob,
        desk,
        ft,
    })
}

impl Env {
    async fn order_near(
        &self,
        who: &Account,
        vault: &str,
        deposit: NearToken,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(self.desk.id(), "request_judgement")
            .args_json(json!({ "chain": "base", "vault": vault }))
            .deposit(deposit)
            .max_gas()
            .transact()
            .await?)
    }

    async fn order_usdc(
        &self,
        who: &Account,
        amount: u128,
        msg: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(self.ft.id(), "ft_transfer_call")
            .args_json(json!({ "receiver_id": self.desk.id(), "amount": U128(amount), "msg": msg }))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?)
    }

    async fn call(
        &self,
        who: &Account,
        method: &str,
        args: Value,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(self.desk.id(), method)
            .args_json(args)
            .max_gas()
            .transact()
            .await?)
    }

    async fn order(&self, id: u64) -> anyhow::Result<Option<OrderView>> {
        Ok(self
            .desk
            .view("get_order")
            .args_json(json!({ "order_id": id }))
            .await?
            .json()?)
    }

    async fn stats(&self) -> anyhow::Result<Stats> {
        Ok(self.desk.view("stats").await?.json()?)
    }

    async fn near_balance(&self, who: &Account) -> anyhow::Result<NearToken> {
        Ok(self.worker.view_account(who.id()).await?.balance)
    }

    async fn usdc_balance(&self, who: &near_workspaces::AccountId) -> anyhow::Result<u128> {
        let b: U128 = self
            .ft
            .view("ft_balance_of")
            .args_json(json!({ "account_id": who }))
            .await?
            .json()?;
        Ok(b.0)
    }

    async fn now_s(&self) -> anyhow::Result<u64> {
        Ok(self.worker.view_block().await?.timestamp() / 1_000_000_000)
    }

    /// Moves block time forward by at least `secs`.
    async fn advance(&self, secs: u64) -> anyhow::Result<()> {
        let target = self.now_s().await? + secs;
        loop {
            let now = self.now_s().await?;
            if now >= target {
                return Ok(());
            }
            self.worker.fast_forward((target - now).max(1)).await?;
        }
    }
}

fn usdc_msg(vault: &str) -> String {
    json!({ "chain": "base", "vault": vault }).to_string()
}

/// Spent less than this on gas: the payment itself came back.
fn gas_only() -> NearToken {
    NearToken::from_millinear(20)
}

fn id_of(r: ExecutionFinalResult) -> anyhow::Result<u64> {
    Ok(r.into_result()?.json()?)
}

#[tokio::test]
async fn near_order_created_and_escrowed() -> anyhow::Result<()> {
    let e = setup().await?;
    let desk_before = e.near_balance(e.desk.as_account()).await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    assert_eq!(id, 0);

    let o = e.order(id).await?.expect("order stored");
    assert_eq!(o.source, Source::Near);
    assert_eq!(o.payer.as_ref(), Some(e.alice.id()));
    assert_eq!(o.chain, Chain::Base);
    assert_eq!(o.vault, V1);
    assert_eq!(o.amount, U128(price_near().as_yoctonear()));
    assert_eq!(o.status, OrderStatus::Open);
    assert!(e.near_balance(e.desk.as_account()).await? >= desk_before.saturating_add(price_near()));

    let s = e.stats().await?;
    assert_eq!(s.sales_near, U128(price_near().as_yoctonear()));
    assert_eq!(s.open_paid, 1);
    let open: Vec<OrderView> = e
        .desk
        .view("open_orders")
        .args_json(json!({ "limit": 10 }))
        .await?
        .json()?;
    assert_eq!(open, vec![o.clone()]);
    let listed: Vec<OrderView> = e
        .desk
        .view("list_orders")
        .args_json(json!({ "from": 0, "limit": 10 }))
        .await?
        .json()?;
    assert_eq!(listed, vec![o]);

    let raw: Value = e
        .desk
        .view("get_order")
        .args_json(json!({ "order_id": id }))
        .await?
        .json()?;
    assert_eq!(raw["vault"], V1);
    assert_eq!(raw["chain"], "base");
    assert_eq!(raw["source"], "near");
    assert_eq!(raw["status"], "open");
    Ok(())
}

#[tokio::test]
async fn overpay_refunds_excess() -> anyhow::Result<()> {
    let e = setup().await?;
    let before = e.near_balance(&e.alice).await?;
    let id = id_of(e.order_near(&e.alice, V1, NearToken::from_near(2)).await?)?;
    let spent = before.saturating_sub(e.near_balance(&e.alice).await?);
    assert!(
        spent >= price_near() && spent < price_near().saturating_add(gas_only()),
        "spent {spent}"
    );
    assert_eq!(
        e.order(id).await?.unwrap().amount,
        U128(price_near().as_yoctonear())
    );
    Ok(())
}

#[tokio::test]
async fn underpay_panics_and_returns_deposit() -> anyhow::Result<()> {
    let e = setup().await?;
    let before = e.near_balance(&e.alice).await?;
    let r = e
        .order_near(&e.alice, V1, NearToken::from_millinear(299))
        .await?;
    assert!(r.is_failure());
    assert!(before.saturating_sub(e.near_balance(&e.alice).await?) < gas_only());
    assert_eq!(e.order(0).await?, None);
    assert_eq!(e.stats().await?, Stats::default());
    Ok(())
}

#[tokio::test]
async fn usdc_order_via_ft_transfer_call() -> anyhow::Result<()> {
    let e = setup().await?;
    let r = e.order_usdc(&e.alice, PRICE_USDC, &usdc_msg(V1)).await?;
    let used: U128 = r.into_result()?.json()?;
    assert_eq!(used, U128(PRICE_USDC));
    assert_eq!(e.usdc_balance(e.desk.id()).await?, PRICE_USDC);
    assert_eq!(e.usdc_balance(e.alice.id()).await?, 9 * PRICE_USDC);

    let o = e.order(0).await?.expect("order stored");
    assert_eq!(o.source, Source::Usdc);
    assert_eq!(o.payer.as_ref(), Some(e.alice.id()));
    assert_eq!(o.amount, U128(PRICE_USDC));
    assert_eq!(o.status, OrderStatus::Open);
    let s = e.stats().await?;
    assert_eq!(s.sales_usdc, U128(PRICE_USDC));
    assert_eq!(s.open_paid, 1);
    Ok(())
}

#[tokio::test]
async fn ft_bad_msg_refunds_all() -> anyhow::Result<()> {
    let e = setup().await?;
    let unknown = "0x9999999999999999999999999999999999999999";
    for (amount, msg) in [
        (PRICE_USDC, usdc_msg(unknown)),
        (PRICE_USDC, "{\"chain\":\"base\"".to_string()),
        (
            PRICE_USDC,
            json!({ "chain": "solana", "vault": V1 }).to_string(),
        ),
        (PRICE_USDC + 1, usdc_msg(V1)),
        (PRICE_USDC - 1, usdc_msg(V1)),
    ] {
        let r = e.order_usdc(&e.alice, amount, &msg).await?;
        let used: U128 = r.into_result()?.json()?;
        assert_eq!(used, U128(0), "msg {msg} amount {amount}");
        assert_eq!(e.usdc_balance(e.alice.id()).await?, 10 * PRICE_USDC);
        assert_eq!(e.usdc_balance(e.desk.id()).await?, 0);
    }
    assert_eq!(e.order(0).await?, None);
    assert_eq!(e.stats().await?, Stats::default());
    Ok(())
}

#[tokio::test]
async fn menu_off_refused() -> anyhow::Result<()> {
    let e = setup().await?;
    e.call(
        &e.owner,
        "set_menu",
        json!({ "chain": "base", "vault": V1, "on": false }),
    )
    .await?
    .into_result()?;
    let menu: Vec<String> = e
        .desk
        .view("menu")
        .args_json(json!({ "chain": "base" }))
        .await?
        .json()?;
    assert!(!menu.contains(&V1.to_string()) && menu.contains(&V2.to_string()));

    let before = e.near_balance(&e.alice).await?;
    assert!(e.order_near(&e.alice, V1, price_near()).await?.is_failure());
    assert!(before.saturating_sub(e.near_balance(&e.alice).await?) < gas_only());
    // Same vault on another chain is a different menu entry.
    let r = e
        .alice
        .call(e.desk.id(), "request_judgement")
        .args_json(json!({ "chain": "monad", "vault": V2 }))
        .deposit(price_near())
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_failure());
    // Only the owner edits the menu.
    assert!(e
        .call(
            &e.alice,
            "set_menu",
            json!({ "chain": "base", "vault": V1, "on": true })
        )
        .await?
        .is_failure());
    assert_eq!(e.order(0).await?, None);
    Ok(())
}

#[tokio::test]
async fn spacing_refuses_within_600s() -> anyhow::Result<()> {
    let e = setup().await?;
    // Posts are recorded when the desk requests a signature, which a later layer adds.
    // Seed V1's post history directly: key = b"p" ++ borsh(VaultKey), value = borsh(Vec<u32>).
    let now = e.now_s().await? as u32;
    let key = [
        b"p".to_vec(),
        near_sdk::borsh::to_vec(&VaultKey {
            chain: Chain::Base,
            vault: [0x11; 20],
        })?,
    ]
    .concat();
    e.worker
        .patch_state(e.desk.id(), &key, &near_sdk::borsh::to_vec(&vec![now])?)
        .await?;

    let before = e.near_balance(&e.alice).await?;
    assert!(e.order_near(&e.alice, V1, price_near()).await?.is_failure());
    assert!(before.saturating_sub(e.near_balance(&e.alice).await?) < gas_only());
    let r = e.order_usdc(&e.bob, PRICE_USDC, &usdc_msg(V1)).await?;
    assert_eq!(r.into_result()?.json::<U128>()?, U128(0));
    assert_eq!(e.order(0).await?, None);

    // Other vaults are unaffected, and V1 opens once 600 s have passed.
    assert_eq!(id_of(e.order_near(&e.alice, V2, price_near()).await?)?, 0);
    e.advance(600).await?;
    assert_eq!(id_of(e.order_near(&e.alice, V1, price_near()).await?)?, 1);
    Ok(())
}

#[tokio::test]
async fn second_open_order_same_vault_refused() -> anyhow::Result<()> {
    let e = setup().await?;
    id_of(e.order_near(&e.alice, V1, price_near()).await?)?;

    let before = e.near_balance(&e.bob).await?;
    assert!(e.order_near(&e.bob, V1, price_near()).await?.is_failure());
    assert!(before.saturating_sub(e.near_balance(&e.bob).await?) < gas_only());

    let r = e.order_usdc(&e.bob, PRICE_USDC, &usdc_msg(V1)).await?;
    assert_eq!(r.into_result()?.json::<U128>()?, U128(0));
    assert_eq!(e.usdc_balance(e.bob.id()).await?, 10 * PRICE_USDC);
    assert!(e
        .call(
            &e.agent,
            "submit_watch_request",
            json!({ "chain": "base", "vault": V1 })
        )
        .await?
        .is_failure());

    assert_eq!(e.order(1).await?, None);
    assert_eq!(e.stats().await?.open_paid, 1);
    Ok(())
}

#[tokio::test]
async fn max_open_paid() -> anyhow::Result<()> {
    let e = setup_with(|p| p.max_open_paid = 2).await?;
    id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    e.order_usdc(&e.alice, PRICE_USDC, &usdc_msg(V2))
        .await?
        .into_result()?;
    assert_eq!(e.stats().await?.open_paid, 2);

    assert!(e.order_near(&e.bob, V3, price_near()).await?.is_failure());
    let r = e.order_usdc(&e.bob, PRICE_USDC, &usdc_msg(V3)).await?;
    assert_eq!(r.into_result()?.json::<U128>()?, U128(0));
    let x402 =
        json!({ "chain": "base", "vault": V3, "payment_ref": "pay-1", "amount": U128(PRICE_USDC) });
    assert!(e
        .call(&e.agent, "submit_x402_request", x402)
        .await?
        .is_failure());
    // Watch orders are not paid and do not count.
    id_of(
        e.call(
            &e.agent,
            "submit_watch_request",
            json!({ "chain": "base", "vault": V3 }),
        )
        .await?,
    )?;
    assert_eq!(e.stats().await?.open_paid, 2);
    Ok(())
}

#[tokio::test]
async fn kill_switch_refuses_new_and_allows_refund_of_open() -> anyhow::Result<()> {
    let e = setup().await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    assert!(e
        .call(&e.alice, "kill_switch", json!({ "on": true }))
        .await?
        .is_failure());
    e.call(&e.owner, "kill_switch", json!({ "on": true }))
        .await?
        .into_result()?;
    let p: Policy = e.desk.view("policy").await?.json()?;
    assert!(p.kill);

    assert!(e.order_near(&e.bob, V2, price_near()).await?.is_failure());
    let r = e.order_usdc(&e.bob, PRICE_USDC, &usdc_msg(V2)).await?;
    assert_eq!(r.into_result()?.json::<U128>()?, U128(0));
    assert!(e
        .call(
            &e.agent,
            "submit_watch_request",
            json!({ "chain": "base", "vault": V2 })
        )
        .await?
        .is_failure());

    let before = e.near_balance(&e.alice).await?;
    e.call(&e.bob, "refund", json!({ "order_id": id }))
        .await?
        .into_result()?;
    assert_eq!(
        e.near_balance(&e.alice).await?,
        before.saturating_add(price_near())
    );
    assert_eq!(e.order(id).await?.unwrap().status, OrderStatus::Refunded);
    Ok(())
}

#[tokio::test]
async fn watch_request_only_from_agent() -> anyhow::Result<()> {
    let e = setup().await?;
    for who in [&e.alice, &e.owner] {
        assert!(e
            .call(
                who,
                "submit_watch_request",
                json!({ "chain": "base", "vault": V1 })
            )
            .await?
            .is_failure());
    }
    let id = id_of(
        e.call(
            &e.agent,
            "submit_watch_request",
            json!({ "chain": "base", "vault": V1 }),
        )
        .await?,
    )?;
    let o = e.order(id).await?.unwrap();
    assert_eq!(
        (o.source, o.payer, o.amount, o.status),
        (Source::Watch, None, U128(0), OrderStatus::Open)
    );
    assert_eq!(e.stats().await?.open_paid, 0);
    Ok(())
}

#[tokio::test]
async fn x402_request_only_from_agent() -> anyhow::Result<()> {
    let e = setup().await?;
    let args = json!({ "chain": "base", "vault": V1, "payment_ref": "x402-abc", "amount": U128(PRICE_USDC) });
    for who in [&e.alice, &e.owner] {
        assert!(e
            .call(who, "submit_x402_request", args.clone())
            .await?
            .is_failure());
    }
    let low = json!({ "chain": "base", "vault": V1, "payment_ref": "x402-abc", "amount": U128(PRICE_USDC - 1) });
    assert!(e
        .call(&e.agent, "submit_x402_request", low)
        .await?
        .is_failure());

    let id = id_of(e.call(&e.agent, "submit_x402_request", args).await?)?;
    let o = e.order(id).await?.unwrap();
    assert_eq!(
        (o.source, o.payer, o.amount, o.status),
        (Source::X402, None, U128(PRICE_USDC), OrderStatus::Open)
    );
    let s = e.stats().await?;
    assert_eq!((s.sales_x402_usdc, s.open_paid), (U128(PRICE_USDC), 1));
    Ok(())
}

#[tokio::test]
async fn watch_cap_refuses_fifth() -> anyhow::Result<()> {
    let e = setup().await?;
    for v in [V1, V2, V3, V4] {
        id_of(
            e.call(
                &e.agent,
                "submit_watch_request",
                json!({ "chain": "base", "vault": v }),
            )
            .await?,
        )?;
    }
    assert!(e
        .call(
            &e.agent,
            "submit_watch_request",
            json!({ "chain": "base", "vault": V5 })
        )
        .await?
        .is_failure());
    // Paid orders are not capped by the watch limit.
    id_of(e.order_near(&e.alice, V5, price_near()).await?)?;
    Ok(())
}

#[tokio::test]
async fn refund_only_after_deadline() -> anyhow::Result<()> {
    let e = setup().await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    assert!(e
        .call(&e.bob, "refund", json!({ "order_id": id }))
        .await?
        .is_failure());
    e.advance(1700).await?;
    assert!(e
        .call(&e.bob, "refund", json!({ "order_id": id }))
        .await?
        .is_failure());
    assert_eq!(e.order(id).await?.unwrap().status, OrderStatus::Open);
    e.advance(100).await?;
    e.call(&e.bob, "refund", json!({ "order_id": id }))
        .await?
        .into_result()?;
    assert_eq!(e.order(id).await?.unwrap().status, OrderStatus::Refunded);
    Ok(())
}

#[tokio::test]
async fn refund_pays_back_payer_near_and_usdc() -> anyhow::Result<()> {
    let e = setup().await?;
    let near_id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    e.order_usdc(&e.alice, PRICE_USDC, &usdc_msg(V2))
        .await?
        .into_result()?;
    let usdc_id = near_id + 1;
    assert_eq!(e.usdc_balance(e.alice.id()).await?, 9 * PRICE_USDC);

    e.advance(1800).await?;
    let before = e.near_balance(&e.alice).await?;
    e.call(&e.bob, "refund", json!({ "order_id": near_id }))
        .await?
        .into_result()?;
    e.call(&e.bob, "refund", json!({ "order_id": usdc_id }))
        .await?
        .into_result()?;
    assert_eq!(
        e.near_balance(&e.alice).await?,
        before.saturating_add(price_near())
    );
    assert_eq!(e.usdc_balance(e.alice.id()).await?, 10 * PRICE_USDC);
    assert_eq!(e.usdc_balance(e.desk.id()).await?, 0);

    let s = e.stats().await?;
    assert_eq!((s.refunds, s.open_paid), (2, 0));
    // The vaults are free again.
    id_of(e.order_near(&e.bob, V1, price_near()).await?)?;
    Ok(())
}

#[tokio::test]
async fn reject_only_by_agent_refunds_in_full() -> anyhow::Result<()> {
    let e = setup().await?;
    let near_id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    e.order_usdc(&e.alice, PRICE_USDC, &usdc_msg(V2))
        .await?
        .into_result()?;
    let usdc_id = near_id + 1;
    for who in [&e.alice, &e.owner, &e.bob] {
        assert!(e
            .call(
                who,
                "reject",
                json!({ "order_id": near_id, "reason": "no" })
            )
            .await?
            .is_failure());
    }

    let before = e.near_balance(&e.alice).await?;
    e.call(
        &e.agent,
        "reject",
        json!({ "order_id": near_id, "reason": "vault paused" }),
    )
    .await?
    .into_result()?;
    e.call(
        &e.agent,
        "reject",
        json!({ "order_id": usdc_id, "reason": "vault paused" }),
    )
    .await?
    .into_result()?;
    assert_eq!(
        e.near_balance(&e.alice).await?,
        before.saturating_add(price_near())
    );
    assert_eq!(e.usdc_balance(e.alice.id()).await?, 10 * PRICE_USDC);
    assert_eq!(
        e.order(near_id).await?.unwrap().status,
        OrderStatus::Rejected
    );
    assert_eq!(
        e.order(usdc_id).await?.unwrap().status,
        OrderStatus::Rejected
    );
    assert!(e
        .call(
            &e.agent,
            "reject",
            json!({ "order_id": near_id, "reason": "again" })
        )
        .await?
        .is_failure());
    Ok(())
}

#[tokio::test]
async fn refund_twice_fails() -> anyhow::Result<()> {
    let e = setup().await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    e.call(&e.owner, "kill_switch", json!({ "on": true }))
        .await?
        .into_result()?;
    e.call(&e.bob, "refund", json!({ "order_id": id }))
        .await?
        .into_result()?;
    let before = e.near_balance(&e.alice).await?;
    assert!(e
        .call(&e.bob, "refund", json!({ "order_id": id }))
        .await?
        .is_failure());
    assert!(e
        .call(&e.agent, "reject", json!({ "order_id": id, "reason": "x" }))
        .await?
        .is_failure());
    assert_eq!(e.near_balance(&e.alice).await?, before);
    assert_eq!(e.stats().await?.refunds, 1);
    Ok(())
}

#[tokio::test]
async fn prune_only_finished_older_than_7_days() -> anyhow::Result<()> {
    let e = setup().await?;
    let done = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let open = id_of(e.order_near(&e.alice, V2, price_near()).await?)?;
    e.call(
        &e.agent,
        "reject",
        json!({ "order_id": done, "reason": "x" }),
    )
    .await?
    .into_result()?;

    let ids = json!({ "order_ids": [done, open, 99] });
    let n: u32 = e
        .call(&e.bob, "prune", ids.clone())
        .await?
        .into_result()?
        .json()?;
    assert_eq!(n, 0);
    assert!(e.order(done).await?.is_some());

    e.advance(7 * DAY_S).await?;
    let n: u32 = e.call(&e.bob, "prune", ids).await?.into_result()?.json()?;
    assert_eq!(n, 1);
    assert_eq!(e.order(done).await?, None);
    assert_eq!(e.order(open).await?.unwrap().status, OrderStatus::Open);
    Ok(())
}

#[tokio::test]
async fn owner_cannot_withdraw_escrow() -> anyhow::Result<()> {
    let e = setup().await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    e.order_usdc(&e.alice, PRICE_USDC, &usdc_msg(V2))
        .await?
        .into_result()?;
    let owner_before = e.near_balance(&e.owner).await?;

    assert!(e
        .call(&e.owner, "refund", json!({ "order_id": id }))
        .await?
        .is_failure());
    assert!(e
        .call(
            &e.owner,
            "reject",
            json!({ "order_id": id, "reason": "mine" })
        )
        .await?
        .is_failure());
    for method in ["withdraw", "ft_transfer", "transfer"] {
        let args = json!({ "receiver_id": e.owner.id(), "amount": U128(1) });
        assert!(
            e.call(&e.owner, method, args).await?.is_failure(),
            "{method}"
        );
    }
    // A USDC token swap with escrow open would strand refunds.
    let mut p: Policy = e.desk.view("policy").await?.json()?;
    p.usdc_token = Some(e.owner.id().clone());
    assert!(e
        .call(&e.owner, "set_policy", json!({ "policy": p }))
        .await?
        .is_failure());

    // Even as agent, the owner can only send escrow back to the payer.
    let mut p: Policy = e.desk.view("policy").await?.json()?;
    p.agent = e.owner.id().clone();
    p.treasury = e.owner.id().clone();
    e.call(&e.owner, "set_policy", json!({ "policy": p }))
        .await?
        .into_result()?;
    let alice_before = e.near_balance(&e.alice).await?;
    e.call(
        &e.owner,
        "reject",
        json!({ "order_id": id, "reason": "mine" }),
    )
    .await?
    .into_result()?;
    e.call(
        &e.owner,
        "reject",
        json!({ "order_id": id + 1, "reason": "mine" }),
    )
    .await?
    .into_result()?;
    assert_eq!(
        e.near_balance(&e.alice).await?,
        alice_before.saturating_add(price_near())
    );
    assert_eq!(e.usdc_balance(e.alice.id()).await?, 10 * PRICE_USDC);
    assert_eq!(
        e.usdc_balance(e.owner.id()).await?,
        1_000_000_000 - 20 * PRICE_USDC
    );
    assert!(e.near_balance(&e.owner).await? <= owner_before);
    Ok(())
}

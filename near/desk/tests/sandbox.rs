//! Sandbox tests against the release wasm. Build it first:
//! `cargo near build non-reproducible-wasm` in `near/desk`, `near/mocks/ft` and `near/mocks/signer`.

use desk::evm;
use desk::types::{Chain, OrderStatus, OrderView, Policy, Source, Stats, VaultKey};
use desk::verify::signed_text;
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
    treasury: Account,
    alice: Account,
    bob: Account,
    desk: Contract,
    ft: Contract,
    signer: Contract,
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

    let signer = worker.dev_deploy(&wasm("mock_signer")).await?;
    signer.call("new").transact().await?.into_result()?;

    let mut policy = Policy::mainnet(agent.id().clone(), treasury.id().clone(), ft.id().clone());
    policy.signer = signer.id().clone();
    policy.oracle.base = Some(ORACLE.into());
    tweak(&mut policy);
    let desk = worker.dev_deploy(&wasm("desk")).await?;
    desk.call("new")
        .args_json(json!({
            "owner": owner.id(),
            "policy": policy,
            "derived_address": hex0x(&address(&MOCK_SIGNER_KEY)),
        }))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(desk.id(), "set_prompt")
        .args_json(json!({ "model": MODEL, "prefix": PREFIX, "suffix": SUFFIX }))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(desk.id(), "set_signer")
        .args_json(json!({ "address": hex0x(&address(&MODEL_KEY)), "on": true }))
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
        treasury,
        alice,
        bob,
        desk,
        ft,
        signer,
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

// ---- Signing ----

const MODEL: &str = "z-ai/glm-5.3-flash";
const PREFIX: &str = r#"{"model":"z-ai/glm-5.3-flash","messages":[{"role":"user","content":""#;
const SUFFIX: &str = r#""}],"temperature":0}"#;
const ORACLE: &str = "0x00000000000000000000000000000000000000a1";
/// The mock signer's fixed key; its address is the desk's derived address.
const MOCK_SIGNER_KEY: [u8; 32] = [0x42; 32];
/// The test model's key, approved with `set_signer`.
const MODEL_KEY: [u8; 32] = [0x07; 32];
const GWEI: u128 = 1_000_000_000;
const BASE_GAS_LIMIT: u64 = 1_000_000;
const TX_HASH: &str = "0xabababababababababababababababababababababababababababababababab";

fn secret(k: &[u8; 32]) -> secp256k1::SecretKey {
    secp256k1::SecretKey::from_slice(k).unwrap()
}

fn address(k: &[u8; 32]) -> [u8; 20] {
    let pk = secret(k)
        .public_key(&secp256k1::Secp256k1::new())
        .serialize_uncompressed();
    near_sdk::env::keccak256_array(&pk[1..])[12..]
        .try_into()
        .unwrap()
}

fn hex0x(b: &[u8]) -> String {
    let mut s = String::from("0x");
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

/// `r || s || v` over `hash` with `k`, `v` = recovery id + `v_base`.
fn sign_hash(k: &[u8; 32], hash: &[u8; 32], v_base: u8) -> [u8; 65] {
    let m = secp256k1::Message::from_slice(hash).unwrap();
    let (id, rs) = secp256k1::Secp256k1::new()
        .sign_ecdsa_recoverable(&m, &secret(k))
        .serialize_compact();
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&rs);
    out[64] = v_base + id.to_i32() as u8;
    out
}

/// A model reading as the Worker would pass it.
#[derive(Clone)]
struct Reading {
    doc: String,
    response: String,
    signature: String,
}

impl Reading {
    /// The model's answer to `doc`, signed by the approved model key.
    fn new(doc: String, action: &str, confidence_bps: u16, risk_bps: u16) -> Self {
        let content = json!(format!(
            r#"{{"action":"{action}","confidence_bps":{confidence_bps},"withdrawal_risk_bps":{risk_bps}}}"#
        ));
        let response = format!(
            r#"{{"id":"chatcmpl-1","model":"{MODEL}","choices":[{{"index":0,"message":{{"role":"assistant","content":{content}}},"finish_reason":"stop"}}],"usage":{{"prompt_tokens":812,"completion_tokens":34,"total_tokens":846}}}}"#
        );
        let request = [PREFIX, doc.as_str(), SUFFIX].concat();
        let text = signed_text(MODEL, request.as_bytes(), response.as_bytes());
        let mut msg = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
        msg.extend_from_slice(text.as_bytes());
        let sig = sign_hash(&MODEL_KEY, &near_sdk::env::keccak256_array(&msg), 27);
        Self {
            doc,
            response,
            signature: hex0x(&sig),
        }
    }

    fn args(&self, order_id: u64, tx: Value) -> Value {
        json!({
            "order_id": order_id,
            "doc": self.doc,
            "response": self.response,
            "signature": self.signature,
            "tx": tx,
        })
    }
}

fn tx(nonce: u64) -> Value {
    tx_fees(nonce, 2 * GWEI, GWEI)
}

fn tx_fees(nonce: u64, max_fee: u128, max_prio: u128) -> Value {
    json!({
        "nonce": nonce,
        "max_fee_per_gas": U128(max_fee),
        "max_priority_fee_per_gas": U128(max_prio),
    })
}

/// The post the desk should sign on Base for `doc` with default fees, signed by the mock key.
fn expected_post(
    vault: &str,
    verdict: u8,
    confidence_bps: u16,
    risk_bps: u16,
    doc: &str,
    nonce: u64,
    valid_until: u32,
) -> String {
    let vault = desk::types::parse_vault(vault).unwrap();
    let oracle = desk::types::parse_vault(ORACLE).unwrap();
    let state_hash = near_sdk::env::keccak256_array(doc.as_bytes());
    let data = evm::post_calldata(
        &vault,
        verdict,
        confidence_bps,
        risk_bps,
        &state_hash,
        valid_until as u64,
    );
    let (fee, prio) = (2 * GWEI, GWEI);
    let unsigned = evm::unsigned_1559(8453, nonce, prio, fee, BASE_GAS_LIMIT, &oracle, &data);
    let sig = sign_hash(&MOCK_SIGNER_KEY, &evm::payload_hash(&unsigned), 0);
    hex0x(&evm::assemble_signed(
        8453,
        nonce,
        prio,
        fee,
        BASE_GAS_LIMIT,
        &oracle,
        &data,
        &sig,
    ))
}

fn failure_text(r: ExecutionFinalResult) -> String {
    format!("{:?}", r.into_result().expect_err("call should fail"))
}

impl Env {
    /// A fresh doc for `order_id` on Base, `at` = the current block time.
    async fn reading(
        &self,
        order_id: u64,
        vault: &str,
        action: &str,
        confidence_bps: u16,
        risk_bps: u16,
    ) -> anyhow::Result<Reading> {
        let at = self.now_s().await?;
        let doc = format!(
            "rein-v1|order={order_id}|chain=base|vault={vault}|at={at}|block={at}|pps=1000000|assets=5000|liquidity=4000|apy_bps=812|apy_bps_prev=790|util_bps=8000|net_out_pct_1h=0|name=Steady USDC"
        );
        Ok(Reading::new(doc, action, confidence_bps, risk_bps))
    }

    async fn fulfil(
        &self,
        who: &Account,
        id: u64,
        r: &Reading,
        tx: Value,
    ) -> anyhow::Result<ExecutionFinalResult> {
        self.call(who, "fulfil", r.args(id, tx)).await
    }

    async fn confirm(
        &self,
        who: &Account,
        id: u64,
        r: &Reading,
        tx: Value,
    ) -> anyhow::Result<ExecutionFinalResult> {
        self.call(who, "confirm_exit", r.args(id, tx)).await
    }

    async fn status(&self, id: u64) -> anyhow::Result<OrderStatus> {
        Ok(self.order(id).await?.expect("order exists").status)
    }

    async fn valid_until(&self, id: u64) -> anyhow::Result<u32> {
        Ok(self
            .order(id)
            .await?
            .expect("order exists")
            .valid_until
            .expect("order has a reading"))
    }

    async fn signed_tx(&self, id: u64) -> anyhow::Result<Option<String>> {
        Ok(self
            .desk
            .view("get_signed_tx")
            .args_json(json!({ "order_id": id }))
            .await?
            .json()?)
    }

    async fn signer_calls(&self) -> anyhow::Result<u32> {
        Ok(self.signer.view("calls").await?.json()?)
    }

    async fn signer_mode(&self, mode: &str) -> anyhow::Result<()> {
        self.signer
            .call("set_mode")
            .args_json(json!({ "mode": mode }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// Opens a NEAR order on `vault` and signs a HOLD for it.
    async fn signed_hold(&self, vault: &str, nonce: u64) -> anyhow::Result<(u64, Reading)> {
        let id = id_of(self.order_near(&self.alice, vault, price_near()).await?)?;
        let r = self.reading(id, vault, "hold", 8100, 1200).await?;
        self.fulfil(&self.agent, id, &r, tx(nonce))
            .await?
            .into_result()?;
        assert_eq!(self.status(id).await?, OrderStatus::Signed);
        Ok((id, r))
    }

    /// Sets the mock token's balance for the desk (no transfer).
    async fn patch_desk_usdc(&self, amount: u128) -> anyhow::Result<()> {
        let key = [b"b".to_vec(), near_sdk::borsh::to_vec(self.desk.id())?].concat();
        self.worker
            .patch_state(self.ft.id(), &key, &near_sdk::borsh::to_vec(&amount)?)
            .await?;
        Ok(())
    }
}

#[tokio::test]
async fn fulfil_after_deadline_refused() -> anyhow::Result<()> {
    let e = setup_with(|p| p.deadline_s = 60).await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    e.advance(60).await?;
    let r = e.reading(id, V1, "hold", 8100, 1200).await?;
    let err = failure_text(e.fulfil(&e.agent, id, &r, tx(0)).await?);
    assert!(err.contains("order deadline passed"), "{err}");
    assert_eq!(e.status(id).await?, OrderStatus::Open);
    assert_eq!(e.signer_calls().await?, 0);
    e.call(&e.bob, "refund", json!({ "order_id": id }))
        .await?
        .into_result()?;
    assert_eq!(e.status(id).await?, OrderStatus::Refunded);
    Ok(())
}

#[tokio::test]
async fn confirm_exit_after_deadline_refused() -> anyhow::Result<()> {
    let e = setup_with(|p| p.deadline_s = 60).await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let first = e.reading(id, V1, "exit", 8100, 6400).await?;
    e.fulfil(&e.agent, id, &first, tx(0)).await?.into_result()?;
    e.advance(60).await?;
    let second = e.reading(id, V1, "exit", 9000, 7000).await?;
    let err = failure_text(e.confirm(&e.agent, id, &second, tx(0)).await?);
    assert!(err.contains("order deadline passed"), "{err}");
    assert_eq!(e.status(id).await?, OrderStatus::ExitPending);
    assert_eq!(e.signer_calls().await?, 0);
    e.call(&e.bob, "refund", json!({ "order_id": id }))
        .await?
        .into_result()?;
    assert_eq!(e.status(id).await?, OrderStatus::Refunded);
    Ok(())
}

#[tokio::test]
async fn hold_fulfil_signs_once() -> anyhow::Result<()> {
    let e = setup().await?;
    let (id, r) = e.signed_hold(V1, 0).await?;
    assert_eq!(
        e.signed_tx(id).await?,
        Some(expected_post(
            V1,
            0,
            8100,
            1200,
            &r.doc,
            0,
            e.valid_until(id).await?
        ))
    );
    assert_eq!(e.signer_calls().await?, 1);
    let s = e.stats().await?;
    assert_eq!((s.inference_tokens_in, s.inference_tokens_out), (812, 34));

    let again = e.reading(id, V1, "hold", 8100, 1200).await?;
    let err = failure_text(e.fulfil(&e.agent, id, &again, tx(1)).await?);
    assert!(err.contains("order is not open"), "{err}");
    assert_eq!(e.signer_calls().await?, 1);
    Ok(())
}

#[tokio::test]
async fn invalid_reading_leaves_order_open() -> anyhow::Result<()> {
    let e = setup().await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let mut r = e.reading(id, V1, "hold", 8100, 1200).await?;
    r.response = r.response.replace("8100", "8101");
    let err = failure_text(e.fulfil(&e.agent, id, &r, tx(0)).await?);
    assert!(err.contains("unknown signer"), "{err}");

    let other = e.reading(id, V2, "hold", 8100, 1200).await?;
    let err = failure_text(e.fulfil(&e.agent, id, &other, tx(0)).await?);
    assert!(err.contains("wrong vault"), "{err}");

    assert_eq!(e.status(id).await?, OrderStatus::Open);
    assert_eq!(e.signed_tx(id).await?, None);
    assert_eq!(e.signer_calls().await?, 0);
    Ok(())
}

#[tokio::test]
async fn fee_above_cap_refused() -> anyhow::Result<()> {
    let e = setup().await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let r = e.reading(id, V1, "hold", 8100, 1200).await?;
    // Base cap is 5 gwei.
    let err = failure_text(
        e.fulfil(&e.agent, id, &r, tx_fees(0, 5 * GWEI + 1, GWEI))
            .await?,
    );
    assert!(err.contains("fee above cap"), "{err}");
    let err = failure_text(
        e.fulfil(&e.agent, id, &r, tx_fees(0, GWEI, 2 * GWEI))
            .await?,
    );
    assert!(err.contains("priority fee above max fee"), "{err}");
    assert_eq!(e.status(id).await?, OrderStatus::Open);
    assert_eq!(e.signer_calls().await?, 0);

    e.fulfil(&e.agent, id, &r, tx_fees(0, 5 * GWEI, GWEI))
        .await?
        .into_result()?;
    assert_eq!(e.status(id).await?, OrderStatus::Signed);
    Ok(())
}

#[tokio::test]
async fn exit_pending_view_has_first_at() -> anyhow::Result<()> {
    let e = setup().await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let raw: Value = e
        .desk
        .view("get_order")
        .args_json(json!({ "order_id": id }))
        .await?
        .json()?;
    assert_eq!(raw.get("exit_pending_s"), Some(&Value::Null));
    let before = e.now_s().await?;
    let r = e.reading(id, V1, "exit", 8100, 6400).await?;
    e.fulfil(&e.agent, id, &r, tx(0)).await?.into_result()?;
    let raw: Value = e
        .desk
        .view("get_order")
        .args_json(json!({ "order_id": id }))
        .await?
        .json()?;
    let first_at = raw["exit_pending_s"].as_u64().expect("first reading time");
    assert!(first_at >= before && first_at <= e.now_s().await?);
    e.advance(30).await?;
    for (method, args) in [
        ("get_order", json!({ "order_id": id })),
        ("open_orders", json!({ "limit": 10 })),
        ("list_orders", json!({ "from": id, "limit": 1 })),
    ] {
        let raw: Value = e.desk.view(method).args_json(args).await?.json()?;
        let view = if raw.is_array() { &raw[0] } else { &raw };
        assert_eq!(view["exit_pending_s"], json!(first_at));
    }
    let r2 = e.reading(id, V1, "hold", 6000, 2000).await?;
    e.confirm(&e.agent, id, &r2, tx(0)).await?.into_result()?;
    let raw: Value = e
        .desk
        .view("get_order")
        .args_json(json!({ "order_id": id }))
        .await?
        .json()?;
    assert_eq!(raw.get("exit_pending_s"), Some(&Value::Null));
    let other = id_of(e.order_near(&e.alice, V2, price_near()).await?)?;
    let r = e.reading(other, V2, "exit", 8100, 6400).await?;
    e.fulfil(&e.agent, other, &r, tx(1)).await?.into_result()?;
    e.advance(301).await?;
    let raw: Value = e
        .desk
        .view("get_order")
        .args_json(json!({ "order_id": other }))
        .await?
        .json()?;
    assert_eq!(raw["status"], json!("open"));
    assert_eq!(raw.get("exit_pending_s"), Some(&Value::Null));
    Ok(())
}

#[tokio::test]
async fn exit_needs_two_readings() -> anyhow::Result<()> {
    let e = setup().await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let r = e.reading(id, V1, "exit", 8100, 6400).await?;
    e.fulfil(&e.agent, id, &r, tx(0)).await?.into_result()?;
    assert_eq!(e.status(id).await?, OrderStatus::ExitPending);
    assert_eq!(e.signed_tx(id).await?, None);
    assert_eq!(e.signer_calls().await?, 0);
    let raw: Value = e
        .desk
        .view("get_order")
        .args_json(json!({ "order_id": id }))
        .await?
        .json()?;
    assert_eq!(raw["status"], "exit_pending");
    Ok(())
}

#[tokio::test]
async fn confirm_before_30s_refused() -> anyhow::Result<()> {
    let e = setup().await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let r1 = e.reading(id, V1, "exit", 8100, 6400).await?;
    e.fulfil(&e.agent, id, &r1, tx(0)).await?.into_result()?;
    e.advance(10).await?;
    let r2 = e.reading(id, V1, "exit", 8200, 6500).await?;
    let err = failure_text(e.confirm(&e.agent, id, &r2, tx(0)).await?);
    assert!(err.contains("exit confirmed too early"), "{err}");
    assert_eq!(e.status(id).await?, OrderStatus::ExitPending);
    assert_eq!(e.signer_calls().await?, 0);
    Ok(())
}

#[tokio::test]
async fn confirm_after_300s_returns_to_open() -> anyhow::Result<()> {
    let e = setup().await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let r1 = e.reading(id, V1, "exit", 8100, 6400).await?;
    e.fulfil(&e.agent, id, &r1, tx(0)).await?.into_result()?;
    e.advance(301).await?;
    assert_eq!(e.status(id).await?, OrderStatus::Open);
    let r2 = e.reading(id, V1, "exit", 8200, 6500).await?;
    let err = failure_text(e.confirm(&e.agent, id, &r2, tx(0)).await?);
    assert!(err.contains("order is not exit_pending"), "{err}");
    assert_eq!(e.signer_calls().await?, 0);

    // Open again: a fresh reading starts over.
    let r3 = e.reading(id, V1, "hold", 7000, 1000).await?;
    e.fulfil(&e.agent, id, &r3, tx(0)).await?.into_result()?;
    assert_eq!(e.status(id).await?, OrderStatus::Signed);
    Ok(())
}

#[tokio::test]
async fn confirm_same_state_hash_refused() -> anyhow::Result<()> {
    let e = setup().await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let r1 = e.reading(id, V1, "exit", 8100, 6400).await?;
    e.fulfil(&e.agent, id, &r1, tx(0)).await?.into_result()?;
    e.advance(30).await?;
    let err = failure_text(e.confirm(&e.agent, id, &r1, tx(0)).await?);
    assert!(err.contains("same state_hash"), "{err}");
    assert_eq!(e.status(id).await?, OrderStatus::ExitPending);
    assert_eq!(e.signer_calls().await?, 0);
    Ok(())
}

#[tokio::test]
async fn confirm_exit_signs_exit() -> anyhow::Result<()> {
    let e = setup().await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let r1 = e.reading(id, V1, "exit", 8100, 6400).await?;
    e.fulfil(&e.agent, id, &r1, tx(0)).await?.into_result()?;
    e.advance(30).await?;
    let r2 = e.reading(id, V1, "exit", 9000, 7000).await?;
    e.confirm(&e.agent, id, &r2, tx(0)).await?.into_result()?;
    assert_eq!(e.status(id).await?, OrderStatus::Signed);
    assert_eq!(
        e.signed_tx(id).await?,
        Some(expected_post(
            V1,
            1,
            9000,
            7000,
            &r2.doc,
            0,
            e.valid_until(id).await?
        ))
    );
    assert_eq!(e.signer_calls().await?, 1);
    Ok(())
}

#[tokio::test]
async fn confirm_hold_signs_hold() -> anyhow::Result<()> {
    let e = setup().await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let r1 = e.reading(id, V1, "exit", 8100, 6400).await?;
    e.fulfil(&e.agent, id, &r1, tx(0)).await?.into_result()?;
    e.advance(30).await?;
    let r2 = e.reading(id, V1, "hold", 6000, 2000).await?;
    e.confirm(&e.agent, id, &r2, tx(0)).await?.into_result()?;
    assert_eq!(e.status(id).await?, OrderStatus::Signed);
    assert_eq!(
        e.signed_tx(id).await?,
        Some(expected_post(
            V1,
            0,
            6000,
            2000,
            &r2.doc,
            0,
            e.valid_until(id).await?
        ))
    );
    Ok(())
}

#[tokio::test]
async fn exit_pending_not_counted_against_caps() -> anyhow::Result<()> {
    let e = setup_with(|p| p.global_max = 1).await?;
    let a = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let b = id_of(e.order_near(&e.alice, V2, price_near()).await?)?;
    let r = e.reading(a, V1, "exit", 8100, 6400).await?;
    e.fulfil(&e.agent, a, &r, tx(0)).await?.into_result()?;
    assert_eq!(e.status(a).await?, OrderStatus::ExitPending);

    // The pending EXIT used none of the one-post global cap.
    let r = e.reading(b, V2, "hold", 8100, 1200).await?;
    e.fulfil(&e.agent, b, &r, tx(0)).await?.into_result()?;
    assert_eq!(e.status(b).await?, OrderStatus::Signed);

    // Now the cap is used: a new order and the EXIT's confirmation are refused.
    assert!(e.order_near(&e.bob, V3, price_near()).await?.is_failure());
    e.advance(30).await?;
    let r2 = e.reading(a, V1, "exit", 9000, 7000).await?;
    let err = failure_text(e.confirm(&e.agent, a, &r2, tx(1)).await?);
    assert!(err.contains("global cap"), "{err}");
    assert_eq!(e.status(a).await?, OrderStatus::ExitPending);
    Ok(())
}

#[tokio::test]
async fn signed_counts_against_spacing() -> anyhow::Result<()> {
    let e = setup().await?;
    let (id, _) = e.signed_hold(V1, 0).await?;
    e.call(
        &e.agent,
        "report_delivery",
        json!({ "order_id": id, "tx_hash": TX_HASH, "gas_wei": U128(0) }),
    )
    .await?
    .into_result()?;
    // V1 is free again, but its post was under 600 s ago.
    assert!(e.order_near(&e.alice, V1, price_near()).await?.is_failure());
    e.advance(600).await?;
    id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    Ok(())
}

#[tokio::test]
async fn resign_keeps_verdict_counts_once() -> anyhow::Result<()> {
    let e = setup_with(|p| p.global_max = 2).await?;
    let treasury_before = e.near_balance(&e.treasury).await?;
    let (id, r) = e.signed_hold(V1, 0).await?;
    let first = e.signed_tx(id).await?.unwrap();

    e.call(&e.agent, "resign", json!({ "order_id": id, "tx": tx(1) }))
        .await?
        .into_result()?;
    assert_eq!(e.status(id).await?, OrderStatus::Signed);
    let second = e.signed_tx(id).await?.unwrap();
    assert_ne!(first, second);
    assert_eq!(
        second,
        expected_post(V1, 0, 8100, 1200, &r.doc, 1, e.valid_until(id).await?)
    );
    assert_eq!(e.signer_calls().await?, 2);

    // Two posts fit the cap of 2 only if the re-sign was not counted.
    let (other_id, _) = e.signed_hold(V2, 0).await?;
    assert!(e.order_near(&e.bob, V3, price_near()).await?.is_failure());

    // Delivery, not signing or re-signing, pays the split once per order.
    for order_id in [id, other_id] {
        e.call(
            &e.agent,
            "report_delivery",
            json!({ "order_id": order_id, "tx_hash": TX_HASH, "gas_wei": U128(1) }),
        )
        .await?
        .into_result()?;
    }
    let to_treasury = price_near().as_yoctonear() * 7 / 10;
    assert_eq!(e.stats().await?.paid_treasury.near, U128(2 * to_treasury));
    assert_eq!(
        e.near_balance(&e.treasury).await?,
        treasury_before.saturating_add(NearToken::from_yoctonear(2 * to_treasury))
    );
    Ok(())
}

#[tokio::test]
async fn resign_keeps_valid_until() -> anyhow::Result<()> {
    let e = setup().await?;
    let (id, r) = e.signed_hold(V1, 0).await?;
    let valid_until = e.valid_until(id).await?;
    e.advance(5).await?;
    e.call(&e.agent, "resign", json!({ "order_id": id, "tx": tx(1) }))
        .await?
        .into_result()?;
    assert_eq!(e.valid_until(id).await?, valid_until);
    assert_eq!(
        e.signed_tx(id).await?,
        Some(expected_post(V1, 0, 8100, 1200, &r.doc, 1, valid_until))
    );
    Ok(())
}

#[tokio::test]
async fn resign_refused_under_kill() -> anyhow::Result<()> {
    let e = setup().await?;
    let (id, _) = e.signed_hold(V1, 0).await?;
    e.call(&e.owner, "kill_switch", json!({ "on": true }))
        .await?
        .into_result()?;
    let err = failure_text(
        e.call(&e.agent, "resign", json!({ "order_id": id, "tx": tx(1) }))
            .await?,
    );
    assert!(err.contains("kill switch on"), "{err}");
    assert_eq!(e.signer_calls().await?, 1);
    Ok(())
}

#[tokio::test]
async fn resign_refused_after_valid_until() -> anyhow::Result<()> {
    let e = setup().await?;
    let (id, _) = e.signed_hold(V1, 0).await?;
    let valid_until = e.valid_until(id).await?;
    let wait = valid_until as u64 + 1 - e.now_s().await?;
    e.advance(wait).await?;
    let err = failure_text(
        e.call(&e.agent, "resign", json!({ "order_id": id, "tx": tx(1) }))
            .await?,
    );
    assert!(err.contains("post expired"), "{err}");
    assert_eq!(e.signer_calls().await?, 1);
    Ok(())
}

async fn signing_with_policy_change(oracle: Option<&str>) -> anyhow::Result<()> {
    let e = setup().await?;
    e.signer_mode("hold").await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let r = e.reading(id, V1, "hold", 8100, 1200).await?;
    let pending = e
        .agent
        .call(e.desk.id(), "fulfil")
        .args_json(r.args(id, tx(0)))
        .max_gas()
        .transact_async()
        .await?;
    for _ in 0..100 {
        if e.status(id).await? == OrderStatus::Signing {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(e.status(id).await?, OrderStatus::Signing);
    let valid_until = e.valid_until(id).await?;
    let mut policy: Policy = e.desk.view("policy").await?.json()?;
    policy.oracle.base = oracle.map(String::from);
    policy.gas_limit.base = 2 * BASE_GAS_LIMIT;
    e.call(&e.owner, "set_policy", json!({ "policy": policy }))
        .await?
        .into_result()?;
    e.signer.call("release").transact().await?.into_result()?;
    let outcome = pending.await?;
    assert_eq!(e.status(id).await?, OrderStatus::Signed, "{outcome:?}");
    outcome.into_result()?;
    assert_eq!(
        e.signed_tx(id).await?,
        Some(expected_post(V1, 0, 8100, 1200, &r.doc, 0, valid_until))
    );
    e.signer_mode("ok").await?;
    e.call(&e.agent, "resign", json!({ "order_id": id, "tx": tx(1) }))
        .await?
        .into_result()?;
    assert_eq!(
        e.signed_tx(id).await?,
        Some(expected_post(V1, 0, 8100, 1200, &r.doc, 1, valid_until))
    );
    assert_eq!(e.stats().await?.open_paid, 1);
    Ok(())
}

#[tokio::test]
async fn oracle_changed_during_signing_completes() -> anyhow::Result<()> {
    signing_with_policy_change(Some("0x00000000000000000000000000000000000000a2")).await
}

#[tokio::test]
async fn oracle_cleared_during_signing_not_stuck() -> anyhow::Result<()> {
    signing_with_policy_change(None).await
}

#[tokio::test]
async fn refund_refused_while_signing() -> anyhow::Result<()> {
    let e = setup().await?;
    e.signer_mode("hold").await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let r = e.reading(id, V1, "hold", 8100, 1200).await?;
    let pending = e
        .agent
        .call(e.desk.id(), "fulfil")
        .args_json(r.args(id, tx(0)))
        .max_gas()
        .transact_async()
        .await?;
    for _ in 0..100 {
        if e.status(id).await? == OrderStatus::Signing {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(e.status(id).await?, OrderStatus::Signing);

    e.call(&e.owner, "kill_switch", json!({ "on": true }))
        .await?
        .into_result()?;
    let err = failure_text(e.call(&e.bob, "refund", json!({ "order_id": id })).await?);
    assert!(err.contains("order is not refundable"), "{err}");
    let err = failure_text(
        e.call(&e.agent, "reject", json!({ "order_id": id, "reason": "x" }))
            .await?,
    );
    assert!(err.contains("order is not refundable"), "{err}");
    let err = failure_text(
        e.call(
            &e.agent,
            "fail_post",
            json!({ "order_id": id, "tx_hash": null, "gas_wei": U128(1), "reason": "no" }),
        )
        .await?,
    );
    assert!(err.contains("order is not signed"), "{err}");
    e.call(&e.owner, "kill_switch", json!({ "on": false }))
        .await?
        .into_result()?;
    let err = failure_text(e.fulfil(&e.agent, id, &r, tx(1)).await?);
    assert!(err.contains("order is not open"), "{err}");
    let err = failure_text(
        e.call(&e.agent, "resign", json!({ "order_id": id, "tx": tx(1) }))
            .await?,
    );
    assert!(err.contains("order is not signed"), "{err}");
    assert_eq!(e.status(id).await?, OrderStatus::Signing);

    e.signer.call("release").transact().await?.into_result()?;
    pending.await?.into_result()?;
    assert_eq!(e.status(id).await?, OrderStatus::Signed);
    assert_eq!(e.stats().await?.refunds, 0);
    Ok(())
}

#[tokio::test]
async fn sign_failure_restores_state() -> anyhow::Result<()> {
    let e = setup().await?;
    let treasury_before = e.near_balance(&e.treasury).await?;
    e.signer_mode("fail").await?;

    // HOLD: back to open, no post counted, nothing paid.
    let a = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let r = e.reading(a, V1, "hold", 8100, 1200).await?;
    let res = e.fulfil(&e.agent, a, &r, tx(0)).await?;
    assert!(res.logs().iter().any(|l| l.contains("signing failed")));
    assert_eq!(e.status(a).await?, OrderStatus::Open);
    assert_eq!(e.signed_tx(a).await?, None);

    // EXIT confirmation: back to exit_pending with the first reading.
    let b = id_of(e.order_near(&e.alice, V2, price_near()).await?)?;
    let r1 = e.reading(b, V2, "exit", 8100, 6400).await?;
    e.fulfil(&e.agent, b, &r1, tx(1)).await?.into_result()?;
    e.advance(30).await?;
    let r2 = e.reading(b, V2, "exit", 9000, 7000).await?;
    e.confirm(&e.agent, b, &r2, tx(1)).await?.into_result()?;
    assert_eq!(e.status(b).await?, OrderStatus::ExitPending);
    assert_eq!(e.stats().await?.paid_treasury.near, U128(0));
    assert_eq!(e.near_balance(&e.treasury).await?, treasury_before);

    // Both go through once the signer works, inside V1's 600 s spacing.
    e.signer_mode("ok").await?;
    let r = e.reading(a, V1, "hold", 8100, 1200).await?;
    e.fulfil(&e.agent, a, &r, tx(0)).await?.into_result()?;
    assert_eq!(e.status(a).await?, OrderStatus::Signed);
    // r1 is still the stored first reading: a confirmation on its state is refused.
    let err = failure_text(e.confirm(&e.agent, b, &r1, tx(1)).await?);
    assert!(err.contains("same state_hash"), "{err}");
    e.confirm(&e.agent, b, &r2, tx(1)).await?.into_result()?;
    assert_eq!(e.status(b).await?, OrderStatus::Signed);
    assert_eq!(
        e.signed_tx(b).await?,
        Some(expected_post(
            V2,
            1,
            9000,
            7000,
            &r2.doc,
            1,
            e.valid_until(b).await?
        ))
    );
    Ok(())
}

#[tokio::test]
async fn delivery_retry_counts_gas_once() -> anyhow::Result<()> {
    let e = setup().await?;
    let (id, _) = e.signed_hold(V1, 0).await?;
    let args = json!({ "order_id": id, "tx_hash": TX_HASH, "gas_wei": U128(123_456) });
    e.call(&e.agent, "report_delivery", args.clone())
        .await?
        .into_result()?;
    assert_eq!(e.stats().await?.gas_wei.base, U128(123_456));
    let err = failure_text(e.call(&e.agent, "report_delivery", args).await?);
    assert!(err.contains("order is not signed"), "{err}");
    let s = e.stats().await?;
    assert_eq!(s.gas_wei.base, U128(123_456));
    assert_eq!(
        s.paid_treasury.near,
        U128(price_near().as_yoctonear() * 7 / 10)
    );
    Ok(())
}

#[tokio::test]
async fn fail_post_refunds_in_full() -> anyhow::Result<()> {
    let e = setup_with(|p| p.spacing_s = 0).await?;
    let (near_id, _) = e.signed_hold(V1, 0).await?;
    e.order_usdc(&e.alice, PRICE_USDC, &usdc_msg(V2))
        .await?
        .into_result()?;
    let usdc_id = near_id + 1;
    let r = e.reading(usdc_id, V2, "hold", 8100, 1200).await?;
    e.fulfil(&e.agent, usdc_id, &r, tx(1))
        .await?
        .into_result()?;
    let before = e.near_balance(&e.alice).await?;
    for (id, hash) in [(near_id, Some(TX_HASH)), (usdc_id, None)] {
        let args = json!({ "order_id": id, "tx_hash": hash, "gas_wei": U128(100), "reason": "post reverted" });
        e.call(&e.agent, "fail_post", args.clone())
            .await?
            .into_result()?;
        let view = e.order(id).await?.unwrap();
        assert_eq!(
            near_sdk::serde_json::to_value(view.status)?,
            json!("post_failed")
        );
        assert!(view.status.is_finished());
        assert_eq!(e.signed_tx(id).await?, None);
        let err = failure_text(e.call(&e.agent, "fail_post", args).await?);
        assert!(err.contains("order is not signed"), "{err}");
        let err = failure_text(
            e.call(
                &e.agent,
                "report_delivery",
                json!({ "order_id": id, "tx_hash": TX_HASH, "gas_wei": U128(100) }),
            )
            .await?,
        );
        assert!(err.contains("order is not signed"), "{err}");
    }
    assert_eq!(
        e.near_balance(&e.alice).await?,
        before.saturating_add(price_near())
    );
    assert_eq!(e.usdc_balance(e.alice.id()).await?, 10 * PRICE_USDC);
    let s = e.stats().await?;
    assert_eq!((s.open_paid, s.refunds), (0, 2));
    assert_eq!(s.gas_wei.base, U128(200));
    assert_eq!(s.paid_treasury, Default::default());
    assert_eq!(s.paid_agent, Default::default());
    id_of(e.order_near(&e.bob, V1, price_near()).await?)?;
    id_of(e.order_near(&e.bob, V2, price_near()).await?)?;
    Ok(())
}

#[tokio::test]
async fn fail_post_only_agent() -> anyhow::Result<()> {
    let e = setup().await?;
    let (id, _) = e.signed_hold(V1, 0).await?;
    for who in [&e.alice, &e.owner, &e.treasury] {
        let err = failure_text(
            e.call(
                who,
                "fail_post",
                json!({ "order_id": id, "tx_hash": null, "gas_wei": U128(1), "reason": "expired" }),
            )
            .await?,
        );
        assert!(err.contains("agent only"), "{err}");
    }
    assert_eq!(e.status(id).await?, OrderStatus::Signed);
    assert_eq!(e.stats().await?.gas_wei.base, U128(0));
    Ok(())
}

#[tokio::test]
async fn fail_post_only_from_signed() -> anyhow::Result<()> {
    let e = setup().await?;
    let open = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let pending = id_of(e.order_near(&e.alice, V2, price_near()).await?)?;
    let r = e.reading(pending, V2, "exit", 8100, 6400).await?;
    e.fulfil(&e.agent, pending, &r, tx(0))
        .await?
        .into_result()?;
    let rejected = id_of(e.order_near(&e.alice, V3, price_near()).await?)?;
    e.call(
        &e.agent,
        "reject",
        json!({ "order_id": rejected, "reason": "no" }),
    )
    .await?
    .into_result()?;
    let refunded = id_of(e.order_near(&e.alice, V4, price_near()).await?)?;
    let (delivered, _) = e.signed_hold(V5, 0).await?;
    e.call(
        &e.agent,
        "report_delivery",
        json!({ "order_id": delivered, "tx_hash": TX_HASH, "gas_wei": U128(10) }),
    )
    .await?
    .into_result()?;
    e.call(&e.owner, "kill_switch", json!({ "on": true }))
        .await?
        .into_result()?;
    e.call(&e.bob, "refund", json!({ "order_id": refunded }))
        .await?
        .into_result()?;
    for id in [open, pending, rejected, refunded, delivered] {
        let status = e.status(id).await?;
        let err = failure_text(
            e.call(
                &e.agent,
                "fail_post",
                json!({ "order_id": id, "tx_hash": null, "gas_wei": U128(1), "reason": "no" }),
            )
            .await?,
        );
        assert!(err.contains("order is not signed"), "{status:?}: {err}");
        assert_eq!(e.status(id).await?, status);
    }
    assert_eq!(e.stats().await?.gas_wei.base, U128(10));
    Ok(())
}

#[tokio::test]
async fn no_split_until_delivered() -> anyhow::Result<()> {
    let e = setup().await?;
    let treasury = e.near_balance(&e.treasury).await?;
    let (id, _) = e.signed_hold(V1, 0).await?;
    assert_eq!(e.near_balance(&e.treasury).await?, treasury);
    assert_eq!(e.stats().await?.paid_treasury, Default::default());
    e.call(&e.agent, "resign", json!({ "order_id": id, "tx": tx(1) }))
        .await?
        .into_result()?;
    assert_eq!(e.stats().await?.paid_agent, Default::default());
    e.call(
        &e.agent,
        "report_delivery",
        json!({ "order_id": id, "tx_hash": TX_HASH, "gas_wei": U128(1) }),
    )
    .await?
    .into_result()?;
    assert_eq!(
        e.stats().await?.paid_treasury.near,
        U128(price_near().as_yoctonear() * 7 / 10)
    );
    Ok(())
}

#[tokio::test]
async fn refund_of_signed_refused_before_expiry() -> anyhow::Result<()> {
    let e = setup_with(|p| p.deadline_s = 120).await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    e.advance(60).await?;
    let r = e.reading(id, V1, "hold", 8100, 1200).await?;
    e.fulfil(&e.agent, id, &r, tx(0)).await?.into_result()?;
    e.advance(60).await?;
    assert!(e.now_s().await? < e.valid_until(id).await? as u64);
    let err = failure_text(e.call(&e.bob, "refund", json!({ "order_id": id })).await?);
    assert!(err.contains("refund before post expiry and grace"), "{err}");
    assert_eq!(e.status(id).await?, OrderStatus::Signed);
    Ok(())
}

#[tokio::test]
async fn refund_of_signed_after_expiry_and_grace() -> anyhow::Result<()> {
    let e = setup_with(|p| {
        p.deadline_s = 120;
        p.spacing_s = 0;
    })
    .await?;
    let (id, _) = e.signed_hold(V1, 0).await?;
    e.advance(121).await?;
    let err = failure_text(e.call(&e.bob, "refund", json!({ "order_id": id })).await?);
    assert!(err.contains("refund before post expiry and grace"), "{err}");
    e.advance(120).await?;
    let before = e.near_balance(&e.alice).await?;
    e.call(&e.bob, "refund", json!({ "order_id": id }))
        .await?
        .into_result()?;
    assert_eq!(e.status(id).await?, OrderStatus::Refunded);
    assert_eq!(e.signed_tx(id).await?, None);
    assert_eq!(
        e.near_balance(&e.alice).await?,
        before.saturating_add(price_near())
    );
    assert_eq!(
        (e.stats().await?.open_paid, e.stats().await?.refunds),
        (0, 1)
    );
    assert_eq!(e.stats().await?.paid_treasury, Default::default());
    id_of(e.order_near(&e.bob, V1, price_near()).await?)?;
    Ok(())
}

#[tokio::test]
async fn kill_switch_does_not_shorten_signed_refund() -> anyhow::Result<()> {
    let e = setup_with(|p| p.deadline_s = 120).await?;
    let (id, _) = e.signed_hold(V1, 0).await?;
    e.call(&e.owner, "kill_switch", json!({ "on": true }))
        .await?
        .into_result()?;
    for wait in [0, 121] {
        if wait != 0 {
            e.advance(wait).await?;
        }
        let err = failure_text(e.call(&e.bob, "refund", json!({ "order_id": id })).await?);
        assert!(err.contains("refund before post expiry and grace"), "{err}");
        assert_eq!(e.status(id).await?, OrderStatus::Signed);
    }
    e.advance(120).await?;
    e.call(&e.bob, "refund", json!({ "order_id": id }))
        .await?
        .into_result()?;
    assert_eq!(e.status(id).await?, OrderStatus::Refunded);
    Ok(())
}

#[tokio::test]
async fn refund_after_delivery_refused() -> anyhow::Result<()> {
    let e = setup_with(|p| p.deadline_s = 60).await?;
    let (id, _) = e.signed_hold(V1, 0).await?;
    e.call(
        &e.agent,
        "report_delivery",
        json!({ "order_id": id, "tx_hash": TX_HASH, "gas_wei": U128(10) }),
    )
    .await?
    .into_result()?;
    e.advance(121).await?;
    e.call(&e.owner, "kill_switch", json!({ "on": true }))
        .await?
        .into_result()?;
    let before = e.near_balance(&e.alice).await?;
    let err = failure_text(e.call(&e.bob, "refund", json!({ "order_id": id })).await?);
    assert!(err.contains("order is not refundable"), "{err}");
    assert_eq!(e.near_balance(&e.alice).await?, before);
    assert_eq!(e.status(id).await?, OrderStatus::Delivered);
    assert_eq!(e.stats().await?.refunds, 0);
    Ok(())
}

#[tokio::test]
async fn report_delivery_marks_delivered_and_frees_tx() -> anyhow::Result<()> {
    let e = setup().await?;
    let (id, _) = e.signed_hold(V1, 0).await?;
    assert_eq!(e.stats().await?.open_paid, 1);
    let err = failure_text(
        e.call(
            &e.agent,
            "report_delivery",
            json!({ "order_id": id, "tx_hash": "0x12", "gas_wei": U128(0) }),
        )
        .await?,
    );
    assert!(err.contains("bad tx_hash"), "{err}");

    e.call(
        &e.agent,
        "report_delivery",
        json!({ "order_id": id, "tx_hash": TX_HASH, "gas_wei": U128(0) }),
    )
    .await?
    .into_result()?;
    assert_eq!(e.status(id).await?, OrderStatus::Delivered);
    assert_eq!(e.signed_tx(id).await?, None);
    assert_eq!(e.stats().await?.open_paid, 0);
    let open: Vec<OrderView> = e
        .desk
        .view("open_orders")
        .args_json(json!({ "limit": 10 }))
        .await?
        .json()?;
    assert!(open.is_empty());
    assert!(e
        .call(
            &e.agent,
            "report_delivery",
            json!({ "order_id": id, "tx_hash": TX_HASH, "gas_wei": U128(0) })
        )
        .await?
        .is_failure());
    assert!(e
        .call(&e.agent, "resign", json!({ "order_id": id, "tx": tx(1) }))
        .await?
        .is_failure());
    Ok(())
}

#[tokio::test]
async fn split_70_30_on_delivered_near() -> anyhow::Result<()> {
    let e = setup().await?;
    let treasury_before = e.near_balance(&e.treasury).await?;
    let agent_before = e.near_balance(&e.agent).await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let reading = e.reading(id, V1, "hold", 8100, 1200).await?;
    let fulfilled = e
        .fulfil(&e.agent, id, &reading, tx(0))
        .await?
        .into_result()?;
    assert_eq!(e.near_balance(&e.treasury).await?, treasury_before);
    let delivered = e
        .call(
            &e.agent,
            "report_delivery",
            json!({ "order_id": id, "tx_hash": TX_HASH, "gas_wei": U128(1) }),
        )
        .await?
        .into_result()?;
    // Detached transfers and prepaid-gas refunds can finish after the call's return.
    e.worker.fast_forward(5).await?;

    let price = price_near().as_yoctonear();
    let (to_treasury, to_agent) = (price * 7 / 10, price * 3 / 10);
    assert_eq!(
        e.near_balance(&e.treasury).await?,
        treasury_before.saturating_add(NearToken::from_yoctonear(to_treasury))
    );
    let gas_spent: u128 = fulfilled
        .outcomes()
        .into_iter()
        .chain(delivered.outcomes())
        .map(|outcome| outcome.tokens_burnt.as_yoctonear())
        .sum();
    assert_eq!(
        e.near_balance(&e.agent).await?.as_yoctonear(),
        agent_before.as_yoctonear() + to_agent - gas_spent
    );
    let s = e.stats().await?;
    assert_eq!(s.paid_treasury.near, U128(to_treasury));
    assert_eq!(s.paid_agent.near, U128(to_agent));
    assert_eq!(s.paid_treasury.usdc, U128(0));
    Ok(())
}

#[tokio::test]
async fn split_70_30_on_delivered_usdc() -> anyhow::Result<()> {
    let e = setup().await?;
    e.order_usdc(&e.alice, PRICE_USDC, &usdc_msg(V1))
        .await?
        .into_result()?;
    let r = e.reading(0, V1, "rotate", 7000, 3000).await?;
    e.fulfil(&e.agent, 0, &r, tx(0)).await?.into_result()?;
    assert_eq!(e.status(0).await?, OrderStatus::Signed);
    assert_eq!(
        e.signed_tx(0).await?,
        Some(expected_post(
            V1,
            2,
            7000,
            3000,
            &r.doc,
            0,
            e.valid_until(0).await?
        ))
    );
    assert_eq!(e.usdc_balance(e.desk.id()).await?, PRICE_USDC);
    assert_eq!(e.usdc_balance(e.treasury.id()).await?, 0);
    e.call(
        &e.agent,
        "report_delivery",
        json!({ "order_id": 0, "tx_hash": TX_HASH, "gas_wei": U128(1) }),
    )
    .await?
    .into_result()?;
    assert_eq!(e.usdc_balance(e.treasury.id()).await?, 700_000);
    assert_eq!(e.usdc_balance(e.agent.id()).await?, 300_000);
    assert_eq!(e.usdc_balance(e.desk.id()).await?, 0);
    let s = e.stats().await?;
    assert_eq!(s.paid_treasury.usdc, U128(700_000));
    assert_eq!(s.paid_agent.usdc, U128(300_000));
    assert_eq!(s.owed, U128(0));
    Ok(())
}

#[tokio::test]
async fn report_delivery_usdc_fits_worker_gas() -> anyhow::Result<()> {
    let e = setup().await?;
    e.order_usdc(&e.alice, PRICE_USDC, &usdc_msg(V1))
        .await?
        .into_result()?;
    let id = 0;
    let reading = e.reading(id, V1, "hold", 8100, 1200).await?;
    e.fulfil(&e.agent, id, &reading, tx(0))
        .await?
        .into_result()?;
    assert_eq!(e.status(id).await?, OrderStatus::Signed);

    // Match SETTLEMENT_GAS in worker/src/near.ts, rather than the helpers' max_gas().
    let worker_gas = near_workspaces::types::Gas::from_tgas(100);
    e.agent
        .call(e.desk.id(), "report_delivery")
        .args_json(json!({ "order_id": id, "tx_hash": TX_HASH, "gas_wei": U128(1) }))
        .gas(worker_gas)
        .transact()
        .await?
        .into_result()?;
    e.worker.fast_forward(5).await?;

    assert_eq!(e.status(id).await?, OrderStatus::Delivered);
    assert_eq!(e.usdc_balance(e.treasury.id()).await?, PRICE_USDC * 7 / 10);
    assert_eq!(e.usdc_balance(e.agent.id()).await?, PRICE_USDC * 3 / 10);
    assert_eq!(e.usdc_balance(e.desk.id()).await?, 0);
    assert_eq!(e.stats().await?.owed, U128(0));
    Ok(())
}

#[tokio::test]
async fn refund_ft_failure_keeps_owed() -> anyhow::Result<()> {
    let e = setup().await?;
    e.order_usdc(&e.alice, PRICE_USDC, &usdc_msg(V1))
        .await?
        .into_result()?;
    e.patch_desk_usdc(0).await?;
    e.call(&e.owner, "kill_switch", json!({ "on": true }))
        .await?
        .into_result()?;
    e.call(&e.bob, "refund", json!({ "order_id": 0 }))
        .await?
        .into_result()?;
    assert_eq!(e.status(0).await?, OrderStatus::Refunded);
    assert_eq!(
        (e.stats().await?.open_paid, e.stats().await?.refunds),
        (0, 1)
    );
    assert_eq!(e.stats().await?.owed, U128(PRICE_USDC));
    assert_eq!(e.usdc_balance(e.alice.id()).await?, 9 * PRICE_USDC);
    e.call(&e.bob, "claim_owed", json!({ "account": e.alice.id() }))
        .await?
        .into_result()?;
    assert_eq!(e.stats().await?.owed, U128(PRICE_USDC));
    e.patch_desk_usdc(PRICE_USDC).await?;
    e.call(&e.bob, "claim_owed", json!({ "account": e.alice.id() }))
        .await?
        .into_result()?;
    assert_eq!(e.stats().await?.owed, U128(0));
    assert_eq!(e.usdc_balance(e.alice.id()).await?, 10 * PRICE_USDC);
    Ok(())
}

#[tokio::test]
async fn refund_near_failure_keeps_owed() -> anyhow::Result<()> {
    let e = setup().await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    e.order_usdc(&e.alice, PRICE_USDC, &usdc_msg(V2))
        .await?
        .into_result()?;
    e.patch_desk_usdc(0).await?;
    e.alice
        .clone()
        .delete_account(e.bob.id())
        .await?
        .into_result()?;
    e.call(
        &e.agent,
        "reject",
        json!({ "order_id": id, "reason": "no" }),
    )
    .await?
    .into_result()?;
    let s: Value = e.desk.view("stats").await?.json()?;
    assert_eq!(
        s["owed_near"],
        json!(price_near().as_yoctonear().to_string())
    );
    e.call(
        &e.agent,
        "reject",
        json!({ "order_id": id + 1, "reason": "no" }),
    )
    .await?
    .into_result()?;
    assert_eq!(e.stats().await?.owed, U128(PRICE_USDC));
    e.call(&e.bob, "claim_owed", json!({ "account": e.alice.id() }))
        .await?
        .into_result()?;
    let s: Value = e.desk.view("stats").await?.json()?;
    assert_eq!(
        s["owed_near"],
        json!(price_near().as_yoctonear().to_string())
    );
    assert_eq!(e.stats().await?.owed, U128(PRICE_USDC));
    let alice = e
        .worker
        .root_account()?
        .create_subaccount("alice")
        .initial_balance(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    e.patch_desk_usdc(PRICE_USDC).await?;
    let before = e.near_balance(&alice).await?;
    e.call(&e.bob, "claim_owed", json!({ "account": alice.id() }))
        .await?
        .into_result()?;
    assert_eq!(
        e.near_balance(&alice).await?,
        before.saturating_add(price_near())
    );
    assert_eq!(e.usdc_balance(alice.id()).await?, 10 * PRICE_USDC);
    let s: Value = e.desk.view("stats").await?.json()?;
    assert_eq!(s["owed_near"], json!("0"));
    assert_eq!(e.stats().await?.owed, U128(0));
    let err = failure_text(
        e.call(&e.bob, "claim_owed", json!({ "account": alice.id() }))
            .await?,
    );
    assert!(err.contains("nothing owed"), "{err}");
    Ok(())
}

#[tokio::test]
async fn split_near_failure_keeps_owed() -> anyhow::Result<()> {
    let e = setup().await?;
    let (id, _) = e.signed_hold(V1, 0).await?;
    e.treasury
        .clone()
        .delete_account(e.bob.id())
        .await?
        .into_result()?;
    e.call(
        &e.agent,
        "report_delivery",
        json!({ "order_id": id, "tx_hash": TX_HASH, "gas_wei": U128(1) }),
    )
    .await?
    .into_result()?;
    let to_treasury = price_near().as_yoctonear() * 7 / 10;
    let s: Value = e.desk.view("stats").await?.json()?;
    assert_eq!(s["owed_near"], json!(to_treasury.to_string()));
    assert_eq!(
        e.stats().await?.paid_agent.near,
        U128(price_near().as_yoctonear() * 3 / 10)
    );
    assert_eq!(e.stats().await?.owed, U128(0));
    let treasury = e
        .worker
        .root_account()?
        .create_subaccount("treasury")
        .initial_balance(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    let before = e.near_balance(&treasury).await?;
    e.call(&e.bob, "claim_owed", json!({ "account": treasury.id() }))
        .await?
        .into_result()?;
    assert_eq!(
        e.near_balance(&treasury).await?,
        before.saturating_add(NearToken::from_yoctonear(to_treasury))
    );
    let s: Value = e.desk.view("stats").await?.json()?;
    assert_eq!(s["owed_near"], json!("0"));
    Ok(())
}

#[tokio::test]
async fn usdc_token_locked_while_owed() -> anyhow::Result<()> {
    let e = setup().await?;
    e.order_usdc(&e.alice, PRICE_USDC, &usdc_msg(V1))
        .await?
        .into_result()?;
    let mut policy: Policy = e.desk.view("policy").await?.json()?;
    policy.usdc_token = None;
    let err = failure_text(
        e.call(&e.owner, "set_policy", json!({ "policy": policy }))
            .await?,
    );
    assert!(err.contains("usdc_token is locked"), "{err}");
    e.patch_desk_usdc(0).await?;
    e.call(&e.agent, "reject", json!({ "order_id": 0, "reason": "no" }))
        .await?
        .into_result()?;
    assert_eq!(e.stats().await?.open_paid, 0);
    let err = failure_text(
        e.call(&e.owner, "set_policy", json!({ "policy": policy }))
            .await?,
    );
    assert!(err.contains("usdc_token is locked"), "{err}");
    assert_eq!(e.stats().await?.owed, U128(PRICE_USDC));
    e.patch_desk_usdc(PRICE_USDC).await?;
    e.call(&e.bob, "claim_owed", json!({ "account": e.alice.id() }))
        .await?
        .into_result()?;
    e.call(&e.owner, "set_policy", json!({ "policy": policy }))
        .await?
        .into_result()?;
    let actual: Policy = e.desk.view("policy").await?.json()?;
    assert_eq!(actual.usdc_token, None);
    Ok(())
}

#[tokio::test]
async fn split_ft_failure_keeps_owed() -> anyhow::Result<()> {
    let e = setup().await?;
    e.order_usdc(&e.alice, PRICE_USDC, &usdc_msg(V1))
        .await?
        .into_result()?;
    // The token refuses the desk's transfers: it holds nothing.
    e.patch_desk_usdc(0).await?;
    let r = e.reading(0, V1, "hold", 8100, 1200).await?;
    e.fulfil(&e.agent, 0, &r, tx(0)).await?.into_result()?;
    assert_eq!(e.status(0).await?, OrderStatus::Signed);
    e.call(
        &e.agent,
        "report_delivery",
        json!({ "order_id": 0, "tx_hash": TX_HASH, "gas_wei": U128(1) }),
    )
    .await?
    .into_result()?;
    assert_eq!(e.usdc_balance(e.treasury.id()).await?, 0);
    assert_eq!(e.usdc_balance(e.agent.id()).await?, 0);
    let s = e.stats().await?;
    assert_eq!(s.owed, U128(PRICE_USDC));
    assert_eq!(s.paid_treasury.usdc, U128(700_000));

    // A claim that fails again stays owed.
    e.call(&e.bob, "claim_owed", json!({ "account": e.treasury.id() }))
        .await?
        .into_result()?;
    assert_eq!(e.stats().await?.owed, U128(PRICE_USDC));
    assert_eq!(e.usdc_balance(e.treasury.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn claim_owed_pays() -> anyhow::Result<()> {
    let e = setup().await?;
    e.order_usdc(&e.alice, PRICE_USDC, &usdc_msg(V1))
        .await?
        .into_result()?;
    e.patch_desk_usdc(0).await?;
    let r = e.reading(0, V1, "hold", 8100, 1200).await?;
    e.fulfil(&e.agent, 0, &r, tx(0)).await?.into_result()?;
    e.call(
        &e.agent,
        "report_delivery",
        json!({ "order_id": 0, "tx_hash": TX_HASH, "gas_wei": U128(1) }),
    )
    .await?
    .into_result()?;
    assert_eq!(e.stats().await?.owed, U128(PRICE_USDC));
    e.patch_desk_usdc(PRICE_USDC).await?;

    e.call(&e.bob, "claim_owed", json!({ "account": e.treasury.id() }))
        .await?
        .into_result()?;
    assert_eq!(e.usdc_balance(e.treasury.id()).await?, 700_000);
    assert_eq!(e.stats().await?.owed, U128(300_000));
    e.call(&e.bob, "claim_owed", json!({ "account": e.agent.id() }))
        .await?
        .into_result()?;
    assert_eq!(e.usdc_balance(e.agent.id()).await?, 300_000);
    assert_eq!(e.stats().await?.owed, U128(0));
    let err = failure_text(
        e.call(&e.bob, "claim_owed", json!({ "account": e.agent.id() }))
            .await?,
    );
    assert!(err.contains("nothing owed"), "{err}");
    assert_eq!(e.usdc_balance(e.agent.id()).await?, 300_000);
    Ok(())
}

#[tokio::test]
async fn watch_and_x402_orders_no_split() -> anyhow::Result<()> {
    let e = setup().await?;
    let treasury_before = e.near_balance(&e.treasury).await?;
    let w: u64 = e
        .call(
            &e.agent,
            "submit_watch_request",
            json!({ "chain": "base", "vault": V1 }),
        )
        .await?
        .into_result()?
        .json()?;
    let x: u64 = e
        .call(
            &e.agent,
            "submit_x402_request",
            json!({ "chain": "base", "vault": V2, "payment_ref": "pp-1", "amount": U128(PRICE_USDC) }),
        )
        .await?
        .into_result()?
        .json()?;
    for (id, vault) in [(w, V1), (x, V2)] {
        let r = e.reading(id, vault, "hold", 8100, 1200).await?;
        e.fulfil(&e.agent, id, &r, tx(id)).await?.into_result()?;
        assert_eq!(e.status(id).await?, OrderStatus::Signed);
        e.call(
            &e.agent,
            "report_delivery",
            json!({ "order_id": id, "tx_hash": TX_HASH, "gas_wei": U128(1) }),
        )
        .await?
        .into_result()?;
    }
    let s = e.stats().await?;
    assert_eq!(s.paid_treasury, Default::default());
    assert_eq!(s.paid_agent, Default::default());
    assert_eq!(s.watch_orders, 1);
    assert_eq!(e.near_balance(&e.treasury).await?, treasury_before);
    assert_eq!(e.usdc_balance(e.treasury.id()).await?, 0);
    assert_eq!(e.usdc_balance(e.agent.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn only_agent_can_fulfil_confirm_resign_report() -> anyhow::Result<()> {
    let e = setup().await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let r1 = e.reading(id, V1, "exit", 8100, 6400).await?;
    for who in [&e.alice, &e.owner, &e.treasury] {
        let err = failure_text(e.fulfil(who, id, &r1, tx(0)).await?);
        assert!(err.contains("agent only"), "{err}");
    }
    e.fulfil(&e.agent, id, &r1, tx(0)).await?.into_result()?;
    e.advance(30).await?;
    let r2 = e.reading(id, V1, "hold", 6000, 2000).await?;
    for who in [&e.alice, &e.owner, &e.treasury] {
        let err = failure_text(e.confirm(who, id, &r2, tx(0)).await?);
        assert!(err.contains("agent only"), "{err}");
    }
    e.confirm(&e.agent, id, &r2, tx(0)).await?.into_result()?;

    for who in [&e.alice, &e.owner, &e.treasury] {
        for (method, args) in [
            ("resign", json!({ "order_id": id, "tx": tx(1) })),
            (
                "report_delivery",
                json!({ "order_id": id, "tx_hash": TX_HASH, "gas_wei": U128(1) }),
            ),
        ] {
            let err = failure_text(e.call(who, method, args).await?);
            assert!(err.contains("agent only"), "{method}: {err}");
        }
    }
    assert_eq!(e.signer_calls().await?, 1);
    e.call(
        &e.agent,
        "report_delivery",
        json!({ "order_id": id, "tx_hash": TX_HASH, "gas_wei": U128(123_456) }),
    )
    .await?
    .into_result()?;
    let s = e.stats().await?;
    assert_eq!(s.gas_wei.base, U128(123_456));
    assert_eq!(s.gas_wei.monad, U128(0));
    Ok(())
}

#[tokio::test]
async fn desk_pays_signer_deposit_from_balance() -> anyhow::Result<()> {
    let e = setup().await?;
    let id = id_of(e.order_near(&e.alice, V1, price_near()).await?)?;
    let r = e.reading(id, V1, "hold", 8100, 1200).await?;
    // `fulfil` takes no deposit: the agent's function-call key could not attach one.
    let with_deposit = e
        .agent
        .call(e.desk.id(), "fulfil")
        .args_json(r.args(id, tx(0)))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(with_deposit.is_failure());

    e.fulfil(&e.agent, id, &r, tx(0)).await?.into_result()?;
    assert_eq!(e.status(id).await?, OrderStatus::Signed);
    let deposits: U128 = e.signer.view("deposits").await?.json()?;
    assert_eq!(deposits, U128(1));
    assert_eq!(e.signer_calls().await?, 1);
    Ok(())
}

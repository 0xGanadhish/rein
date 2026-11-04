//! Chain Signatures stand-in for sandbox tests. `sign` takes the real signer's request shape and
//! answers in its response shape, signing the payload with one fixed secp256k1 key.
//! `set_mode` makes it fail, or hold the request until `release`.

use k256::ecdsa::SigningKey;
use near_sdk::{
    env, near, require, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseOrValue, YieldId,
};

/// The fixed key. Its address is what a desk under test derives.
pub const KEY: [u8; 32] = [0x42; 32];
pub const PATH: &str = "rein-attester-v1";

#[near(serializers = [json])]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u32,
}

#[near(serializers = [json])]
pub enum Payload {
    /// 32 bytes, hex.
    Ecdsa(String),
}

#[near(serializers = [json])]
pub struct AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
pub struct Scalar {
    pub scalar: String,
}

#[near(serializers = [json])]
pub struct SignResponse {
    pub scheme: String,
    pub big_r: AffinePoint,
    pub s: Scalar,
    pub recovery_id: u8,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Ok,
    Fail,
    Hold,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    mode: Mode,
    calls: u32,
    /// yoctoNEAR attached across all `sign` calls.
    deposits: u128,
    held: Option<YieldId>,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self {
            mode: Mode::Ok,
            calls: 0,
            deposits: 0,
            held: None,
        }
    }

    pub fn set_mode(&mut self, mode: Mode) {
        self.mode = mode;
    }

    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> PromiseOrValue<SignResponse> {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "attach 1 yoctoNEAR"
        );
        require!(
            env::prepaid_gas() >= Gas::from_tgas(15),
            "attach at least 15 Tgas"
        );
        require!(request.path == PATH, "unexpected path");
        require!(request.domain_id == 0, "unexpected domain");
        let Payload::Ecdsa(hex) = request.payload_v2;
        let payload = parse_hash(&hex);
        self.calls += 1;
        self.deposits += 1;
        match self.mode {
            Mode::Fail => env::panic_str("signer told to fail"),
            Mode::Ok => PromiseOrValue::Value(sign_payload(&payload)),
            Mode::Hold => {
                require!(self.held.is_none(), "already holding a request");
                let args = near_sdk::serde_json::json!({ "payload": hex }).to_string();
                let (p, id) =
                    Promise::new_yield("on_release", args, Gas::from_tgas(5), GasWeight(1));
                self.held = Some(id);
                PromiseOrValue::Promise(p)
            }
        }
    }

    /// Lets a held request finish, signed or failed per the mode at release time.
    pub fn release(&mut self) {
        let id = self
            .held
            .take()
            .unwrap_or_else(|| env::panic_str("nothing held"));
        let ok = self.mode != Mode::Fail;
        id.resume(if ok { b"1".as_slice() } else { b"0".as_slice() })
            .unwrap_or_else(|_| env::panic_str("resume failed"));
    }

    #[private]
    pub fn on_release(&mut self, payload: String) -> SignResponse {
        let go = env::promise_result_checked(0, 8).ok();
        require!(
            go.as_deref() == Some(b"1".as_slice()),
            "signer told to fail"
        );
        sign_payload(&parse_hash(&payload))
    }

    pub fn calls(&self) -> u32 {
        self.calls
    }

    pub fn deposits(&self) -> near_sdk::json_types::U128 {
        near_sdk::json_types::U128(self.deposits)
    }
}

/// Signs a 32-byte prehash with [`KEY`], low-s, in the real signer's response shape.
pub fn sign_payload(payload: &[u8; 32]) -> SignResponse {
    let key = SigningKey::from_slice(&KEY).unwrap();
    let (sig, recid) = key
        .sign_prehash_recoverable(payload)
        .unwrap_or_else(|_| env::panic_str("sign failed"));
    let bytes = sig.to_bytes();
    let y_odd = recid.is_y_odd();
    SignResponse {
        scheme: "Secp256k1".into(),
        big_r: AffinePoint {
            affine_point: format!(
                "{}{}",
                if y_odd { "03" } else { "02" },
                to_hex(&bytes[..32])
            ),
        },
        s: Scalar {
            scalar: to_hex(&bytes[32..]),
        },
        recovery_id: y_odd as u8,
    }
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn parse_hash(h: &str) -> [u8; 32] {
    let h = h.as_bytes();
    require!(h.len() == 64, "payload must be 32 bytes");
    let nib = |c: u8| {
        (c as char)
            .to_digit(16)
            .unwrap_or_else(|| env::panic_str("payload must be hex")) as u8
    };
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = (nib(h[2 * i]) << 4) | nib(h[2 * i + 1]);
    }
    out
}

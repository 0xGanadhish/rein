//! The oracle post as an EVM transaction: calldata, EIP-1559 RLP, and its signing hash.

use near_sdk::env;

use crate::types::Chain;

/// `bytes4(keccak256("post(address,uint8,uint16,uint16,bytes32,uint64)"))`.
const POST_SELECTOR: [u8; 4] = [0x4b, 0x9d, 0x55, 0xaf];

pub fn chain_id(c: Chain) -> u64 {
    match c {
        Chain::MonadTestnet => 10143,
        Chain::Monad => 143,
        Chain::Base => 8453,
        Chain::BaseSepolia => 84532,
    }
}

/// ABI-encoded `post(vault, verdict, confidence_bps, risk_bps, state_hash, valid_until)`.
pub fn post_calldata(
    vault: &[u8; 20],
    verdict: u8,
    confidence_bps: u16,
    risk_bps: u16,
    state_hash: &[u8; 32],
    valid_until: u64,
) -> Vec<u8> {
    let mut d = Vec::with_capacity(4 + 6 * 32);
    d.extend_from_slice(&POST_SELECTOR);
    let mut word = |bytes: &[u8]| {
        d.extend(std::iter::repeat_n(0, 32 - bytes.len()));
        d.extend_from_slice(bytes);
    };
    word(vault);
    word(&[verdict]);
    word(&confidence_bps.to_be_bytes());
    word(&risk_bps.to_be_bytes());
    word(state_hash);
    word(&valid_until.to_be_bytes());
    d
}

/// Type-2 transaction, unsigned: `0x02 || rlp([chain_id, nonce, max_prio, max_fee, gas, to, 0, data, []])`.
pub fn unsigned_1559(
    chain_id: u64,
    nonce: u64,
    max_prio: u128,
    max_fee: u128,
    gas: u64,
    to: &[u8; 20],
    data: &[u8],
) -> Vec<u8> {
    typed(&fields(chain_id, nonce, max_prio, max_fee, gas, to, data))
}

/// The hash the attester key signs.
pub fn payload_hash(unsigned: &[u8]) -> [u8; 32] {
    env::keccak256_array(unsigned)
}

/// Type-2 transaction with `sig` = `r || s || y_parity` appended.
#[allow(clippy::too_many_arguments)]
pub fn assemble_signed(
    chain_id: u64,
    nonce: u64,
    max_prio: u128,
    max_fee: u128,
    gas: u64,
    to: &[u8; 20],
    data: &[u8],
    sig: &[u8; 65],
) -> Vec<u8> {
    let mut f = fields(chain_id, nonce, max_prio, max_fee, gas, to, data);
    uint(&mut f, sig[64] as u128);
    uint_bytes(&mut f, &sig[..32]);
    uint_bytes(&mut f, &sig[32..64]);
    typed(&f)
}

fn fields(
    chain_id: u64,
    nonce: u64,
    max_prio: u128,
    max_fee: u128,
    gas: u64,
    to: &[u8; 20],
    data: &[u8],
) -> Vec<u8> {
    let mut f = Vec::with_capacity(64 + data.len());
    uint(&mut f, chain_id as u128);
    uint(&mut f, nonce as u128);
    uint(&mut f, max_prio);
    uint(&mut f, max_fee);
    uint(&mut f, gas as u128);
    string(&mut f, to);
    uint(&mut f, 0);
    string(&mut f, data);
    f.push(0xc0); // empty access list
    f
}

fn typed(items: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(items.len() + 4);
    out.push(0x02);
    header(&mut out, 0xc0, items.len());
    out.extend_from_slice(items);
    out
}

/// RLP length prefix for a string (`base` 0x80) or a list (`base` 0xc0).
fn header(out: &mut Vec<u8>, base: u8, len: usize) {
    if len <= 55 {
        out.push(base + len as u8);
    } else {
        let be = (len as u64).to_be_bytes();
        let be = strip(&be);
        out.push(base + 55 + be.len() as u8);
        out.extend_from_slice(be);
    }
}

fn string(out: &mut Vec<u8>, s: &[u8]) {
    if !(s.len() == 1 && s[0] < 0x80) {
        header(out, 0x80, s.len());
    }
    out.extend_from_slice(s);
}

fn uint(out: &mut Vec<u8>, n: u128) {
    uint_bytes(out, &n.to_be_bytes());
}

/// A big-endian integer: leading zeros dropped, zero as the empty string.
fn uint_bytes(out: &mut Vec<u8>, be: &[u8]) {
    string(out, strip(be));
}

fn strip(be: &[u8]) -> &[u8] {
    let i = be.iter().position(|b| *b != 0).unwrap_or(be.len());
    &be[i..]
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::{self, Value};

    struct Case {
        chain_id: u64,
        nonce: u64,
        max_prio: u128,
        max_fee: u128,
        gas: u64,
        oracle: [u8; 20],
        calldata: Vec<u8>,
        v: Value,
    }

    fn hex(s: &str) -> Vec<u8> {
        let h = s.strip_prefix("0x").unwrap().as_bytes();
        let nib = |c: u8| (c as char).to_digit(16).unwrap() as u8;
        h.chunks(2).map(|p| (nib(p[0]) << 4) | nib(p[1])).collect()
    }

    fn num<T: std::str::FromStr>(v: &Value) -> T {
        v.as_str().unwrap().parse().ok().unwrap()
    }

    fn cases() -> Vec<Case> {
        let all: Vec<Value> = serde_json::from_str(include_str!("../tests/vectors.json")).unwrap();
        all.into_iter()
            .map(|v| {
                let vault: [u8; 20] = hex(v["vault"].as_str().unwrap()).try_into().unwrap();
                let state_hash: [u8; 32] =
                    hex(v["state_hash"].as_str().unwrap()).try_into().unwrap();
                let calldata = post_calldata(
                    &vault,
                    v["verdict"].as_u64().unwrap() as u8,
                    v["confidence_bps"].as_u64().unwrap() as u16,
                    v["risk_bps"].as_u64().unwrap() as u16,
                    &state_hash,
                    num(&v["valid_until"]),
                );
                Case {
                    chain_id: v["chain_id"].as_u64().unwrap(),
                    nonce: num(&v["nonce"]),
                    max_prio: num(&v["max_priority_fee_per_gas"]),
                    max_fee: num(&v["max_fee_per_gas"]),
                    gas: num(&v["gas"]),
                    oracle: hex(v["oracle"].as_str().unwrap()).try_into().unwrap(),
                    calldata,
                    v,
                }
            })
            .collect()
    }

    fn unsigned(c: &Case) -> Vec<u8> {
        unsigned_1559(
            c.chain_id,
            c.nonce,
            c.max_prio,
            c.max_fee,
            c.gas,
            &c.oracle,
            &c.calldata,
        )
    }

    fn want(c: &Case, key: &str) -> Vec<u8> {
        hex(c.v[key].as_str().unwrap())
    }

    #[test]
    fn calldata_matches_viem() {
        for c in cases() {
            assert_eq!(c.calldata, want(&c, "calldata"));
        }
    }

    #[test]
    fn unsigned_matches_viem() {
        for c in cases() {
            assert_eq!(unsigned(&c), want(&c, "unsigned"));
        }
    }

    #[test]
    fn payload_hash_matches_viem() {
        for c in cases() {
            assert_eq!(
                payload_hash(&unsigned(&c)).to_vec(),
                want(&c, "payload_hash")
            );
        }
    }

    #[test]
    fn signed_matches_viem() {
        for c in cases() {
            let sig: [u8; 65] = want(&c, "signature").try_into().unwrap();
            let signed = assemble_signed(
                c.chain_id,
                c.nonce,
                c.max_prio,
                c.max_fee,
                c.gas,
                &c.oracle,
                &c.calldata,
                &sig,
            );
            assert_eq!(signed, want(&c, "signed"));
        }
    }

    #[test]
    fn chain_id_differs_per_chain() {
        assert_eq!(chain_id(Chain::MonadTestnet), 10143);
        assert_eq!(chain_id(Chain::Monad), 143);
        assert_eq!(chain_id(Chain::Base), 8453);
        assert_eq!(chain_id(Chain::BaseSepolia), 84532);
        let c = &cases()[0];
        let hashes: Vec<[u8; 32]> = [
            Chain::MonadTestnet,
            Chain::Monad,
            Chain::Base,
            Chain::BaseSepolia,
        ]
        .map(|ch| {
            payload_hash(&unsigned_1559(
                chain_id(ch),
                c.nonce,
                c.max_prio,
                c.max_fee,
                c.gas,
                &c.oracle,
                &c.calldata,
            ))
        })
        .to_vec();
        assert_ne!(hashes[0], hashes[1]);
        assert_ne!(hashes[1], hashes[2]);
        assert_ne!(hashes[0], hashes[2]);
        for hash in &hashes[..3] {
            assert_ne!(*hash, hashes[3]);
        }
    }
}

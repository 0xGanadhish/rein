//! Checks a model reading: the doc it judged, the NEAR AI signature over it, and the answer.

use near_sdk::{env, near};

use crate::types::{vault_hex, Chain, Order, Verdict};

/// What the desk sends the model. The request body is `prefix + doc + suffix`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Prompt {
    pub model: String,
    pub prefix: String,
    pub suffix: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    pub verdict: Verdict,
    pub confidence_bps: u16,
    pub risk_bps: u16,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

pub fn chain_name(c: Chain) -> &'static str {
    match c {
        Chain::MonadTestnet => "monad-testnet",
        Chain::Monad => "monad",
        Chain::Base => "base",
    }
}

/// Printable ASCII without `"` and `\`, so the doc can sit inside a JSON string unescaped.
fn doc_chars_ok(doc: &str) -> bool {
    doc.bytes()
        .all(|b| (0x20..=0x7e).contains(&b) && b != b'"' && b != b'\\')
}

/// Checks that `doc` belongs to `order` and is fresh. Returns its `at`.
pub fn check_doc(
    doc: &str,
    order: &Order,
    now_s: u32,
    max_age_s: u32,
) -> Result<u32, &'static str> {
    if !doc_chars_ok(doc) {
        return Err("bad doc");
    }
    let rest = doc.strip_prefix("rein-v1|").ok_or("bad doc")?;
    let rest = field(rest, "order=", &order.id.to_string(), "wrong order")?;
    let rest = field(rest, "chain=", chain_name(order.chain), "wrong chain")?;
    let rest = field(rest, "vault=", &vault_hex(&order.vault), "wrong vault")?;
    let (at, _) = rest
        .strip_prefix("at=")
        .and_then(|r| r.split_once('|'))
        .ok_or("bad doc")?;
    let at = digits_u32(at.as_bytes()).ok_or("bad doc")?;
    if at < order.created_s || now_s.saturating_sub(at) > max_age_s {
        return Err("stale doc");
    }
    Ok(at)
}

/// Strips `key`, `want` and `|` from the front of `rest`, or fails with `err`.
fn field<'a>(
    rest: &'a str,
    key: &str,
    want: &str,
    err: &'static str,
) -> Result<&'a str, &'static str> {
    rest.strip_prefix(key)
        .and_then(|r| r.strip_prefix(want))
        .and_then(|r| r.strip_prefix('|'))
        .ok_or(err)
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

/// The text a NEAR AI model key signs: `<model>:<sha256(request)>:<sha256(response)>`.
pub fn signed_text(model: &str, request: &[u8], response: &[u8]) -> String {
    format!(
        "{model}:{}:{}",
        hex(&env::sha256(request)),
        hex(&env::sha256(response))
    )
}

/// EIP-191 personal-sign recovery. `signature` is `r || s || v`, `v` in {0, 1, 27, 28}.
pub fn recover_signer(text: &str, signature: &[u8; 65]) -> Option<[u8; 20]> {
    let v = match signature[64] {
        v @ 0..=1 => v,
        v @ 27..=28 => v - 27,
        _ => return None,
    };
    let mut msg = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    msg.extend_from_slice(text.as_bytes());
    let hash = env::keccak256_array(&msg);
    let key = env::ecrecover(&hash, &signature[..64], v, true)?;
    let addr = env::keccak256_array(key);
    addr[12..].try_into().ok()
}

/// Reads `{"action":"hold|exit|rotate","confidence_bps":N,"withdrawal_risk_bps":N}`: these keys, in this
/// order, and nothing else. JSON whitespace is allowed between tokens, because the model pretty-prints.
fn parse_content(c: &str) -> Option<(Verdict, u16, u16)> {
    let c = token(c, "{")?;
    let c = token(c, "\"action\"")?;
    let c = token(c, ":")?;
    let c = token(c, "\"")?;
    let (action, c) = c.split_once('"')?;
    let verdict = match action {
        "hold" => Verdict::Hold,
        "exit" => Verdict::Exit,
        "rotate" => Verdict::Move,
        _ => return None,
    };
    let c = token(c, ",")?;
    let c = token(c, "\"confidence_bps\"")?;
    let c = token(c, ":")?;
    let (conf, c) = number(c)?;
    let c = token(c, ",")?;
    let c = token(c, "\"withdrawal_risk_bps\"")?;
    let c = token(c, ":")?;
    let (risk, c) = number(c)?;
    let c = token(c, "}")?;
    skip_ws(c)
        .is_empty()
        .then_some((verdict, bps(conf)?, bps(risk)?))
}

fn skip_ws(c: &str) -> &str {
    c.trim_start_matches(|x| matches!(x, ' ' | '\n' | '\r' | '\t'))
}

fn token<'a>(c: &'a str, t: &str) -> Option<&'a str> {
    skip_ws(c).strip_prefix(t)
}

/// The run of digits at the start of `c`, after whitespace, and the rest. `bps` refuses an empty run.
fn number(c: &str) -> Option<(&str, &str)> {
    let c = skip_ws(c);
    Some(c.split_at(c.find(|x: char| !x.is_ascii_digit())?))
}

fn bps(s: &str) -> Option<u16> {
    let n = digits_u32(s.as_bytes())?;
    (s.len() <= 5 && n <= 10_000).then_some(n as u16)
}

/// Decimal digits only, at least one, within u32.
fn digits_u32(d: &[u8]) -> Option<u32> {
    if d.is_empty() {
        return None;
    }
    d.iter().try_fold(0u32, |n, &c| {
        if !c.is_ascii_digit() {
            return None;
        }
        n.checked_mul(10)?.checked_add((c - b'0') as u32)
    })
}

/// Reads a chat-completions response body.
pub fn parse_answer(response: &str) -> Result<Answer, &'static str> {
    read_completion(response.as_bytes()).ok_or("bad answer")
}

fn read_completion(body: &[u8]) -> Option<Answer> {
    let (mut finish, mut content, mut prompt_t, mut completion_t) = (None, None, None, None);
    let (mut choices, mut usage, mut message) = (false, false, false);
    let mut j = Json {
        b: body,
        i: 0,
        depth: 0,
    };
    j.object(&mut |j, k| match k {
        b"choices" => {
            once(&mut choices)?;
            j.array(&mut |j, n| {
                if n > 0 {
                    return j.skip();
                }
                j.object(&mut |j, k| match k {
                    b"finish_reason" => set(&mut finish, j.string()?),
                    b"message" => {
                        once(&mut message)?;
                        j.object(&mut |j, k| match k {
                            b"content" => set(&mut content, j.string()?),
                            _ => j.skip(),
                        })
                    }
                    _ => j.skip(),
                })
            })
        }
        b"usage" => {
            once(&mut usage)?;
            j.object(&mut |j, k| match k {
                b"prompt_tokens" => set(&mut prompt_t, j.uint()?),
                b"completion_tokens" => set(&mut completion_t, j.uint()?),
                _ => j.skip(),
            })
        }
        _ => j.skip(),
    })?;
    j.ws();
    if j.i != body.len() || finish? != b"stop" {
        return None;
    }
    let (verdict, confidence_bps, risk_bps) = parse_content(core::str::from_utf8(&content?).ok()?)?;
    Some(Answer {
        verdict,
        confidence_bps,
        risk_bps,
        prompt_tokens: prompt_t?,
        completion_tokens: completion_t?,
    })
}

/// Fills `slot` once; a repeated key fails the parse.
fn set<T>(slot: &mut Option<T>, v: T) -> Option<()> {
    if slot.replace(v).is_some() {
        return None;
    }
    Some(())
}

fn once(seen: &mut bool) -> Option<()> {
    if core::mem::replace(seen, true) {
        return None;
    }
    Some(())
}

/// Strict JSON reader: walks one value, keeping only what the caller asks for.
struct Json<'a> {
    b: &'a [u8],
    i: usize,
    depth: u8,
}

impl<'a> Json<'a> {
    fn ws(&mut self) {
        while matches!(self.b.get(self.i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.ws();
        self.b.get(self.i).copied()
    }

    fn eat(&mut self, c: u8) -> bool {
        let hit = self.peek() == Some(c);
        if hit {
            self.i += 1;
        }
        hit
    }

    fn enter(&mut self, open: u8, close: u8) -> Option<bool> {
        if !self.eat(open) || self.depth >= 64 {
            return None;
        }
        if self.eat(close) {
            return Some(false);
        }
        self.depth += 1;
        Some(true)
    }

    /// After an item: `,` means another follows, `close` ends the container.
    fn next(&mut self, close: u8) -> Option<bool> {
        if self.eat(b',') {
            return Some(true);
        }
        if !self.eat(close) {
            return None;
        }
        self.depth -= 1;
        Some(false)
    }

    fn object(&mut self, f: &mut dyn FnMut(&mut Self, &[u8]) -> Option<()>) -> Option<()> {
        let mut more = self.enter(b'{', b'}')?;
        while more {
            let key = self.string()?;
            if !self.eat(b':') {
                return None;
            }
            f(self, &key)?;
            more = self.next(b'}')?;
        }
        Some(())
    }

    fn array(&mut self, f: &mut dyn FnMut(&mut Self, usize) -> Option<()>) -> Option<()> {
        let mut more = self.enter(b'[', b']')?;
        let mut n = 0;
        while more {
            f(self, n)?;
            n += 1;
            more = self.next(b']')?;
        }
        Some(())
    }

    /// Decoded string bytes. Escapes outside ASCII decode to U+FFFD, which no answer field allows.
    fn string(&mut self) -> Option<Vec<u8>> {
        if !self.eat(b'"') {
            return None;
        }
        let mut out = Vec::new();
        loop {
            let c = *self.b.get(self.i)?;
            self.i += 1;
            let d = match c {
                b'"' => return Some(out),
                0..=0x1f => return None,
                b'\\' => {
                    let e = *self.b.get(self.i)?;
                    self.i += 1;
                    match e {
                        b'"' | b'\\' | b'/' => e,
                        b'b' => 8,
                        b'f' => 12,
                        b'n' => b'\n',
                        b'r' => b'\r',
                        b't' => b'\t',
                        b'u' => {
                            let mut n = 0u32;
                            for _ in 0..4 {
                                let h = (*self.b.get(self.i)? as char).to_digit(16)?;
                                self.i += 1;
                                n = n * 16 + h;
                            }
                            if n < 0x80 {
                                n as u8
                            } else {
                                out.extend_from_slice("\u{fffd}".as_bytes());
                                continue;
                            }
                        }
                        _ => return None,
                    }
                }
                _ => c,
            };
            out.push(d);
        }
    }

    fn uint(&mut self) -> Option<u32> {
        self.ws();
        let start = self.i;
        while matches!(self.b.get(self.i), Some(b'0'..=b'9')) {
            self.i += 1;
        }
        let digits = &self.b[start..self.i];
        if digits.is_empty() || (digits.len() > 1 && digits[0] == b'0') {
            return None;
        }
        digits_u32(digits)
    }

    fn skip(&mut self) -> Option<()> {
        match self.peek()? {
            b'"' => self.string().map(drop),
            b'{' => self.object(&mut |j, _| j.skip()),
            b'[' => self.array(&mut |j, _| j.skip()),
            b't' | b'f' | b'n' => {
                let rest = &self.b[self.i..];
                let lit = [&b"true"[..], b"false", b"null"]
                    .into_iter()
                    .find(|l| rest.starts_with(l))?;
                self.i += lit.len();
                Some(())
            }
            _ => self.number(),
        }
    }

    /// `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`
    fn number(&mut self) -> Option<()> {
        let digits = |j: &mut Self| {
            let s = j.i;
            while matches!(j.b.get(j.i), Some(b'0'..=b'9')) {
                j.i += 1;
            }
            j.i - s
        };
        if self.b.get(self.i) == Some(&b'-') {
            self.i += 1;
        }
        let lead = self.b.get(self.i).copied();
        let n = digits(self);
        if n == 0 || (n > 1 && lead == Some(b'0')) {
            return None;
        }
        if self.b.get(self.i) == Some(&b'.') {
            self.i += 1;
            if digits(self) == 0 {
                return None;
            }
        }
        if matches!(self.b.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.b.get(self.i), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if digits(self) == 0 {
                return None;
            }
        }
        Some(())
    }
}

/// Verifies one reading for `order`. Returns the answer and `keccak256(doc)`.
#[allow(clippy::too_many_arguments)]
pub fn verify_reading(
    prompt: &Prompt,
    signers: &[[u8; 20]],
    order: &Order,
    doc: &str,
    response: &str,
    signature: &[u8; 65],
    now_s: u32,
    max_age_s: u32,
) -> Result<(Answer, [u8; 32]), &'static str> {
    if !doc_chars_ok(doc) {
        return Err("bad doc");
    }
    let mut request = String::with_capacity(prompt.prefix.len() + doc.len() + prompt.suffix.len());
    request.push_str(&prompt.prefix);
    request.push_str(doc);
    request.push_str(&prompt.suffix);
    let text = signed_text(&prompt.model, request.as_bytes(), response.as_bytes());
    let signer = recover_signer(&text, signature).ok_or("bad signature")?;
    if !signers.contains(&signer) {
        return Err("unknown signer");
    }
    check_doc(doc, order, now_s, max_age_s)?;
    let answer = parse_answer(response)?;
    Ok((answer, env::keccak256_array(doc.as_bytes())))
}

/// Parses a 0x-prefixed (optional) hex signature of 65 bytes.
pub fn parse_signature(s: &str) -> Option<[u8; 65]> {
    let h = s.strip_prefix("0x").unwrap_or(s).as_bytes();
    if h.len() != 130 {
        return None;
    }
    let nib = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let mut out = [0u8; 65];
    for (i, b) in out.iter_mut().enumerate() {
        *b = (nib(h[2 * i])? << 4) | nib(h[2 * i + 1])?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{OrderStatus, Policy, Source};
    use crate::Desk;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};
    use secp256k1::{Message as SecpMessage, Secp256k1, SecretKey};

    const MODEL: &str = "z-ai/glm-5.3-flash";
    const VAULT: &str = "0x1111111111111111111111111111111111111111";
    const CREATED: u32 = 1_793_773_600;
    const AT: u32 = 1_793_774_225;
    const NOW: u32 = AT + 60;

    fn key(seed: u8) -> SecretKey {
        SecretKey::from_slice(&[seed; 32]).unwrap()
    }

    fn address(k: &SecretKey) -> [u8; 20] {
        let pk = k.public_key(&Secp256k1::new()).serialize_uncompressed();
        env::keccak256_array(&pk[1..])[12..].try_into().unwrap()
    }

    fn sign(k: &SecretKey, text: &str) -> [u8; 65] {
        let mut msg = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
        msg.extend_from_slice(text.as_bytes());
        let m = SecpMessage::from_slice(&env::keccak256_array(&msg)).unwrap();
        let (id, rs) = Secp256k1::new()
            .sign_ecdsa_recoverable(&m, k)
            .serialize_compact();
        let mut out = [0u8; 65];
        out[..64].copy_from_slice(&rs);
        out[64] = 27 + id.to_i32() as u8;
        out
    }

    fn prompt() -> Prompt {
        Prompt {
            model: MODEL.into(),
            prefix: r#"{"model":"z-ai/glm-5.3-flash","messages":[{"role":"user","content":""#
                .into(),
            suffix: r#""}],"temperature":0}"#.into(),
        }
    }

    fn order(id: u64) -> Order {
        Order {
            id,
            source: Source::Near,
            payer: Some(accounts(1)),
            chain: Chain::Base,
            vault: crate::types::parse_vault(VAULT).unwrap(),
            amount: 1,
            created_s: CREATED,
            status: OrderStatus::Open,
            reading: None,
        }
    }

    fn doc_for(id: u64, chain: &str, vault: &str, at: u32) -> String {
        format!(
            "rein-v1|order={id}|chain={chain}|vault={vault}|at={at}|block=123|pps=1000000|assets=5000|liquidity=4000|apy_bps=812|apy_bps_prev=790|util_bps=8000|net_out_pct_1h=0|name=Steady USDC"
        )
    }

    fn doc() -> String {
        doc_for(7, "base", VAULT, AT)
    }

    fn response_with(content: &str, finish: &str) -> String {
        let content = near_sdk::serde_json::to_string(content).unwrap();
        format!(
            r#"{{"id":"chatcmpl-1","model":"{MODEL}","choices":[{{"index":0,"message":{{"role":"assistant","content":{content}}},"finish_reason":"{finish}"}}],"usage":{{"prompt_tokens":812,"completion_tokens":34,"total_tokens":846}}}}"#
        )
    }

    fn response() -> String {
        response_with(
            r#"{"action":"exit","confidence_bps":8100,"withdrawal_risk_bps":6400}"#,
            "stop",
        )
    }

    /// Signs as the NEAR AI model key over `prompt`, `doc` and `response`.
    fn sig(p: &Prompt, doc: &str, response: &str) -> [u8; 65] {
        let request = [p.prefix.as_str(), doc, p.suffix.as_str()].concat();
        sign(
            &key(1),
            &signed_text(&p.model, request.as_bytes(), response.as_bytes()),
        )
    }

    fn run(
        p: &Prompt,
        o: &Order,
        doc: &str,
        response: &str,
        s: &[u8; 65],
    ) -> Result<Answer, &'static str> {
        verify_reading(p, &[address(&key(1))], o, doc, response, s, NOW, 300).map(|(a, _)| a)
    }

    /// Signs `doc` and `response` honestly, then checks them.
    fn signed(doc: &str, response: &str) -> Result<Answer, &'static str> {
        run(
            &prompt(),
            &order(7),
            doc,
            response,
            &sig(&prompt(), doc, response),
        )
    }

    #[test]
    fn one_char_changed_in_response_fails() {
        let s = sig(&prompt(), &doc(), &response());
        let tampered = response().replace("8100", "8101");
        assert_eq!(
            run(&prompt(), &order(7), &doc(), &tampered, &s),
            Err("unknown signer")
        );
    }

    #[test]
    fn one_char_changed_in_doc_fails() {
        let s = sig(&prompt(), &doc(), &response());
        let (a, state_hash) = verify_reading(
            &prompt(),
            &[address(&key(1))],
            &order(7),
            &doc(),
            &response(),
            &s,
            NOW,
            300,
        )
        .unwrap();
        assert_eq!(a.verdict, Verdict::Exit);
        assert_eq!((a.confidence_bps, a.risk_bps), (8100, 6400));
        assert_eq!(state_hash, env::keccak256_array(doc().as_bytes()));
        let tampered = doc().replace("apy_bps=812", "apy_bps=912");
        assert_eq!(
            run(&prompt(), &order(7), &tampered, &response(), &s),
            Err("unknown signer")
        );
    }

    #[test]
    fn prefix_changed_fails() {
        let s = sig(&prompt(), &doc(), &response());
        let mut p = prompt();
        p.prefix = p.prefix.replace("user", "system");
        assert_eq!(
            run(&p, &order(7), &doc(), &response(), &s),
            Err("unknown signer")
        );
    }

    #[test]
    fn other_model_fails() {
        let mut other = prompt();
        other.model = "other/model".into();
        let s = sig(&other, &doc(), &response());
        assert_eq!(
            run(&prompt(), &order(7), &doc(), &response(), &s),
            Err("unknown signer")
        );
    }

    #[test]
    fn unknown_signer_refused() {
        let request = [prompt().prefix, doc(), prompt().suffix].concat();
        let s = sign(
            &key(2),
            &signed_text(MODEL, request.as_bytes(), response().as_bytes()),
        );
        assert_eq!(
            run(&prompt(), &order(7), &doc(), &response(), &s),
            Err("unknown signer")
        );
        let mut bad = s;
        bad[64] = 29;
        assert_eq!(
            run(&prompt(), &order(7), &doc(), &response(), &bad),
            Err("bad signature")
        );
    }

    #[test]
    fn gateway_format_refused() {
        let request = [prompt().prefix, doc(), prompt().suffix].concat();
        let text = format!(
            "{}:{}",
            hex(&env::sha256(request.as_bytes())),
            hex(&env::sha256(response().as_bytes()))
        );
        let s = sign(&key(1), &text);
        assert_eq!(
            run(&prompt(), &order(7), &doc(), &response(), &s),
            Err("unknown signer")
        );
    }

    #[test]
    fn doc_with_quote_refused() {
        assert_eq!(
            signed(&doc().replace("Steady", "St\"eady"), &response()),
            Err("bad doc")
        );
    }

    #[test]
    fn doc_with_backslash_refused() {
        assert_eq!(
            signed(&doc().replace("Steady", "St\\eady"), &response()),
            Err("bad doc")
        );
    }

    #[test]
    fn doc_with_newline_refused() {
        assert_eq!(signed(&format!("{}\n", doc()), &response()), Err("bad doc"));
    }

    #[test]
    fn doc_for_other_order_refused() {
        assert_eq!(
            signed(&doc_for(8, "base", VAULT, AT), &response()),
            Err("wrong order")
        );
    }

    #[test]
    fn doc_for_other_vault_refused() {
        let other = "0x2222222222222222222222222222222222222222";
        assert_eq!(
            signed(&doc_for(7, "base", other, AT), &response()),
            Err("wrong vault")
        );
        // The doc carries the address in lowercase only.
        let upper = "0xAAAA111111111111111111111111111111111111";
        let mut o = order(7);
        o.vault = crate::types::parse_vault(upper).unwrap();
        let d = doc_for(7, "base", upper, AT);
        let s = sig(&prompt(), &d, &response());
        assert_eq!(run(&prompt(), &o, &d, &response(), &s), Err("wrong vault"));
    }

    #[test]
    fn doc_for_other_chain_refused() {
        assert_eq!(
            signed(&doc_for(7, "monad", VAULT, AT), &response()),
            Err("wrong chain")
        );
        assert_eq!(
            signed(&doc_for(7, "monad-testnet", VAULT, AT), &response()),
            Err("wrong chain")
        );
    }

    #[test]
    fn replayed_answer_refused() {
        // A reading signed for order 7 is offered again for the vault's next order.
        let s = sig(&prompt(), &doc(), &response());
        let mut next = order(9);
        next.created_s = AT + 30;
        assert_eq!(
            run(&prompt(), &next, &doc(), &response(), &s),
            Err("wrong order")
        );
    }

    #[test]
    fn doc_older_than_300s_refused() {
        assert_eq!(
            signed(&doc_for(7, "base", VAULT, NOW - 300), &response()).map(|_| ()),
            Ok(())
        );
        assert_eq!(
            signed(&doc_for(7, "base", VAULT, NOW - 301), &response()),
            Err("stale doc")
        );
    }

    #[test]
    fn doc_from_before_the_order_refused() {
        let mut o = order(7);
        o.created_s = AT + 1;
        let d = doc();
        assert_eq!(
            run(
                &prompt(),
                &o,
                &d,
                &response(),
                &sig(&prompt(), &d, &response())
            ),
            Err("stale doc")
        );
    }

    #[test]
    fn truncated_answer_refused() {
        let r = response();
        let cut = &r[..r.len() - 20];
        assert_eq!(signed(&doc(), cut), Err("bad answer"));
        let r = response_with(r#"{"action":"exit","confidence_bps":81"#, "length");
        assert_eq!(signed(&doc(), &r), Err("bad answer"));
        let r = response_with(
            r#"{"action":"exit","confidence_bps":8100,"withdrawal_risk_bps":6400}"#,
            "length",
        );
        assert_eq!(signed(&doc(), &r), Err("bad answer"));
    }

    #[test]
    fn extra_text_refused() {
        for c in [
            r#"Answer: {"action":"exit","confidence_bps":8100,"withdrawal_risk_bps":6400}"#,
            r#"{"action":"exit","confidence_bps":8100,"withdrawal_risk_bps":6400} ok"#,
            r#"{"action":"exit","confidence_bps":8100,"withdrawal_risk_bps":6400,"note":"x"}"#,
            r#"{"confidence_bps":8100,"action":"exit","withdrawal_risk_bps":6400}"#,
            r#"{"action":"ex it","confidence_bps":8100,"withdrawal_risk_bps":6400}"#,
            r#"{"action":"exit","confidence_bps":81 00,"withdrawal_risk_bps":6400}"#,
            r#"{"action" "exit","confidence_bps":8100,"withdrawal_risk_bps":6400}"#,
        ] {
            assert_eq!(
                signed(&doc(), &response_with(c, "stop")),
                Err("bad answer"),
                "{c}"
            );
        }
    }

    /// A real NEAR AI answer, checked offline: the desk rebuilds the exact request and recovers the model's key.
    #[test]
    fn real_fixture_verifies() {
        let f: near_sdk::serde_json::Value =
            near_sdk::serde_json::from_str(include_str!("../tests/fixtures/near-ai-1.json"))
                .unwrap();
        let s = |k: &str| f[k].as_str().unwrap().to_string();
        let p = Prompt {
            model: s("model"),
            prefix: s("prefix"),
            suffix: s("suffix"),
        };
        let mut o = order(1);
        o.chain = Chain::MonadTestnet;
        let at = 1_793_910_680;
        o.created_s = at - 60;
        let signer = crate::types::parse_vault(&s("signing_address")).unwrap();
        let signature = parse_signature(&s("signature")).unwrap();
        let (a, _) = verify_reading(
            &p,
            &[signer],
            &o,
            &s("doc"),
            &s("response"),
            &signature,
            at + 60,
            600,
        )
        .unwrap();
        assert!(matches!(a.verdict, Verdict::Hold));
        assert_eq!((a.confidence_bps, a.risk_bps), (8200, 1200));

        let changed = s("response").replacen("8200", "8201", 1);
        assert!(verify_reading(&p, &[signer], &o, &s("doc"), &changed, &signature, at + 60, 600)
            .is_err());
    }

    #[test]
    fn pretty_printed_answer_accepted() {
        let c = "{\n  \"action\": \"exit\",\n  \"confidence_bps\": 8100,\n  \"withdrawal_risk_bps\": 6400\n}";
        let a = parse_content(c).expect("the model's real format");
        assert!(matches!(a.0, Verdict::Exit));
        assert_eq!((a.1, a.2), (8100, 6400));
        assert!(parse_content(&format!(" \t\r\n{c}\n")).is_some());
    }

    #[test]
    fn bps_over_limit_refused() {
        let ok = r#"{"action":"hold","confidence_bps":10000,"withdrawal_risk_bps":0}"#;
        assert!(signed(&doc(), &response_with(ok, "stop")).is_ok());
        for c in [
            r#"{"action":"hold","confidence_bps":10001,"withdrawal_risk_bps":0}"#,
            r#"{"action":"hold","confidence_bps":0,"withdrawal_risk_bps":10001}"#,
            r#"{"action":"hold","confidence_bps":-1,"withdrawal_risk_bps":0}"#,
            r#"{"action":"hold","confidence_bps":99999,"withdrawal_risk_bps":0}"#,
        ] {
            assert_eq!(
                signed(&doc(), &response_with(c, "stop")),
                Err("bad answer"),
                "{c}"
            );
        }
    }

    #[test]
    fn unknown_action_refused() {
        for a in ["move", "HOLD", "sell", ""] {
            let c =
                format!(r#"{{"action":"{a}","confidence_bps":8100,"withdrawal_risk_bps":6400}}"#);
            assert_eq!(
                signed(&doc(), &response_with(&c, "stop")),
                Err("bad answer"),
                "{a}"
            );
        }
    }

    #[test]
    fn empty_choices_refused() {
        let r = r#"{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}"#;
        assert_eq!(signed(&doc(), r), Err("bad answer"));
    }

    #[test]
    fn tokens_read_from_usage() {
        let a = signed(&doc(), &response()).unwrap();
        assert_eq!((a.prompt_tokens, a.completion_tokens), (812, 34));
        let r = response().replace(r#""usage""#, r#""ignored""#);
        assert_eq!(signed(&doc(), &r), Err("bad answer"));
    }

    #[test]
    fn actions_map_to_verdicts() {
        for (action, verdict) in [
            ("hold", Verdict::Hold),
            ("exit", Verdict::Exit),
            ("rotate", Verdict::Move),
        ] {
            let c = format!(
                r#"{{"action":"{action}","confidence_bps":5000,"withdrawal_risk_bps":1200}}"#
            );
            let a = signed(&doc(), &response_with(&c, "stop")).unwrap();
            assert_eq!(a.verdict, verdict);
            assert_eq!(a.verdict as u8, verdict as u8);
            assert_eq!((a.confidence_bps, a.risk_bps), (5000, 1200));
        }
        assert_eq!(
            [
                Verdict::Hold as u8,
                Verdict::Exit as u8,
                Verdict::Move as u8
            ],
            [0, 1, 2]
        );
    }

    #[test]
    fn check_reading_returns_each_reason() {
        let owner = accounts(0);
        let mut ctx = VMContextBuilder::new();
        ctx.predecessor_account_id(owner.clone())
            .block_timestamp(CREATED as u64 * 1_000_000_000);
        testing_env!(ctx.build());
        let mut desk = Desk::new(
            owner.clone(),
            Policy::mainnet(accounts(2), accounts(3), accounts(4)),
            format!("0x{}", "00".repeat(20)),
        );
        desk.set_menu(Chain::Base, VAULT.into(), true);
        let p = prompt();
        desk.set_prompt(p.model.clone(), p.prefix.clone(), p.suffix.clone());
        let signer = format!("0x{}", hex(&address(&key(1))));
        desk.set_signer(signer.to_uppercase().replace("0X", "0x"), true);
        assert_eq!(desk.prompt(), p);
        assert_eq!(desk.signers(), vec![signer.clone()]);

        ctx.predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_millinear(300));
        testing_env!(ctx.build());
        let id = desk.request_judgement(Chain::Base, VAULT.into());
        ctx.block_timestamp(NOW as u64 * 1_000_000_000);
        testing_env!(ctx.build());

        let d = doc_for(id, "base", VAULT, AT);
        let r = response();
        let hex_sig = |s: [u8; 65]| format!("0x{}", hex(&s));
        let good = hex_sig(sig(&p, &d, &r));
        let check =
            |d: &str, r: &str, s: &str| desk.check_reading(id, d.into(), r.into(), s.into());
        let signed = |d: &str, r: &str| check(d, r, &hex_sig(sig(&p, d, r)));

        assert_eq!(check(&d, &r, &good), "ok");
        assert_eq!(check(&d, &r, &good[2..]), "ok");
        assert_eq!(signed(&format!("{d}\""), &r), "bad doc");
        assert_eq!(check(&d, &r, "0x1234"), "bad signature");
        assert_eq!(
            check(&d, &r.replace("8100", "8101"), &good),
            "unknown signer"
        );
        assert_eq!(
            signed(&doc_for(id + 1, "base", VAULT, AT), &r),
            "wrong order"
        );
        assert_eq!(signed(&doc_for(id, "monad", VAULT, AT), &r), "wrong chain");
        let v2 = "0x2222222222222222222222222222222222222222";
        assert_eq!(signed(&doc_for(id, "base", v2, AT), &r), "wrong vault");
        assert_eq!(
            signed(&doc_for(id, "base", VAULT, NOW - 301), &r),
            "stale doc"
        );
        assert_eq!(signed(&d, &response_with("{}", "stop")), "bad answer");
        assert_eq!(
            desk.check_reading(id + 5, d.clone(), r.clone(), good.clone()),
            "no such order"
        );

        ctx.predecessor_account_id(owner);
        testing_env!(ctx.build());
        desk.set_signer(signer, false);
        assert!(desk.signers().is_empty());
        assert_eq!(desk.check_reading(id, d, r, good), "unknown signer");
    }
}

use crate::types::Policy;

/// Post history window.
pub const WINDOW_S: u32 = 3600;
pub const DAY_S: u32 = 86_400;

/// Checks whether a post for one vault may happen at `now_s`.
/// `history` holds that vault's post times, `global` every vault's.
pub fn check_post(
    history: &[u32],
    global: &[u32],
    now_s: u32,
    p: &Policy,
) -> Result<(), &'static str> {
    let age = |t: &u32| now_s.saturating_sub(*t);
    if history.iter().any(|t| age(t) < p.spacing_s) {
        return Err("spacing");
    }
    if history.iter().filter(|t| age(t) < WINDOW_S).count() >= p.per_vault_max as usize {
        return Err("per-vault cap");
    }
    if global.iter().filter(|t| age(t) < WINDOW_S).count() >= p.global_max as usize {
        return Err("global cap");
    }
    Ok(())
}

/// Drops entries older than the window.
pub fn prune_history(history: &mut Vec<u32>, now_s: u32) {
    history.retain(|t| now_s.saturating_sub(*t) < WINDOW_S);
}

/// Watch requests counted per UTC day.
#[near_sdk::near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WatchDay {
    pub day: u32,
    pub count: u32,
}

impl WatchDay {
    /// Counts one watch request at `now_s`, or refuses it over the daily cap.
    pub fn bump(&mut self, now_s: u32, p: &Policy) -> Result<(), &'static str> {
        let day = now_s / DAY_S;
        if day != self.day {
            *self = Self { day, count: 0 };
        }
        if self.count >= p.watch_daily_max {
            return Err("watch cap");
        }
        self.count += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> Policy {
        Policy::mainnet(
            "agent.near".parse().unwrap(),
            "treasury.near".parse().unwrap(),
            "usdc.near".parse().unwrap(),
        )
    }

    const NOW: u32 = 1_800_000_000;

    #[test]
    fn spacing_blocks_within_600s() {
        let p = policy();
        assert_eq!(
            check_post(&[NOW - 599], &[NOW - 599], NOW, &p),
            Err("spacing")
        );
        assert_eq!(check_post(&[NOW - 1], &[NOW - 1], NOW, &p), Err("spacing"));
        assert_eq!(check_post(&[NOW - 600], &[NOW - 600], NOW, &p), Ok(()));
        // Another vault's recent post does not block this one.
        assert_eq!(check_post(&[], &[NOW - 1], NOW, &p), Ok(()));
    }

    #[test]
    fn per_vault_cap_4_per_hour() {
        let p = policy();
        let three = [NOW - 3000, NOW - 2400, NOW - 1800];
        assert_eq!(check_post(&three, &three, NOW, &p), Ok(()));
        let four = [NOW - 3000, NOW - 2400, NOW - 1800, NOW - 1200];
        assert_eq!(check_post(&four, &four, NOW, &p), Err("per-vault cap"));
    }

    #[test]
    fn global_cap_40_per_hour() {
        let p = policy();
        let global: Vec<u32> = (0..39).map(|i| NOW - 3500 + i * 60).collect();
        assert_eq!(check_post(&[], &global, NOW, &p), Ok(()));
        let global: Vec<u32> = (0..40).map(|i| NOW - 3500 + i * 60).collect();
        assert_eq!(check_post(&[], &global, NOW, &p), Err("global cap"));
    }

    #[test]
    fn old_entries_outside_hour_ignored() {
        let p = policy();
        let old_vault = [NOW - 7200, NOW - 5000, NOW - 4000, NOW - 3600];
        let old_global: Vec<u32> = (0..100).map(|i| NOW - 3600 - i).collect();
        assert_eq!(check_post(&old_vault, &old_global, NOW, &p), Ok(()));

        let mut h = vec![NOW - 7200, NOW - 3600, NOW - 3599, NOW - 10];
        prune_history(&mut h, NOW);
        assert_eq!(h, vec![NOW - 3599, NOW - 10]);
    }

    #[test]
    fn watch_cap_per_day_resets() {
        let p = policy();
        let day = NOW / DAY_S * DAY_S;
        let mut w = WatchDay::default();
        for i in 0..4 {
            assert_eq!(w.bump(day + i, &p), Ok(()));
        }
        assert_eq!(w.bump(day + DAY_S - 1, &p), Err("watch cap"));
        assert_eq!(w.count, 4, "a refused request is not counted");
        assert_eq!(w.bump(day + DAY_S, &p), Ok(()));
        assert_eq!(w.count, 1);

        let t = Policy::testnet(
            "agent.near".parse().unwrap(),
            "treasury.near".parse().unwrap(),
        );
        let mut w = WatchDay::default();
        for i in 0..200 {
            assert_eq!(w.bump(day + i, &t), Ok(()));
        }
        assert_eq!(w.bump(day + 200, &t), Err("watch cap"));
    }
}

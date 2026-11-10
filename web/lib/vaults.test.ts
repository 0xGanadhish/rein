import { describe, expect, it } from 'vitest';
import { shortAddress, vaultName } from './vaults';

describe('vault names', () => {
  it('names_testnet_mirror_vaults', () => {
    for (const [chain, vaults] of Object.entries({
      'monad-testnet': [
        '0xA32cF682DA4A62c056fD631eE91dfE3C713EF1DB',
        '0x4a03c331a2fFFB7Df05609749319940247ea3843',
        '0xA05df79d9fb5195C621Bc655fE345d6166fb2E07',
      ],
      'base-sepolia': [
        '0x7B1D9003983c0B55B8b15aA37e7E188Ce6AabdC8',
        '0x0B673bFAC6383bFd6E31170d94d5A9D4F8cf5c44',
        '0x9a410Af861d07545A1E7a53aCF86e570A6F32FA8',
      ],
    })) {
      vaults.forEach((vault, i) =>
        expect(vaultName(chain, vault)).toBe(`${['rmSTEAK', 'rmCSCB', 'rmSIRLOIN'][i]} (mirror)`),
      );
    }
  });

  it('names_monad_mainnet_menu', () => {
    expect(vaultName('monad', '0xE1BcA19baA63894D374578320551633320436523')).toBe('Clearstar Earn USDC');
    expect(vaultName('monad', '0x80017bF0f793EBbE9679Cd61ff0e395B62CAbB59')).toBe('August USDC V2');
  });

  it('falls_back_to_short_address', () => {
    const vault = '0x1234567890123456789012345678901234567890';
    for (const chain of ['base', 'monad', 'monad-testnet', 'base-sepolia', 'unknown']) {
      expect(vaultName(chain, vault)).toBe(shortAddress(vault));
    }
  });
});

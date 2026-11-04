'use client';

import { useNearWallet } from './NearWallet';
import styles from '../Header.module.css';

export function Account() {
  const { account, connect, disconnect } = useNearWallet();
  if (!account) {
    return <button type="button" className={styles.connect} onClick={() => void connect()}>Connect NEAR</button>;
  }
  return (
    <details className={styles.account}>
      <summary className={styles.accountPill}><span className={styles.avatar} aria-hidden="true" />{account}</summary>
      <div className={styles.menu}>
        <button type="button" onClick={() => void disconnect()}>Disconnect</button>
      </div>
    </details>
  );
}

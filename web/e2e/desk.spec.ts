import { expect, test, type Page } from '@playwright/test';

/** Nothing on the page is wider than the screen. */
async function fitsWidth(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('ledger shows graded calls with signed readings and the Tare comparison', async ({ page }) => {
  await page.goto('/ledger?network=mainnet');
  await expect(page.getByRole('heading', { name: 'Every call, graded.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent calls' })).toBeVisible();
  await expect(page.getByText('Tare · Jev, not signature-checked')).toBeVisible();
  await expect(page.getByText(/^signer 0x/).first()).toBeAttached();
  await fitsWidth(page);
});

test('judge menu lists vaults and keeps payments off on sample data', async ({ page }) => {
  await page.goto('/judge');
  await expect(page.getByRole('heading', { name: 'Which vault worries you?' })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Vault' }).getByRole('radio').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Pay & judge|Connect NEAR to pay/ })).toBeDisabled();
  await expect(page.getByText('Sample data: payments are off.')).toBeVisible();
  await fitsWidth(page);
});

test('receipt walks the order to delivered and links the oracle post', async ({ page }) => {
  await page.goto('/orders/4001');
  const status = page.getByRole('list', { name: 'Order status' });
  await expect(status.getByText('Delivered')).toBeVisible();
  const proof = page.getByRole('list', { name: 'Proof chain' });
  await expect(proof.getByRole('link', { name: /Chain Signatures post/ })).toHaveAttribute(
    'href',
    /^https:\/\/basescan\.org\/tx\/0x[0-9a-f]{64}$/,
  );
  await fitsWidth(page);
});

test('how it works lists the checks and the disclosed limits', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'How it works' }).first().click();
  await expect(page).toHaveURL(/\/how$/);
  await expect(page.getByRole('list', { name: 'What the desk checks' }).getByRole('listitem')).toHaveCount(7);
  await expect(
    page.getByRole('list', { name: 'Disclosed limits' }).getByRole('heading', { name: 'x402 payments' }),
  ).toBeVisible();
  await fitsWidth(page);
});

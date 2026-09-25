import { test, expect } from '@playwright/test';

test('백테스트 실행 → 결과 확인 → 상세 차트 → 랭킹·전략 분석 반영', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '백테스트 실행' })).toBeVisible();
  await expect(page.getByText('Mock 모드')).toBeVisible();

  await page.getByLabel('닉네임').fill('e2e_user');
  await page.getByRole('button', { name: /최근 1년/ }).click();
  await page.getByRole('button', { name: '다음 날 분봉 VWAP' }).click();
  await expect(page.locator('#combo-count')).toHaveText('4개 조합 실행');
  await page.getByRole('button', { name: '실행', exact: true }).click();

  const result = page.locator('#group-result');
  await expect(result.getByText('실행 결과 (4/4)')).toBeVisible({ timeout: 30_000 });
  await expect(result.locator('tbody tr')).toHaveCount(4);

  await result.locator('tbody tr').first().click();
  await expect(page.getByRole('heading', { name: /e2e_user의/ })).toBeVisible();
  await expect(page.locator('#equity-chart svg path.series')).toHaveCount(3);
  await expect(page.getByText('분봉 VWAP 체결').first()).toBeVisible();

  await page.getByRole('link', { name: '랭킹' }).click();
  await expect(page.locator('#rank-table tbody tr').first()).toContainText('e2e_user');

  await page.getByRole('link', { name: '전략 분석' }).click();
  await expect(page.getByRole('heading', { name: '전략 × effort' })).toBeVisible();
  await expect(page.locator('#hm-effort .cell').first()).toBeVisible();

  await page.getByRole('link', { name: '내 기록' }).click();
  await expect(page.locator('#mine-body tbody tr')).toHaveCount(4);

  expect(pageErrors).toEqual([]);
});

test('잘못된 입력은 한국어 오류 메시지로 안내', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('닉네임').fill('');
  await page.getByRole('button', { name: '실행', exact: true }).click();
  await expect(page.locator('#form-error')).toContainText('닉네임');
});

test('코인 시장: 코인 프리셋·7일 주기로 실행하고 소수점 수량으로 체결', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('닉네임').fill('coin_e2e');
  await page.getByRole('button', { name: /코인/ }).click();
  await expect(page.getByRole('button', { name: /비트코인/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('7일마다 UTC 0시 종가로 판단')).toBeVisible();
  await page.locator('#ticker-input').fill('sol');
  await page.getByRole('button', { name: '추가', exact: true }).click();
  await expect(page.getByRole('button', { name: 'SOL-USD' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /최근 1년/ }).click();
  await page.getByRole('button', { name: '실행', exact: true }).click();
  const result = page.locator('#group-result');
  await expect(result.getByText('실행 결과 (4/4)')).toBeVisible({ timeout: 30_000 });
  await result.locator('tbody tr').first().click();
  await expect(page.getByText('코인 ·')).toBeVisible();
  await expect(page.locator('#equity-chart svg path.series')).toHaveCount(3);
});

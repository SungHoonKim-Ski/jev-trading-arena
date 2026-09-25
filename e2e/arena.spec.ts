import { test, expect } from '@playwright/test';

test('간단 매매: 전략 1개 선택 → 하루씩 재생 → 결과 카드 → 랭킹·분석·기록 반영', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Jev에게 매매를 맡겨 보세요' })).toBeVisible();
  await expect(page.getByText('Mock 엔진')).toBeVisible();
  // 전략은 하나만 고르는 라디오: 다른 전략을 고르면 이전 선택이 풀린다
  await expect(page.getByRole('radio', { name: /오를까/ })).toBeChecked();
  await page.getByRole('radio', { name: /등급으로/ }).check();
  await expect(page.getByRole('radio', { name: /등급으로/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /오를까/ })).not.toBeChecked();
  await expect(page.locator('input[name="strategy"]:checked')).toHaveCount(1);
  await page.getByRole('radio', { name: '6개월' }).check();
  await page.getByLabel('닉네임').fill('e2e_user');
  await page.getByRole('button', { name: '▶ 매매 시작' }).click();

  await expect(page).toHaveURL(/#play\/\d+/);
  await expect(page.locator('.scoreboard')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: /e2e_user의 “등급으로” 매매/ })).toBeVisible();
  // 재생 중에는 날짜가 앞으로 간다
  const first = await page.locator('#today').textContent();
  await expect.poll(async () => page.locator('#today').textContent(), { timeout: 10_000 }).not.toBe(first);
  await page.getByRole('button', { name: '⏭ 결과' }).click();
  await expect(page.locator('.result-card')).toBeVisible();
  await expect(page.locator('#rank')).toHaveText(/\d+위 \/ \d+/);
  await expect(page.locator('#feed li').first()).toBeVisible();
  await expect(page.locator('#price-chart svg path.series')).toHaveCount(1);
  await expect(page.locator('#race svg path.series')).toHaveCount(2);

  await page.getByRole('link', { name: '랭킹', exact: true }).first().click();
  await expect(page.locator('#rank-table tbody tr').first()).toContainText('e2e_user');
  await page.locator('#rank-table tbody tr').first().click();
  await expect(page).toHaveURL(/#play\/\d+/);

  await page.getByRole('link', { name: '전략 분석' }).click();
  await expect(page.locator('#hm-effort .cell').first()).toBeVisible();
  await page.getByRole('link', { name: '내 기록' }).click();
  await expect(page.locator('#mine-body tbody tr')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('닉네임이 없으면 한국어로 안내', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('닉네임').fill('');
  await page.getByRole('button', { name: '▶ 매매 시작' }).click();
  await expect(page.locator('#form-error')).toContainText('닉네임');
});

test('코인: 5종 칩만 제공, 고급 설정의 여러 조합 비교는 결과 표로', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('radio', { name: /코인/ }).check();
  await expect(page.locator('#preset-chips .chip')).toHaveCount(5);
  await expect(page.locator('#ticker-input')).toHaveCount(0);
  await page.getByRole('button', { name: '솔라나' }).click();
  await page.getByLabel('닉네임').fill('coin_e2e');
  await page.getByText('고급 설정').click();
  await expect(page.getByText('7일마다 판단')).toBeVisible();
  await page.getByLabel(/여러 조합 한 번에 비교/).check();
  await page.locator('.compare-box input[name="strategies"][value="choice"]').check();
  await expect(page.locator('button.start')).toHaveText('▶ 2개 조합 비교');
  await page.locator('button.start').click();
  const result = page.locator('#group-result');
  await expect(result.getByText('실행 결과 (2/2)')).toBeVisible({ timeout: 30_000 });
  await expect(result.locator('tbody tr')).toHaveCount(2);
  await result.locator('tbody tr').first().click();
  await expect(page).toHaveURL(/#play\/\d+/);
  await expect(page.locator('#sym-tabs .chip')).toHaveCount(3);
});

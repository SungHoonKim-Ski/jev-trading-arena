import { test, expect } from '@playwright/test';

test('간단 매매: 전략 1개 선택 → 하루씩 재생 → 결과 카드 → 랭킹·분석·기록 반영', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Jev에게 매매를 맡겨 보세요' })).toBeVisible();
  await expect(page.getByText('Mock 엔진')).toBeVisible();
  // Jev 질문은 '오를까?' 하나: 질문 방식을 고르는 단계가 없다
  await expect(page.locator('input[name="strategy"]')).toHaveCount(0);
  await expect(page.getByText('오를 확률이 몇 % 이상이면 살까?')).toBeVisible();
  await page.getByRole('radio', { name: '6개월' }).check();
  // 무엇을 살지도 하나만: 개별 종목·ETF 묶음, 종목코드 입력칸 없음
  await expect(page.getByText('개별 종목')).toBeVisible();
  await expect(page.getByText('ETF', { exact: true })).toBeVisible();
  await expect(page.locator('#ticker-input')).toHaveCount(0);
  await expect(page.locator('.simple-form input[type="checkbox"]:not([name="compare"]):not(.compare-box input)')).toHaveCount(0);
  await page.getByRole('radio', { name: 'S&P 500 (SPY)' }).check();
  await expect(page.locator('input[name="ticker"]:checked')).toHaveCount(1);
  // 확신 기준: 기본 80%, 90%로 변경. 매도 규칙 기본은 반대 확신 매도
  await expect(page.getByRole('radio', { name: '80%' })).toBeChecked();
  await page.getByRole('radio', { name: '90%' }).check();
  await expect(page.locator('input[name="exitRule"][value="opposite"]')).toBeChecked();
  await page.getByLabel('닉네임').fill('e2e_user');
  await page.getByRole('button', { name: '▶ 매매 시작' }).click();

  await expect(page).toHaveURL(/#play\/\d+/);
  await expect(page.locator('.scoreboard')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: /e2e_user의 매매/ })).toBeVisible();
  await expect(page.locator('.play-head .lead')).toContainText('확신 기준 90%');
  await expect(page.locator('.play-head .lead')).toContainText('반대 확신 매도');
  // 재생 중에는 날짜가 앞으로 간다
  const first = await page.locator('#today').textContent();
  await expect.poll(async () => page.locator('#today').textContent(), { timeout: 10_000 }).not.toBe(first);
  await page.getByRole('button', { name: '⏭ 결과' }).click();
  await expect(page.locator('.result-card')).toBeVisible();
  await expect(page.locator('#rank')).toHaveText(/\d+위 \/ \d+/);
  await expect(page.locator('#feed li').first()).toBeVisible();
  await expect(page.locator('#price-chart svg path.series')).toHaveCount(1);
  await expect(page.locator('#sym-tabs .chip')).toHaveCount(0); // 종목 하나
  await expect(page.locator('#race svg path.series')).toHaveCount(2);

  await page.getByRole('link', { name: '랭킹', exact: true }).first().click();
  // 1위 시상대 카드, 내 순위 카드
  await expect(page.locator('.podium-card.place-1')).toContainText('e2e_user');
  await expect(page.locator('.my-rank')).toContainText('1위');
  await expect(page.locator('.my-rank')).toContainText('지금 1위예요');
  await page.getByRole('radio', { name: '보유 대비' }).check();
  await expect(page.locator('.podium-card.place-1 .big')).toContainText('%p');
  await page.getByRole('radio', { name: /코인/ }).check();
  await expect(page.locator('#rank-board')).toContainText('아직 이 조건의 기록이 없어요');
  await page.getByRole('radio', { name: '전체' }).check();
  await page.locator('.podium-card.place-1').click();
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
  await page.locator('input[name="market"][value="CRYPTO"]').check();
  await expect(page.locator('input[name="ticker"]')).toHaveCount(5);
  await expect(page.locator('#ticker-input')).toHaveCount(0);
  await page.getByRole('radio', { name: '솔라나' }).check();
  await expect(page.locator('input[name="ticker"]:checked')).toHaveCount(1);
  await page.getByLabel('닉네임').fill('coin_e2e');
  await page.getByText('고급 설정').click();
  await expect(page.getByText('7일마다 판단')).toBeVisible();
  await page.getByLabel(/여러 조합 한 번에 비교/).check();
  await expect(page.locator('.compare-box input[name="strategies"]')).toHaveCount(0);
  await page.locator('.compare-box input[name="efforts"][value="high"]').check();
  await expect(page.locator('button.start')).toHaveText('▶ 2개 조합 비교');
  await page.locator('button.start').click();
  const result = page.locator('#group-result');
  await expect(result.getByText('실행 결과 (2/2)')).toBeVisible({ timeout: 30_000 });
  await expect(result.locator('tbody tr')).toHaveCount(2);
  await result.locator('tbody tr').first().click();
  await expect(page).toHaveURL(/#play\/\d+/);
  await expect(page.locator('#sym-tabs')).toContainText('SOLUSDT');
});

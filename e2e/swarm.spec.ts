import { expect, test, type Page } from "@playwright/test";

// e2e 스모크 — 전부 픽스처 스트림 모드(?fixture=news)라 네트워크 없이 돈다.
// 픽스처 시나리오(src/trend/fixtures.ts): 접속 시점에 진입한 이벤트 3개(짝·링크 뉴스·식는 #aurora),
// 몇 초 뒤 떠오르는 #worldcupfinal, 35초 뒤 東京 地震.

const URL = "/?fixture=news";

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function swarmStats(page: Page): Promise<{ cursors: number; byEvent: Record<string, number>; cards: number; built: number }> {
  return page.evaluate(() => (globalThis as unknown as { __swarm: { stats: () => { cursors: number; byEvent: Record<string, number>; cards: number; built: number } } }).__swarm.stats());
}

test("페이지 로드 — 툴바·HUD pill·캔버스, 콘솔 에러 0", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(URL);
  await expect(page.locator(".tb")).toBeVisible();
  await expect(page.locator(".hud-pill")).toBeVisible();
  await expect(page.locator('[role="tab"]')).toHaveCount(2);
  await expect(page.locator('.tb-badge[data-state="live"]')).toBeVisible();
  await expect(page.locator(".sw-card")).not.toHaveCount(0);
  await page.waitForTimeout(3_000);
  expect(errors).toEqual([]);
});

test("픽스처: 커서가 카드를 그리고(드래그→타이핑), 커서가 카드로 모인다", async ({ page }) => {
  const errors = trackErrors(page);
  // 카드의 built 전이를 처음부터 기록한다
  await page.addInitScript(() => {
    const log: string[] = [];
    (globalThis as unknown as { __builtLog: string[] }).__builtLog = log;
    new MutationObserver((muts) => {
      for (const m of muts) {
        const el = m.target as HTMLElement;
        if (m.attributeName === "data-built" && el.classList?.contains("sw-card")) log.push(`${el.dataset.eventId}:${el.dataset.built}`);
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-built"] });
  });
  await page.goto(URL);
  // 초기 카드 3개가 그려진다(clip-path 드래그 → built=true)
  await expect(page.locator('.sw-card[data-built="true"]')).toHaveCount(3, { timeout: 20_000 });
  // 드래그 도중 선택 박스와 크기 배지가 보였어야 한다 — built false→true 전이로 확인
  const log = await page.evaluate(() => (globalThis as unknown as { __builtLog: string[] }).__builtLog);
  expect(log.some((x) => x.endsWith(":true"))).toBe(true);
  // 제목은 다른 커서가 I-beam으로 타이핑해 채운다 — 그리기 직후엔 비어 있다가 곧 다 찬다
  await expect
    .poll(async () => (await page.locator('.sw-card[data-built="true"] .sw-title').allTextContents()).filter((t) => t.length > 0).length, { timeout: 10_000 })
    .toBe(3);

  // 커서가 카드로 모인다: 진입 이벤트마다 공전 커서 3개 이상
  await expect
    .poll(async () => {
      const s = await swarmStats(page);
      return Object.entries(s.byEvent).filter(([k, v]) => k !== "none" && v >= 3).length;
    }, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(2);

  // 몇 초 뒤 새 이벤트(#worldcupfinal)가 떠오르면 커서가 새 카드를 그린다
  const wc = page.locator(".sw-card", { has: page.locator(".sw-title", { hasText: "#worldcupfinal" }) });
  await expect(wc).toHaveAttribute("data-built", "true", { timeout: 75_000 });
  const id = await wc.getAttribute("data-event-id");
  const log2 = await page.evaluate(() => (globalThis as unknown as { __builtLog: string[] }).__builtLog);
  expect(log2).toContain(`${id}:false`); // 처음엔 안 보이다가
  expect(log2).toContain(`${id}:true`); // 커서가 다 그린 뒤 보인다
  expect(errors).toEqual([]);
});

test("픽스처: 식는 이벤트는 지나간 트렌드로 흐려지고 커서가 흩어진다", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(URL);
  const aurora = page.locator(".sw-card", { has: page.locator(".sw-title", { hasText: "#aurora" }) });
  await expect(aurora).toHaveAttribute("data-built", "true", { timeout: 20_000 });
  await expect(aurora).toHaveAttribute("data-life", "fading", { timeout: 60_000 });
  const id = (await aurora.getAttribute("data-event-id")) ?? "";
  await expect(aurora).toHaveAttribute("data-state", "past", { timeout: 200_000 });
  // 흩어짐: 몇 초 안에 그 이벤트 커서가 0
  await expect.poll(async () => (await swarmStats(page)).byEvent[id] ?? 0, { timeout: 10_000 }).toBe(0);
  // 흐리게 남는다
  const opacity = await aurora.evaluate((el) => Number(getComputedStyle(el).opacity));
  expect(opacity).toBeLessThan(0.6);
});

test("카드를 누르면 상세 서랍 — 대표 글·관련·링크", async ({ page }) => {
  await page.goto(URL);
  const jury = page.locator(".sw-card", { has: page.locator(".sw-title", { hasText: "jury verdict" }) });
  await expect(jury).toHaveAttribute("data-built", "true", { timeout: 20_000 });
  await jury.focus();
  await page.keyboard.press("Enter");
  const drawer = page.locator(".sw-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator("h2")).toHaveText("jury verdict");
  await expect(drawer.locator(".sw-drawer-link")).toHaveText(/apnews\.com\/article\/jury-verdict-trial-2026/);
  await expect(drawer.locator(".sw-drawer-posts li").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("퍼지는 글 탭 — 좋아요가 몰리는 글", async ({ page }) => {
  await page.goto(URL);
  await page.getByRole("tab", { name: "퍼지는 글" }).click();
  const first = page.locator(".sp-row").first();
  await expect(first).toBeVisible({ timeout: 20_000 });
  await expect(first.locator(".sp-text")).toContainText("city budget");
  await expect(first.locator(".sp-link")).toHaveAttribute("href", /^https:\/\/bsky\.app\/profile\/did:plc:viral0\/post\//);
});

test("reduced-motion — 커서 없이 카드만 즉시", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = trackErrors(page);
  await page.goto(URL);
  await expect(page.locator('.sw-card[data-built="true"]')).toHaveCount(3, { timeout: 15_000 });
  await expect(page.locator('.sw-card[data-built="false"]')).toHaveCount(0);
  const s = await swarmStats(page);
  expect(s.cursors).toBe(0);
  await expect(page.locator(".sw-cursor")).toHaveCount(0);
  expect(errors).toEqual([]);
  await ctx.close();
});

test("≤900px — 진단 패널 숨김, 가로 스크롤 없음", async ({ browser }) => {
  for (const width of [900, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await ctx.newPage();
    const errors = trackErrors(page);
    await page.goto(URL);
    await expect(page.locator('.sw-card[data-built="true"]').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#inspector")).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    for (const box of await page.locator(".sw-card").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))) {
      expect(box).toBeLessThanOrEqual(width);
    }
    expect(errors).toEqual([]);
    await ctx.close();
  }
});

test("메인 스레드 — 10초 동안 long task(>50ms) 0", async ({ page }) => {
  await page.goto(URL);
  await expect(page.locator('.sw-card[data-built="true"]')).toHaveCount(3, { timeout: 20_000 });
  const longTasks = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const durs: number[] = [];
        const po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) durs.push(Math.round(e.duration));
        });
        po.observe({ entryTypes: ["longtask"] });
        setTimeout(() => {
          po.disconnect();
          resolve(durs);
        }, 10_000);
      }),
  );
  console.log(`long tasks: ${JSON.stringify(longTasks)}`);
  expect(longTasks).toEqual([]);
});

test("스크린샷 1440×900", async ({ page }) => {
  await page.goto(URL);
  await expect(page.locator('.sw-card[data-built="true"]')).toHaveCount(3, { timeout: 20_000 });
  await page.waitForTimeout(6_000);
  await page.screenshot({ path: "docs/trend-engine/screens/events-1440x900.png" });
  const wc = page.locator(".sw-card", { has: page.locator(".sw-title", { hasText: "#worldcupfinal" }) });
  await expect(wc).toHaveAttribute("data-built", "true", { timeout: 75_000 });
  await page.waitForTimeout(8_000);
  await page.screenshot({ path: "docs/trend-engine/screens/events-later-1440x900.png" });
  await page.getByRole("tab", { name: "퍼지는 글" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/trend-engine/screens/spreading-1440x900.png" });
  await page.getByRole("tab", { name: "이벤트" }).click();
  await page.getByRole("button", { name: "진단" }).click();
  await page.waitForTimeout(2_500);
  await page.screenshot({ path: "docs/trend-engine/screens/inspector-1440x900.png" });
});

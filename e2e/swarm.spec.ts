import { expect, test, type Page } from "@playwright/test";

// e2e 스모크 — 전부 픽스처 스트림 모드(?fixture=news)라 네트워크 없이 돈다.
// 픽스처 시나리오(src/trend/fixtures.ts): 접속 시점에 진입한 이벤트 3개(짝·링크 뉴스·식는 #aurora),
// 몇 초 뒤 떠오르는 #worldcupfinal, 35초 뒤 東京 地震.

const URL = "/?fixture=news";

/** 커서가 다 그린 트렌드 카드 — 관찰 카드(watch)는 따로 더 생기므로 active만 센다 */
const builtTrendCards = (page: Page) => page.locator('.sw-card[data-state="active"][data-built="true"]');

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
  // 초기 트렌드 카드 3개가 그려진다(clip-path 드래그 → built=true). 관찰 카드(watch)는 따로 더 생긴다
  await expect(builtTrendCards(page)).toHaveCount(3, { timeout: 20_000 });
  // 드래그 도중 선택 박스와 크기 배지가 보였어야 한다 — built false→true 전이로 확인
  const log = await page.evaluate(() => (globalThis as unknown as { __builtLog: string[] }).__builtLog);
  expect(log.some((x) => x.endsWith(":true"))).toBe(true);
  // 제목은 다른 커서가 I-beam으로 타이핑해 채운다 — 그리기 직후엔 비어 있다가 곧 다 찬다
  await expect
    .poll(async () => (await builtTrendCards(page).locator(".sw-title").allTextContents()).filter((t) => t.length > 0).length, { timeout: 10_000 })
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

test("픽스처: 식는 이벤트는 지나간 트렌드로 물러나고(회색) 커서가 흩어진다", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(URL);
  const aurora = page.locator(".sw-card", { has: page.locator(".sw-title", { hasText: "#aurora" }) });
  await expect(aurora).toHaveAttribute("data-built", "true", { timeout: 20_000 });
  await expect(aurora).toHaveAttribute("data-life", "fading", { timeout: 60_000 });
  const id = (await aurora.getAttribute("data-event-id")) ?? "";
  await expect(aurora).toHaveAttribute("data-state", "past", { timeout: 200_000 });
  // 흩어짐: 몇 초 안에 그 이벤트 커서가 0
  await expect.poll(async () => (await swarmStats(page)).byEvent[id] ?? 0, { timeout: 10_000 }).toBe(0);
  // 회색으로 남는다 — 디자인 개편 뒤 지나간 카드는 투명도 대신 --ink-3 색으로 물러난다
  const colors = await aurora.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--ink-3)";
    el.appendChild(probe);
    const ink3 = getComputedStyle(probe).color;
    probe.remove();
    const frame = el.querySelector(".sw-frame");
    return { ink3, frame: frame === null ? null : getComputedStyle(frame).color };
  });
  expect(colors.frame).toBe(colors.ink3);
});

test("리포스트 도달 — 카드에 ↻ 리포스터 표시, 크게 퍼지는 #worldcupfinal은 강조, 콘솔 에러 0", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(URL);
  await expect(page.locator(".sw-card .sw-reach").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".sw-card .sw-reach").first()).toContainText("↻");
  // 분당 160 리포스트가 붙는 #worldcupfinal — amp ≥ 3이면 강조
  await expect(page.locator('.sw-card .sw-reach[data-hot="true"]').first()).toBeVisible({ timeout: 60_000 });
  // ↻ 링이 실제로 뜬다(웹 애니메이션이 붙은 링)
  await expect
    .poll(async () => page.evaluate(() => [...document.querySelectorAll(".sw-reach-ring")].some((el) => el.getAnimations().length > 0)), { timeout: 30_000 })
    .toBe(true);
  expect(errors).toEqual([]);
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

test("상세 서랍 포커스 — 열면 닫기 버튼, 닫으면 카드로 돌아온다", async ({ page }) => {
  await page.goto(URL);
  const jury = page.locator(".sw-card", { has: page.locator(".sw-title", { hasText: "jury verdict" }) });
  await expect(jury).toHaveAttribute("data-built", "true", { timeout: 20_000 });
  await jury.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: /jury verdict/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(jury).toBeFocused();
});

test("탭 — 화살표로 이동, 카드 탭이 아니면 스웜 커서 레이어를 감추고 돌아오면 다시 보인다", async ({ page }) => {
  await page.goto(URL);
  await expect(builtTrendCards(page).first()).toBeVisible({ timeout: 20_000 });
  const layer = page.locator(".sw-layer");
  await expect(layer).toBeVisible();
  await page.getByRole("tab", { name: "Trend cards" }).focus();
  await page.keyboard.press("ArrowRight");
  const hot = page.getByRole("tab", { name: "Hot posts" });
  await expect(hot).toBeFocused();
  await expect(hot).toHaveAttribute("aria-selected", "true");
  await expect(layer).toBeHidden();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Trend cards" })).toHaveAttribute("aria-selected", "true");
  await expect(layer).toBeVisible();
});

test("퍼지는 글 탭 — 좋아요가 몰리는 글", async ({ page }) => {
  await page.goto(URL);
  await page.getByRole("tab", { name: "Hot posts" }).click();
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
  await expect(builtTrendCards(page)).toHaveCount(3, { timeout: 15_000 });
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
  await expect(builtTrendCards(page)).toHaveCount(3, { timeout: 20_000 });
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
  await expect(builtTrendCards(page)).toHaveCount(3, { timeout: 20_000 });
  await page.waitForTimeout(6_000);
  await page.screenshot({ path: "docs/trend-engine/screens/events-1440x900.png" });
  const wc = page.locator(".sw-card", { has: page.locator(".sw-title", { hasText: "#worldcupfinal" }) });
  await expect(wc).toHaveAttribute("data-built", "true", { timeout: 75_000 });
  await page.waitForTimeout(8_000);
  await page.screenshot({ path: "docs/trend-engine/screens/events-later-1440x900.png" });
  await page.getByRole("tab", { name: "Hot posts" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/trend-engine/screens/spreading-1440x900.png" });
  await page.getByRole("tab", { name: "Trend cards" }).click();
  await page.getByRole("button", { name: "Diagnostics" }).click();
  await page.waitForTimeout(2_500);
  await page.screenshot({ path: "docs/trend-engine/screens/inspector-1440x900.png" });
});

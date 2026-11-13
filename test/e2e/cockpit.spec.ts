/**
 * DSH Cockpit E2E：5 条主路径（真实 Chromium + 合成数据 + 隔离 DSH_HOME）。
 *
 * 选择器优先使用前端提供的 data-testid 稳定钩子，其次回退到语义 id。
 * 服务由 playwright.config.ts 的 webServer 启动（端口 7811，隔离 DSH_HOME/DSH_COCKPIT_HOME）。
 *
 * 纯 Node 替代（无浏览器）：node test/e2e/smoke.node.mjs
 */
import { expect, test, type Page } from "@playwright/test";

/** 打开仪表盘并等待首屏数据加载完成（footer 的健康行不再是占位符）。 */
async function openDashboard(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("range-bar")).toBeVisible();
  await expect(page.locator("#ring-quota")).toBeVisible();
  await expect(page.locator("#health-line")).not.toHaveText("—", { timeout: 25_000 });
}

/** 收集页面级错误（过滤 favicon / 资源 404 这类非业务噪音）。 */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/favicon|Failed to load resource/i.test(text)) return;
    errors.push(`console.error: ${text}`);
  });
  return errors;
}

test.describe("DSH 驾驶舱 5 条主路径", () => {
  test("1) 首屏渲染：范围条、双环、任务区可见且无页面错误", async ({ page }) => {
    const errors = collectPageErrors(page);
    await openDashboard(page);

    await expect(page.locator("h1")).toContainText("驾驶舱");
    await expect(page.getByTestId("range-bar")).toBeVisible();
    await expect(page.locator("#ring-quota")).toBeVisible();
    await expect(page.locator("#ring-ctx")).toBeVisible();
    await expect(page.getByTestId("tasks-table")).toBeVisible();
    await expect(page.locator("#receipt-btn")).toBeVisible();
    await expect(page.locator("#settings-btn")).toBeVisible();

    const cardCount = await page.locator("main .card").count();
    expect(cardCount).toBeGreaterThanOrEqual(8);

    // 首屏数据已渲染：健康行、任务计数不再是占位符
    await expect(page.locator("#health-line")).toContainText(/会话/);
    await expect(page.locator("#tasks-count")).not.toHaveText("—");

    expect(errors, `页面不应有未捕获异常或 console.error：\n${errors.join("\n")}`).toEqual([]);
  });

  test("2) 范围切换：30 天/7 天切换、请求携带 range、刷新后保持", async ({ page }) => {
    await openDashboard(page);
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/") && /[?&]range=/.test(request.url())) requests.push(request.url());
    });

    const button30 = page.getByTestId("range-bar").locator('[data-range="30d"]');
    await button30.click();
    await expect(button30).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => requests.some((url) => url.includes("range=30d")), { timeout: 15_000 }).toBe(true);

    // 刷新保持（URL hash 联动契约）
    await page.reload();
    await expect(page.getByTestId("range-bar")).toBeVisible();
    await expect(page.getByTestId("range-bar").locator('[data-range="30d"]')).toHaveAttribute("aria-pressed", "true");

    await page.getByTestId("range-bar").locator('[data-range="7d"]').click();
    await expect(page.getByTestId("range-bar").locator('[data-range="7d"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("range-bar").locator('[data-range="30d"]')).toHaveAttribute("aria-pressed", "false");
  });

  test("3) 任务表：搜索过滤与排序切换", async ({ page }) => {
    await openDashboard(page);
    const table = page.getByTestId("tasks-table");
    const rows = table.locator("tbody tr");
    await expect.poll(() => rows.count(), { timeout: 20_000 }).toBeGreaterThan(0);
    const totalBefore = await rows.count();
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/tasks")) requests.push(request.url());
    });

    // 搜索：种子标题包含「Alpha」的任务，过滤后行数下降且内容命中
    await page.getByTestId("task-search").fill("Alpha");
    await expect
      .poll(
        async () => {
          const count = await rows.count();
          const text = (await table.innerText()).replace(/\s+/g, " ");
          return count > 0 && count <= totalBefore && text.includes("Alpha");
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    // 排序：点击费用列 → 请求带 sort=cost 或表头 aria-sort 变化或首行顺序变化
    await page.getByTestId("task-search").fill("");
    await expect.poll(() => rows.count(), { timeout: 15_000 }).toBe(totalBefore);
    const firstBefore = (await rows.first().innerText()).trim();
    await page.locator('button[data-sort="cost"]').click();
    await expect
      .poll(
        async () => {
          const costHeader = page.locator('th:has(button[data-sort="cost"])');
          const ariaSort = await costHeader.getAttribute("aria-sort");
          const sortedRequest = requests.some((url) => /[?&]sort=cost/.test(url));
          const firstAfter = (await rows.first().innerText()).trim();
          return sortedRequest || ariaSort === "ascending" || ariaSort === "descending" || firstAfter !== firstBefore;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  });

  test("4) 小票生成：调用 /api/receipt 并得到小票数据", async ({ page }) => {
    await openDashboard(page);
    const button = page.getByTestId("receipt-generate");
    await expect(button).toBeVisible();
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("/api/receipt"),
      { timeout: 20_000 },
    );
    const downloadPromise = page.waitForEvent("download", { timeout: 10_000 }).catch(() => null);
    await button.click();
    const response = await responsePromise;
    expect(response.ok(), `POST/GET /api/receipt 应成功（实际 ${response.status()}）`).toBeTruthy();
    const receipt = await response.json();
    expect(receipt).toHaveProperty("lines");
    expect(Array.isArray(receipt.lines)).toBeTruthy();
    expect(typeof receipt.totalTokens).toBe("number");
    expect(receipt).toHaveProperty("generatedAt");

    const download = await downloadPromise;
    if (download) {
      expect(download.suggestedFilename()).toMatch(/\.png$/i);
    } else {
      test.info().annotations.push({
        type: "note",
        description: "未触发下载事件（可能走剪贴板降级或 headless 限制），已用 /api/receipt 响应兜底断言",
      });
    }
  });

  test("5) 设置保存：修改 Token 预算并持久化", async ({ page }) => {
    await openDashboard(page);
    await page.locator("#settings-btn").click();
    const drawer = page.locator("#drawer");
    await expect(drawer).toBeVisible();
    const input = page.locator("#cfg-tokens");
    await expect(input).toBeVisible();

    const next = "4321000";
    await input.fill(next);
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("/api/config") && response.request().method() === "POST",
      { timeout: 20_000 },
    );
    await page.getByTestId("settings-save").click();
    const response = await responsePromise;
    expect(response.ok(), `POST /api/config 应成功（实际 ${response.status()}）`).toBeTruthy();

    await page.reload();
    await page.locator("#settings-btn").click();
    await expect(page.locator("#cfg-tokens")).toHaveValue(next);
  });

  test("6) 成员 Tab：同步未开启时显示空态提示（不报错）", async ({ page }) => {
    const errors = collectPageErrors(page);
    await openDashboard(page);
    await expect(page.getByTestId("tab-members")).toBeVisible();
    await page.getByTestId("tab-members").click();
    await expect(page.locator("#panel-members")).toBeVisible();
    await expect(page.locator("#members-body")).toContainText(/同步未开启|Sync disabled/i);
    await expect(page.locator("#team-plan")).toHaveText("—");
    expect(errors, errors.join("\n")).toEqual([]);
  });
});

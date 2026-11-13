# E2E（Playwright + 纯 Node 冒烟）

5 条主路径：首屏渲染、范围切换、任务表搜索排序、小票生成、设置保存。

## 运行方式

```bash
# 一次性安装（不写入 package.json / 不生成 lockfile）
npm i --no-save --no-package-lock @playwright/test
npx playwright install chromium

# 5 条主路径（webServer 自动启动 node src/cli.mjs serve --port 7811）
npx playwright test

# 无浏览器替代（纯 Node fetch，可进 CI 手动 job）
node test/e2e/smoke.node.mjs
```

- 配置：根目录 `playwright.config.ts`；`webServer.command` = `node test/e2e/seed.mjs && node src/cli.mjs serve --port 7811`。
- 隔离：`DSH_HOME` / `DSH_COCKPIT_HOME` 指向系统临时目录 `<tmp>/dsh-cockpit-e2e/`，**绝不写真实 `~/.dsh`**；
  `test/e2e/seed.mjs` 每次启动重建 10 个跨 45 天的合成会话。
- 产物：`.cockpit-e2e/`（已被 `.gitignore` 的 `.cockpit-*` 规则覆盖；失败时含 trace/screenshot）。
- 端口：7811；如被占用，设置 `E2E_PORT` 同时改 `playwright.config.ts` 内 `webServer.command` 端口。

## 与 `node --test` 的关系

Node 内置测试运行器会把 `test/**` 下所有 `.mjs` 当作测试文件执行，Playwright spec（`.ts`）和本目录冒烟不适用。
因此仓库测试命令固定为：

```bash
node --test "test/*.test.mjs"
```

不要用裸 `node --test`（会误把本目录当测试）。`scripts/coverage.mjs` 已按该 glob 调用。

## 约定

- 选择器优先用前端稳定钩子：`data-testid`（range-bar / task-search / tasks-table / receipt-generate / settings-save）；
- 只断言用户可见行为与 API 契约，不依赖内部实现细节；
- 不打印/提交真实会话 id、标题、路径、金额；所有数据来自 `seed.mjs`。
